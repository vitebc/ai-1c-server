//! Auth for the HTTP API: human users (login/password + JWT + RBAC)
//! and machine clients (legacy shared Bearer token).
//!
//! * Users live in the `users` table (argon2 password hash, role,
//!   optional per-section overrides). First boot with an empty table
//!   creates `admin` with a random password printed to the log **once**.
//! * `POST /api/admin/auth/login {username,password,remember?}` → JWT
//!   (12h, or 7d with `remember: true`). Secret in
//!   `server_settings(jwt_secret)`, generated on boot.
//! * Every `/api/*` (except `/health` and `/auth/login`) requires
//!   `Authorization: Bearer <jwt|api_token>` when `auth_required` is set.
//!   Legacy `api_token` keeps working (machine MCP clients) with full access.
//! * RBAC: request path → section (`section_for`), JWT identity must include
//!   the section; `viewer` is GET-only (except own password change).
//! * Login brute-force: >5 fails per IP in 10 min → 429 for 5 min.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::OsRng;
use axum::{
    extract::{ConnectInfo, Extension, State},
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::api::AppState;
use crate::db::Database;

// ─── legacy shared token (machine clients) ──────────────────────────

const HASH_KEY: &str = "api_token_hash";
const TOKEN_KEY: &str = "api_token";

fn hash_token(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    format!("{:x}", h.finalize())
}

/// Auth is opt-in: required only when `server_settings(auth_required)`
/// is set to a truthy value. Absent (fresh installs) = open API.
pub fn is_auth_required(db: &Database) -> bool {
    let val: Result<String, _> = db.conn.query_row(
        "SELECT value FROM server_settings WHERE key = 'auth_required'",
        [],
        |row| row.get(0),
    );
    match val {
        Ok(v) => !matches!(
            v.trim().to_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        ),
        Err(_) => false,
    }
}

fn new_token() -> String {
    format!("ai1c_{}", uuid::Uuid::new_v4().simple())
}

fn get_setting(db: &Database, key: &str) -> Option<String> {
    db.conn
        .query_row(
            "SELECT value FROM server_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .ok()
}

/// Ensure a token exists. Returns `Some(plaintext)` only when newly generated.
pub fn ensure_token(db: &Database) -> Result<Option<String>, Box<dyn std::error::Error>> {
    if get_setting(db, TOKEN_KEY).is_some() || get_setting(db, HASH_KEY).is_some() {
        return Ok(None);
    }
    let token = new_token();
    db.conn.execute(
        "INSERT INTO server_settings (key, value) VALUES (?1, ?2), (?3, ?4)",
        rusqlite::params![TOKEN_KEY, token, HASH_KEY, hash_token(&token)],
    )?;
    Ok(Some(token))
}

/// Current plaintext token, if stored (legacy installs: None until rotate).
pub fn current_token(db: &Database) -> Option<String> {
    get_setting(db, TOKEN_KEY).filter(|s| !s.trim().is_empty())
}

pub fn verify_token(db: &Database, bearer: &str) -> bool {
    if let Some(t) = current_token(db) {
        if t == bearer {
            return true;
        }
    }
    // Legacy hash fallback.
    match get_setting(db, HASH_KEY) {
        Some(h) => h == hash_token(bearer),
        None => false,
    }
}

/// Generate a replacement token, store it (plaintext + hash), return plaintext.
pub fn rotate(db: &Database) -> Result<String, Box<dyn std::error::Error>> {
    let token = new_token();
    db.conn.execute(
        "INSERT INTO server_settings (key, value) VALUES (?1, ?2), (?3, ?4)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![TOKEN_KEY, token, HASH_KEY, hash_token(&token)],
    )?;
    Ok(token)
}

// ─── users ──────────────────────────────────────────────────────────

pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_OPERATOR: &str = "operator";
pub const ROLE_VIEWER: &str = "viewer";

/// All sections known to the RBAC matrix (== admin UI areas + sensitive APIs).
pub const SECTIONS: &[&str] = &[
    "dashboard",
    "mcp-servers",
    "agent-studio",
    "skills",
    "bsl-ls",
    "configs",
    "client-versions",
    "clients",
    "logs",
    "settings",
    "fs",
    "env",
    "users",
    "auth-manage",
];

fn base_sections(role: &str) -> Vec<String> {
    match role {
        ROLE_ADMIN => SECTIONS.iter().map(|s| s.to_string()).collect(),
        ROLE_OPERATOR => [
            "dashboard",
            "mcp-servers",
            "agent-studio",
            "skills",
            "bsl-ls",
            "configs",
            "client-versions",
            "clients",
            "logs",
            "settings",
            "fs",
            "env",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        _ => [
            "dashboard",
            "mcp-servers",
            "agent-studio",
            "skills",
            "bsl-ls",
            "configs",
            "client-versions",
            "clients",
            "logs",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
    }
}

/// Effective sections = role base with per-user JSON overrides applied
/// (`{"agent-studio": false}` removes, `{"logs": true}` grants).
pub fn effective_sections(role: &str, overrides: Option<&str>) -> Vec<String> {
    let mut set: std::collections::HashSet<String> = base_sections(role).into_iter().collect();
    if let Some(raw) = overrides {
        if let Ok(map) = serde_json::from_str::<HashMap<String, bool>>(raw) {
            for (k, v) in map {
                if !SECTIONS.contains(&k.as_str()) {
                    continue;
                }
                if v {
                    set.insert(k);
                } else {
                    set.remove(&k);
                }
            }
        }
    }
    let mut out: Vec<String> = set.into_iter().collect();
    out.sort();
    out
}

#[derive(Debug, Clone)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub role: String,
    pub sections: Option<String>,
    pub enabled: bool,
}

pub fn is_valid_username(name: &str) -> bool {
    let n = name.trim();
    (3..=32).contains(&n.len())
        && n.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_.-".contains(c))
}

pub fn hash_password(pw: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("hash: {e}"))
}

pub fn verify_password(hash: &str, pw: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(p) => p,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(pw.as_bytes(), &parsed)
        .is_ok()
}

/// Friendly random password (hex, no ambiguous chars issues — server-side only).
pub fn random_password() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..20].to_string()
}

