mod api;
mod auth;
mod db;
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
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

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

            let mcp_manager = Arc::new(mcp::McpManager::new());
            mcp_manager.load_from_db(&db).await;

            let bsl_ls = Arc::new(mcp::BslLsManager::new(&cli.data_dir));
            {
                let guard = db.lock().await;
                bsl_ls.load_config(&*guard, &cli.data_dir).await;
            }

            let state = Arc::new(api::AppState {
                db,
                mcp: mcp_manager,
                bsl_ls,
                data_dir: cli.data_dir.clone(),
            });

            let mut app = api::routes(state).layer(CorsLayer::permissive());

            if let Some(admin_dir) = &cli.admin_dir {
                let serve_dir = ServeDir::new(admin_dir)
                    .append_index_html_on_directories(true);
                app = app.fallback_service(serve_dir);
            }

            let addr = format!("0.0.0.0:{}", cli.http_port);
            tracing::info!("Listening on http://{}", addr);

            let listener = tokio::net::TcpListener::bind(&addr).await?;
            axum::serve(listener, app).await?;
        }
    }

    Ok(())
}
