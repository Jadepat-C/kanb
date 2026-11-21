//! Encryption at rest for secrets kept in the database: the SMTP password, contact-point webhook URLs and tokens,
//! and authenticator (TOTP) secrets. AES-256-GCM with a key from SECRET_KEY (64 hex characters; `kanban gen-key`).
//! Stored as "enc:v1:<hex nonce+ciphertext>". Without a key, values stay readable as before (with a warning).

use std::sync::OnceLock;

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};

const PREFIX: &str = "enc:v1:";
static KEY: OnceLock<Option<Aes256Gcm>> = OnceLock::new();

pub fn init(hex_key: Option<&str>) -> anyhow::Result<()> {
    let cipher = match hex_key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => {
            let bytes = hex::decode(k).map_err(|_| anyhow::anyhow!("SECRET_KEY must be 64 hex characters (run `kanban gen-key`)"))?;
            anyhow::ensure!(bytes.len() == 32, "SECRET_KEY must be 64 hex characters (run `kanban gen-key`)");
            Some(Aes256Gcm::new_from_slice(&bytes).map_err(|_| anyhow::anyhow!("bad SECRET_KEY"))?)
        }
        None => {
            tracing::warn!("SECRET_KEY is not set: SMTP password, webhook secrets and 2FA secrets are stored unencrypted");
            None
        }
    };
    let _ = KEY.set(cipher);
    Ok(())
}

pub fn enabled() -> bool {
    KEY.get().is_some_and(|k| k.is_some())
}

pub fn new_key() -> String {
    let mut k = [0u8; 32];
    getrandom::fill(&mut k).expect("os rng");
    hex::encode(k)
}

pub fn is_sealed(v: &str) -> bool {
    v.starts_with(PREFIX)
}

/// Encrypts (no-op without a key, for empty values, or if already encrypted).
pub fn seal(plain: &str) -> String {
    let Some(Some(c)) = KEY.get() else { return plain.to_string() };
    if plain.is_empty() || is_sealed(plain) {
        return plain.to_string();
    }
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).expect("os rng");
    let ct = c.encrypt(&Nonce::from(nonce), plain.as_bytes()).expect("aes-gcm encrypt");
    format!("{PREFIX}{}{}", hex::encode(nonce), hex::encode(ct))
}

/// Decrypts a stored value; plain (old) values come back unchanged.
pub fn open(stored: &str) -> anyhow::Result<String> {
    let Some(hexed) = stored.strip_prefix(PREFIX) else { return Ok(stored.to_string()) };
    let Some(Some(c)) = KEY.get() else { anyhow::bail!("an encrypted secret needs SECRET_KEY") };
    let raw = hex::decode(hexed)?;
    anyhow::ensure!(raw.len() > 12, "bad encrypted value");
    let nonce: [u8; 12] = raw[..12].try_into()?;
    let pt = c.decrypt(&Nonce::from(nonce), &raw[12..]).map_err(|_| anyhow::anyhow!("can't decrypt a secret: wrong SECRET_KEY?"))?;
    Ok(String::from_utf8(pt)?)
}

/// One-time pass at startup: encrypt secrets that were saved before a key was configured.
pub async fn seal_existing(db: &sqlx::PgPool) -> anyhow::Result<()> {
    if !enabled() {
        return Ok(());
    }
    let mut n = 0;
    // SMTP password
    let row: Option<(serde_json::Value,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = 'smtp'").fetch_optional(db).await?;
    if let Some((mut v,)) = row
        && let Some(pw) = v.get("password").and_then(|p| p.as_str()).map(str::to_string)
        && !pw.is_empty()
        && !is_sealed(&pw)
    {
        v["password"] = seal(&pw).into();
        sqlx::query("UPDATE app_settings SET value = $1 WHERE key = 'smtp'").bind(v).execute(db).await?;
        n += 1;
    }
    // authenticator secrets
    let rows: Vec<(uuid::Uuid, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT id, totp_secret, totp_pending_secret FROM users WHERE totp_secret IS NOT NULL OR totp_pending_secret IS NOT NULL").fetch_all(db).await?;
    for (id, s, p) in rows {
        if s.as_deref().is_some_and(|x| !is_sealed(x)) || p.as_deref().is_some_and(|x| !is_sealed(x)) {
            sqlx::query("UPDATE users SET totp_secret = $2, totp_pending_secret = $3 WHERE id = $1")
                .bind(id)
                .bind(s.map(|x| seal(&x)))
                .bind(p.map(|x| seal(&x)))
                .execute(db)
                .await?;
            n += 1;
        }
    }
    // contact points (personal and board)
    for table in ["contact_points", "board_contact_points"] {
        let rows: Vec<(uuid::Uuid, String, serde_json::Value)> = sqlx::query_as(sqlf!("SELECT id, kind, config FROM {table}")).fetch_all(db).await?;
        for (id, kind, cfg) in rows {
            let map = cfg.as_object().cloned().unwrap_or_default();
            let sealed = crate::contacts::seal_cfg(&kind, map.clone());
            if sealed != map {
                sqlx::query(sqlf!("UPDATE {table} SET config = $2 WHERE id = $1")).bind(id).bind(serde_json::Value::Object(sealed)).execute(db).await?;
                n += 1;
            }
        }
    }
    if n > 0 {
        tracing::info!(count = n, "encrypted previously stored secrets");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip() {
        super::init(Some(&super::new_key())).unwrap();
        let s = super::seal("https://discord.com/api/webhooks/1/abc");
        assert!(s.starts_with("enc:v1:") && !s.contains("discord"));
        assert_eq!(super::open(&s).unwrap(), "https://discord.com/api/webhooks/1/abc");
        assert_ne!(super::seal("x"), super::seal("x")); // fresh nonce each time
        assert_eq!(super::open("plain old value").unwrap(), "plain old value");
        assert_eq!(super::seal(&s), s); // never double-encrypted
    }
}