pub fn find_user(db: &Database, username: &str) -> Option<(UserRow, String)> {
    db.conn
        .query_row(
            "SELECT id, username, password_hash, role, sections, enabled FROM users WHERE username = ?1",
            [username.trim()],
            |row| {
                Ok((
                    UserRow {
                        id: row.get(0)?,
                        username: row.get(1)?,
                        role: row.get(3)?,
                        sections: row.get(4)?,
                        enabled: row.get::<_, i32>(5)? != 0,
                    },
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .ok()
}

pub fn find_user_by_id(db: &Database, id: &str) -> Option<UserRow> {
    db.conn
        .query_row(
            "SELECT id, username, role, sections, enabled FROM users WHERE id = ?1",
            [id],
            |row| {
                Ok(UserRow {
                    id: row.get(0)?,
                    username: row.get(1)?,
                    role: row.get(2)?,
                    sections: row.get(3)?,
                    enabled: row.get::<_, i32>(4)? != 0,
                })
            },
        )
        .ok()
}

/// Bootstrap: create `admin` with a random password if the table is empty.
/// Returns the plaintext password only when created.
pub fn ensure_admin(db: &Database) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let count: i64 = db
        .conn
        .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(None);
    }
    let password = random_password();
    let hash = hash_password(&password).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
    db.conn.execute(
        "INSERT INTO users (id, username, password_hash, role) VALUES (?1, 'admin', ?2, 'admin')",
        rusqlite::params![uuid::Uuid::new_v4().to_string(), hash],
    )?;
    Ok(Some(password))
}

// ─── JWT ───

const JWT_TTL_SECS: u64 = 12 * 3600;
const JWT_TTL_REMEMBER_SECS: u64 = 7 * 24 * 3600;

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    username: String,
    exp: usize,
}

fn jwt_secret(db: &Database) -> Result<String, Box<dyn std::error::Error>> {
    if let Some(s) = get_setting(db, "jwt_secret") {
        if !s.trim().is_empty() {
            return Ok(s);
        }
    }
    let secret = uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
    db.conn.execute(
        "INSERT INTO server_settings (key, value) VALUES ('jwt_secret', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&secret],
    )?;
    Ok(secret)
}

pub fn ensure_jwt_secret(db: &Database) -> Result<(), Box<dyn std::error::Error>> {
    jwt_secret(db).map(|_| ())
}

fn issue_jwt(db: &Database, user: &UserRow, remember: bool) -> Result<String, String> {
    let secret = jwt_secret(db).map_err(|e| e.to_string())?;
    let ttl = if remember {
        JWT_TTL_REMEMBER_SECS
    } else {
        JWT_TTL_SECS
    };
    let exp = (chrono::Utc::now().timestamp() as u64) + ttl;
    jsonwebtoken::encode(
        &Header::default(),
        &Claims {
            sub: user.id.clone(),
            username: user.username.clone(),
            exp: exp as usize,
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("jwt: {e}"))
}

fn decode_jwt(db: &Database, token: &str) -> Option<UserRow> {
    let secret = jwt_secret(db).ok()?;
    let data = jsonwebtoken::decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .ok()?;
    let user = find_user_by_id(db, &data.claims.sub)?;
    if !user.enabled || user.username != data.claims.username {
        return None;
    }
    Some(user)
}

// ─── identity + section mapping ─────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AuthIdentity {
    pub user_id: String,
    pub username: String,
    pub role: String,
    pub sections: Vec<String>,
    /// Legacy shared token (machine client): bypasses section checks.
    pub system: bool,
}

impl AuthIdentity {
    pub fn system() -> Self {
        Self {
            user_id: "system".into(),
            username: "system".into(),
            role: ROLE_ADMIN.into(),
            sections: SECTIONS.iter().map(|s| s.to_string()).collect(),
            system: true,
        }
    }

    /// Open-API guest: full sections, shown as "guest" in the UI.
    pub fn guest() -> Self {
        Self {
            user_id: "guest".into(),
            username: "guest".into(),
            role: ROLE_ADMIN.into(),
            sections: SECTIONS.iter().map(|s| s.to_string()).collect(),
            system: true,
        }
    }

    fn of(user: UserRow) -> Self {
        let sections = effective_sections(&user.role, user.sections.as_deref());
        Self {
            user_id: user.id,
            username: user.username,
            role: user.role,
            sections,
            system: false,
        }
    }
}

/// Map an `/api/...` path to its RBAC section. `None` = public/auth-self.
fn section_for(path: &str) -> Option<&'static str> {
    // Public + self-service first.
    if path == "/api/admin/auth/login" {
        return None;
    }
    if path == "/api/admin/auth/me" || path == "/api/admin/auth/password" {
        return Some("__self");
    }
    let rest = path.strip_prefix("/api/admin/").or_else(|| {
        path.strip_prefix("/api/mcp")
            .map(|_| "mcp-servers")
            .or_else(|| path.strip_prefix("/api/mcp-skills").map(|_| "mcp-servers"))
    });
    let rest = match rest {
        Some("mcp-servers") => return Some("mcp-servers"),
        Some(r) => r,
        None => return Some("dashboard"),
    };
    Some(if rest.starts_with("mcp-servers") {
        "mcp-servers"
    } else if rest.starts_with("agent-files") {
        "agent-studio"
    } else if rest.starts_with("agent-backend/env") {
        "env"
    } else if rest.starts_with("agent-backend") {
        "agent-studio"
    } else if rest.starts_with("skills") {
        "skills"
    } else if rest.starts_with("bsl-ls") {
        "bsl-ls"
    } else if rest.starts_with("config-profiles") {
        "configs"
    } else if rest.starts_with("client-versions") {
        "client-versions"
    } else if rest == "clients" {
        "clients"
    } else if rest.starts_with("logs") {
        "logs"
    } else if rest == "fs/browse" {
        "fs"
    } else if rest == "settings" {
        "settings"
    } else if rest == "auth/token" || rest == "auth/rotate" {
        "auth-manage"
    } else if rest == "status" {
        "dashboard"
    } else if rest.starts_with("users") {
        "users"
    } else if rest == "reindex" {
        "mcp-servers"
    } else {
        "dashboard"
    })
}

