use axum::{Router, routing::get};

mod admin;

async fn health() -> &'static str {
    "OK"
}

pub fn routes() -> Router {
    Router::new()
        .route("/health", get(health))
        .nest("/api/admin", admin::routes())
}
