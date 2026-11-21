use clap::Args;

#[derive(Args, Debug, Clone)]
pub struct Config {
    #[arg(long, env = "DATABASE_URL")]
    pub database_url: String,

    #[arg(long, env = "BIND_ADDR", default_value = "0.0.0.0:8080")]
    pub bind_addr: String,

    /// Public origin(s) of the site, comma separated, e.g. https://kanban.example.com.
    /// Mutating requests whose Origin header is not listed are rejected (CSRF protection).
    #[arg(long, env = "PUBLIC_ORIGIN", default_value = "http://localhost:5173")]
    pub public_origin: String,

    /// Mark the session cookie `Secure` (set true when served over HTTPS).
    #[arg(long, env = "COOKIE_SECURE", default_value_t = false)]
    pub cookie_secure: bool,

    #[arg(long, env = "SESSION_DAYS", default_value_t = 30)]
    pub session_days: i64,

    /// Directory with the built frontend (served as SPA). Empty = API only.
    #[arg(long, env = "STATIC_DIR", default_value = "")]
    pub static_dir: String,

    #[arg(long, env = "S3_ENDPOINT", default_value = "http://127.0.0.1:58333")]
    pub s3_endpoint: String,
    #[arg(long, env = "S3_BUCKET", default_value = "kanban")]
    pub s3_bucket: String,
    #[arg(long, env = "S3_ACCESS_KEY", default_value = "devaccesskey")]
    pub s3_access_key: String,
    #[arg(long, env = "S3_SECRET_KEY", default_value = "devsecretkey", hide_env_values = true)]
    pub s3_secret_key: String,
    #[arg(long, env = "S3_REGION", default_value = "us-east-1")]
    pub s3_region: String,

    /// Development/testing only: deliver ALL email to this plain-SMTP host:port (e.g. Mailpit at 127.0.0.1:51025)
    /// instead of the SMTP server configured in the app, so tests can never email real people.
    #[arg(long, env = "MAIL_REDIRECT")]
    pub mail_redirect: Option<String>,

    /// Development/testing only: send ALL contact-point requests (Discord, Slack, …) to this base URL instead,
    /// keeping the path; the real target goes in an `X-Original-Url` header.
    #[arg(long, env = "WEBHOOK_REDIRECT")]
    pub webhook_redirect: Option<String>,

    #[arg(long, env = "MAX_UPLOAD_MB", default_value_t = 50)]
    pub max_upload_mb: usize,
}

impl Config {
    pub fn origins(&self) -> Vec<String> {
        self.public_origin
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }
}