// ─── login rate limiting ───

#[derive(Debug, Clone)]
pub struct LoginAttempt {
    pub fails: u32,
    pub window_start: Instant,
    pub locked_until: Option<Instant>,
}

const LOGIN_MAX_FAILS: u32 = 5;
const LOGIN_WINDOW: Duration = Duration::from_secs(10 * 60);
const LOGIN_LOCK: Duration = Duration::from_secs(5 * 60);

fn login_locked(
    limits: &std::sync::Mutex<HashMap<String, LoginAttempt>>,
    ip: &str,
) -> Option<Duration> {
    let guard = limits.lock().ok()?;
    let a = guard.get(ip)?;
    if let Some(until) = a.locked_until {
        let now = Instant::now();
        if now < until {
            return Some(until - now);
        }
    }
    None
}

fn login_fail(limits: &std::sync::Mutex<HashMap<String, LoginAttempt>>, ip: &str) {
    if let Ok(mut guard) = limits.lock() {
        let now = Instant::now();
        let a = guard.entry(ip.to_string()).or_insert(LoginAttempt {
            fails: 0,
            window_start: now,
            locked_until: None,
        });
        if now.duration_since(a.window_start) > LOGIN_WINDOW {
            a.fails = 0;
            a.window_start = now;
            a.locked_until = None;
        }
        a.fails += 1;
        if a.fails >= LOGIN_MAX_FAILS {
            a.locked_until = Some(now + LOGIN_LOCK);
            tracing::warn!("auth: login locked for {ip} after {} fails", a.fails);
        }
    }
}

