//! Realtime per board over one WebSocket:
//! - `change`: something changed (the browser refetches); carries the actor so others can be told who did it.
//! - `presence`: who is looking at the board right now, which card they have open and whether they're editing.
//! Single-instance app, so in-process state + a broadcast channel are enough.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{CurrentUser, User},
    error::AppResult,
    perms::board_access,
};

#[derive(Debug, Clone, Serialize)]
pub struct Viewer {
    pub conn: Uuid,
    pub user_id: Uuid,
    pub display_name: String,
    pub username: String,
    pub avatar_color: String,
    pub avatar_id: Option<Uuid>,
    pub card_id: Option<Uuid>,
    pub editing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Out {
    Change { board_id: Uuid, kind: &'static str, card_id: Option<Uuid>, actor_id: Uuid },
    Presence { board_id: Uuid, viewers: Vec<Viewer> },
    /// "you have a new notification" (sent on the per-user socket only)
    Notify { user_id: Uuid },
}

impl Out {
    fn board(&self) -> Option<Uuid> {
        match self {
            Out::Change { board_id, .. } | Out::Presence { board_id, .. } => Some(*board_id),
            Out::Notify { .. } => None,
        }
    }
}

/// What a browser may send: where it is and whether it's typing.
#[derive(Deserialize)]
struct In {
    card_id: Option<Uuid>,
    #[serde(default)]
    editing: bool,
}

type Presence = Arc<Mutex<HashMap<Uuid, HashMap<Uuid, Viewer>>>>;

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<Out>,
    presence: Presence,
}

impl Hub {
    pub fn new() -> Self {
        Hub { tx: broadcast::channel(512).0, presence: Arc::default() }
    }

    pub fn notify_user(&self, user_id: Uuid) {
        let _ = self.tx.send(Out::Notify { user_id });
    }

    pub fn notify(&self, board_id: Uuid, kind: &'static str, card_id: Option<Uuid>, actor_id: Uuid) {
        let _ = self.tx.send(Out::Change { board_id, kind, card_id, actor_id });
    }

    fn publish_presence(&self, board_id: Uuid) {
        let viewers: Vec<Viewer> = {
            let p = self.presence.lock().unwrap();
            p.get(&board_id).map(|m| m.values().cloned().collect()).unwrap_or_default()
        };
        let _ = self.tx.send(Out::Presence { board_id, viewers });
    }

    fn set(&self, board_id: Uuid, v: Viewer) {
        self.presence.lock().unwrap().entry(board_id).or_default().insert(v.conn, v);
        self.publish_presence(board_id);
    }

    fn remove(&self, board_id: Uuid, conn: Uuid) {
        {
            let mut p = self.presence.lock().unwrap();
            if let Some(m) = p.get_mut(&board_id) {
                m.remove(&conn);
                if m.is_empty() {
                    p.remove(&board_id);
                }
            }
        }
        self.publish_presence(board_id);
    }
}

pub async fn board_ws(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(board_id): Path<Uuid>,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    board_access(&state.db, &user, board_id).await?;
    let hub = state.hub.clone();
    Ok(ws.on_upgrade(move |socket| pump(socket, hub, board_id, user)))
}

async fn pump(mut socket: WebSocket, hub: Hub, board_id: Uuid, user: User) {
    let _open = crate::metrics::Socket::open("board");
    let mut rx = hub.tx.subscribe();
    let conn = Uuid::new_v4();
    let mut me = Viewer {
        conn,
        user_id: user.id,
        display_name: user.display_name.clone(),
        username: user.username.clone(),
        avatar_color: user.avatar_color.clone(),
        avatar_id: user.avatar_id,
        card_id: None,
        editing: false,
    };
    hub.set(board_id, me.clone());
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(ev) if ev.board() == Some(board_id) => {
                    let text = serde_json::to_string(&ev).unwrap_or_default();
                    if socket.send(Message::Text(text.into())).await.is_err() { break; }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let msg = format!(r#"{{"type":"change","board_id":"{board_id}","kind":"resync","card_id":null,"actor_id":null}}"#);
                    if socket.send(Message::Text(msg.into())).await.is_err() { break; }
                }
                Err(_) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(t))) => {
                    if let Ok(i) = serde_json::from_str::<In>(&t)
                        && (i.card_id != me.card_id || i.editing != me.editing)
                    {
                        me.card_id = i.card_id;
                        me.editing = i.editing && i.card_id.is_some();
                        hub.set(board_id, me.clone());
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
    hub.remove(board_id, conn);
}

/// Per-user socket: pushes a ping whenever the user gets a notification (the browser then refetches).
pub async fn user_ws(State(state): State<AppState>, CurrentUser(user): CurrentUser, ws: WebSocketUpgrade) -> Response {
    let mut rx = state.hub.tx.subscribe();
    ws.on_upgrade(move |mut socket| async move {
        let _open = crate::metrics::Socket::open("user");
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Ok(Out::Notify { user_id }) if user_id == user.id => {
                        if socket.send(Message::Text(r#"{"type":"notify"}"#.into())).await.is_err() { break; }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => break,
                },
                msg = socket.recv() => match msg {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
            }
        }
    })
}
