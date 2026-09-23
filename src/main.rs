mod api;
mod auth;
mod db;
mod log_buffer;
mod mcp;
mod updater;
mod watcher;
mod web;

use std::sync::Arc;
use clap::{Parser, Subcommand};
use std::path::Path;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

#[derive(Parser, Debug)]
#[command(name = "ai-1c-server", about = "AI 1C Enterprise Server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(long, default_value = "/data/mini-ai-1c")]
    data_dir: String,

    #[arg(long, default_value_t = 9224)]
    http_port: u16,

    #[arg(long)]
    admin_dir: Option<String>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    Migrate,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let log_buffer = log_buffer::LogBuffer::new(1000);
    {
        use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
        let filter =
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
        tracing_subscriber::registry()
            .with(tracing_subscriber::fmt::layer())
            .with(filter)
            .with(log_buffer.layer::<tracing_subscriber::Registry>())
            .init();
    }

    let cli = Cli::parse();

    match &cli.command {
        Some(Commands::Migrate) => {
            let db = db::Database::open(Path::new(&cli.data_dir))?;
            db.run_migrations()?;
            tracing::info!("Migrations applied");
        }
        None => {
            let db = Arc::new(Mutex::new(db::Database::open(Path::new(&cli.data_dir))?));
            db.lock().await.run_migrations()?;

            // Bearer auth: reuse stored token or generate a new one (printed once).
            {
                let guard = db.lock().await;
                if let Some(token) = auth::ensure_token(&guard)? {
                    tracing::warn!("Generated new API token (shown once): {token}");
                }
                auth::ensure_jwt_secret(&guard)?;
                if let Some(password) = auth::ensure_admin(&guard)? {
                    tracing::warn!("Created initial admin user 'admin' with password (shown once): {password}");
                }
                if auth::is_auth_required(&guard) {
                    tracing::info!(
                        "API auth is ENABLED — pass 'Authorization: Bearer <token>' for /api/*"
                    );
                } else {
                    tracing::info!(
                        "API auth is disabled (default) — enable via Admin UI or settings auth_required=1"
                    );
                }
            }

            let mcp_manager = Arc::new(mcp::McpManager::new());
            let bsl_ls = Arc::new(mcp::BslLsManager::new(&cli.data_dir));
            {
                let guard = db.lock().await;
                bsl_ls.load_config(&*guard, &cli.data_dir).await;
            }

            let state = Arc::new(api::AppState {
                db,
                mcp: mcp_manager,
                bsl_ls,
                logs: log_buffer.clone(),
                data_dir: cli.data_dir.clone(),
                reindex_jobs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
                login_limits: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            });

            // (Re)build auto `search-*` rows from config_profiles, then start all.
            crate::api::admin::search_sync::resync_search_servers(&state).await;
            state.mcp.load_from_db(&state.db).await;

            let mut app = api::routes(state.clone())
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    crate::auth::bearer_auth,
                ))
                .layer(CorsLayer::permissive());

            if let Some(admin_dir) = &cli.admin_dir {
                let serve_dir = ServeDir::new(admin_dir)
                    .append_index_html_on_directories(true);
                app = app.fallback_service(serve_dir);
            }

            let addr = format!("0.0.0.0:{}", cli.http_port);
            tracing::info!("Listening on http://{}", addr);

            let listener = tokio::net::TcpListener::bind(&addr).await?;
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await?;
        }
    }

    Ok(())
}