fn login_ok(limits: &std::sync::Mutex<HashMap<String, LoginAttempt>>, ip: &str) {
    if let Ok(mut guard) = limits.lock() {
        guard.remove(ip);
    }
}

// ─── middleware ───

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized: login or valid Bearer token required" })),
    )
        .into_response()
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "forbidden: insufficient permissions" })),
    )
        .into_response()
}

pub async fn bearer_auth(
    State(state): State<Arc<AppState>>,
    mut req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();
    if !path.starts_with("/api/") || req.method() == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }
    // NOTE: db guards are dropped BEFORE next.run — downstream handlers
    // lock the same mutex (deadlock otherwise).
    let auth_disabled = {
        let db = state.db.lock().await;
        !is_auth_required(&db)
    };
    if auth_disabled {
        // Open API: resolve identity when a bearer is present (so the UI
        // can show who is logged in), otherwise a guest with full sections.
        let bearer: Option<String> = req
            .headers()
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|t| t.trim().to_string());
        let ident = match bearer {
            Some(t) => {
                let db = state.db.lock().await;
                if verify_token(&db, &t) {
                    AuthIdentity::system()
                } else {
                    decode_jwt(&db, &t)
                        .map(AuthIdentity::of)
                        .unwrap_or_else(AuthIdentity::guest)
                }
            }
            None => AuthIdentity::guest(),
        };
        req.extensions_mut().insert(ident);
        return next.run(req).await;
    }
    let bearer: Option<String> = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t.trim().to_string());

    // Public login endpoint: needs a bearer only to *skip* rate-limit noise — no.
    // It is always reachable (rate-limited inside the handler).
    if path == "/api/admin/auth/login" {
        return next.run(req).await;
    }

    let identity: Option<AuthIdentity> = match bearer {
        Some(t) => {
            let db = state.db.lock().await;
            let is_legacy = verify_token(&db, &t);
            tracing::info!("auth: bearer={}... is_legacy={}", &t[..t.len().min(20)], is_legacy);
            if is_legacy {
                tracing::info!("auth: legacy token detected, using system identity");
                Some(AuthIdentity::system())
            } else {
                match decode_jwt(&db, &t) {
                    Some(user) => {
                        let ident = AuthIdentity::of(user);
                        tracing::info!("auth: jwt decoded -> user={} role={} system={}", ident.username, ident.role, ident.system);
                        Some(ident)
                    }
                    None => {
                        tracing::warn!("auth: jwt decode failed for token {}...", &t[..t.len().min(20)]);
                        None
                    }
                }
            }
        }
        None => None,
    };
    let identity = match identity {
        Some(i) => {
            tracing::debug!("auth: identity system={} role={} user={}", i.system, i.role, i.username);
            i
        }
        None => return unauthorized(),
    };

    // Section check.
    let section = section_for(&path).unwrap_or("dashboard");
    if !identity.system {
        let allowed = if section == "__self" {
            true
        } else {
            identity.sections.iter().any(|s| s == section)
        };
        if !allowed {
            return forbidden();
        }
        // Viewer (and any restricted role): mutations need operator+.
        // Role viewer is read-only; overrides can only *remove* sections,
        // never grant write — write requires role != viewer.
        let is_get = req.method() == axum::http::Method::GET;
        let self_pw = path == "/api/admin/auth/password";
        if !is_get && !self_pw && identity.role == ROLE_VIEWER {
            return forbidden();
        }
    }
    req.extensions_mut().insert(identity);
    next.run(req).await
}

// ─── handlers ───

#[derive(Debug, Deserialize)]
pub struct LoginBody {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub remember: bool,
}

