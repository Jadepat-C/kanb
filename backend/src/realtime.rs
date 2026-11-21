//! Realtime board updates: every mutation publishes `(board_id, kind)`; browsers viewing the board
//! receive it over a WebSocket and refetch. Single-instance app, so an in-process channel is enough.

use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use serde::Serialize;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{AppState, auth::CurrentUser, error::AppResult, perms::board_access};

#[derive(Debug, Clone, Serialize)]
pub struct BoardEvent {
    pub board_id: Uuid,
    pub kind: &'static str,
    pub card_id: Option<Uuid>,
    pub actor_id: Uuid,
}

#[derive(Clone)]
pub struct Hub(broadcast::Sender<BoardEvent>);

impl Hub {
    pub fn new() -> Self {
        Hub(broadcast::channel(256).0)
    }
    pub fn notify(&self, board_id: Uuid, kind: &'static str, card_id: Option<Uuid>, actor_id: Uuid) {
        let _ = self.0.send(BoardEvent { board_id, kind, card_id, actor_id });
    }
}

pub async fn board_ws(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(board_id): Path<Uuid>,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    board_access(&state.db, &user, board_id).await?;
    let rx = state.hub.0.subscribe();
    Ok(ws.on_upgrade(move |socket| pump(socket, rx, board_id)))
}

async fn pump(mut socket: WebSocket, mut rx: broadcast::Receiver<BoardEvent>, board_id: Uuid) {
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(ev) if ev.board_id == board_id => {
                    let text = serde_json::to_string(&ev).unwrap_or_default();
                    if socket.send(Message::Text(text.into())).await.is_err() { break; }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let msg = format!(r#"{{"board_id":"{board_id}","kind":"resync"}}"#);
                    if socket.send(Message::Text(msg.into())).await.is_err() { break; }
                }
                Err(_) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
}