/// POST /api/admin/auth/login — username/password → JWT. Rate-limited per IP.
pub async fn login_handler(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LoginBody>,
) -> Response {
    let ip = addr.ip().to_string();
    if let Some(wait) = login_locked(&state.login_limits, &ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": format!("too many attempts, retry in {}s", wait.as_secs()) })),
        )
            .into_response();
    }
    let (ok, token, identity) = {
        let db = state.db.lock().await;
        match find_user(&db, &body.username) {
            Some((user, hash)) if user.enabled && verify_password(&hash, &body.password) => {
                let ident = AuthIdentity::of(user.clone());
                match issue_jwt(&db, &user, body.remember) {
                    Ok(t) => (true, Some(t), Some(ident)),
                    Err(e) => {
                        tracing::error!("auth: jwt issue failed: {e}");
                        (false, None, None)
                    }
                }
            }
            _ => (false, None, None),
        }
    };
    if !ok {
        login_fail(&state.login_limits, &ip);
        tracing::warn!("auth: failed login for {:?} from {ip}", body.username);
        // Same message either way (no user enumeration).
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid username or password" })),
        )
            .into_response();
    }
    login_ok(&state.login_limits, &ip);
    let ident = identity.unwrap();
    tracing::info!("auth: login {} ({})", ident.username, ident.role);
    (
        StatusCode::OK,
        Json(json!({
            "token": token.unwrap(),
            "username": ident.username,
            "role": ident.role,
            "sections": ident.sections,
        })),
    )
        .into_response()
}

/// GET /api/admin/auth/me — who am I (sections for menu filtering).
pub async fn me_handler(
    State(state): State<Arc<AppState>>,
    Extension(ident): Extension<AuthIdentity>,
) -> Response {
    // Re-read from DB so disabled users / changed roles apply immediately.
    if ident.system {
        return Json(json!({ "username": ident.username, "role": "admin", "sections": SECTIONS, "system": true }))
            .into_response();
    }
    let username = ident.username.clone();
    let db = state.db.lock().await;
    match find_user(&db, &username) {
        Some((u, _)) if u.enabled => {
            let ident = AuthIdentity::of(u);
            Json(json!({
                "username": ident.username,
                "role": ident.role,
                "sections": ident.sections,
                "system": false,
            }))
            .into_response()
        }
        _ => unauthorized(),
    }
}

#[derive(Debug, Deserialize)]
pub struct PasswordBody {
    pub old_password: String,
    pub new_password: String,
}

/// POST /api/admin/auth/password — change own password.
pub async fn password_handler(
    State(state): State<Arc<AppState>>,
    Extension(ident): Extension<AuthIdentity>,
    Json(body): Json<PasswordBody>,
) -> Response {
    if ident.system {
        return unauthorized();
    }
    if body.new_password.len() < 8 || body.new_password.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "new password must be 8..128 chars" })),
        )
            .into_response();
    }
    let db = state.db.lock().await;
    let hash: String = match find_user(&db, &ident.username) {
        Some((u, h)) if u.enabled && verify_password(&h, &body.old_password) => {
            match hash_password(&body.new_password) {
                Ok(h) => h,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": e })),
                    )
                        .into_response()
                }
            }
        }
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "invalid old password" })),
            )
                .into_response()
        }
    };
    if db
        .conn
        .execute(
            "UPDATE users SET password_hash = ?1, updated_at = datetime('now') WHERE username = ?2",
            rusqlite::params![hash, ident.username],
        )
        .is_err()
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "update failed" })),
        )
            .into_response();
    }
    tracing::info!("auth: password changed for {}", ident.username);
    Json(json!({ "ok": true })).into_response()
}

/// POST /api/admin/auth/rotate — replace legacy API token (admin only).
pub async fn rotate_handler(
    State(state): State<Arc<AppState>>,
    Extension(ident): Extension<AuthIdentity>,
) -> Response {
    // Admin-only is enforced by the section map; double-check for safety.
    if !(ident.system || ident.sections.iter().any(|s| s == "auth-manage")) {
        return forbidden();
    }
    let db = state.db.lock().await;
    match rotate(&db) {
        Ok(token) => {
            tracing::warn!("API token rotated");
            Json(json!({ "token": token })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// GET /api/admin/auth/token — current token (admin only) + enforcement flag.
pub async fn token_handler(
    State(state): State<Arc<AppState>>,
    Extension(ident): Extension<AuthIdentity>,
) -> Response {
    let db = state.db.lock().await;
    let required = is_auth_required(&db);
    let is_admin = ident.system || ident.sections.iter().any(|s| s == "auth-manage");
    if required && !is_admin {
        return forbidden();
    }
    Json(json!({
        "token": if is_admin { current_token(&db) } else { None::<String> },
        "auth_required": required,
    }))
    .into_response()
}
