use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "ai-1c-server", about = "AI 1C Enterprise Server")]
struct Cli {
    #[arg(long, default_value = "/data/mini-ai-1c")]
    data_dir: String,

    #[arg(long, default_value_t = 9224)]
    http_port: u16,

    #[arg(long)]
    admin_dir: Option<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    tracing::info!("Starting AI 1C Server (data_dir: {}, port: {})", cli.data_dir, cli.http_port);
    tracing::info!("Server initializing...");

    // TODO: init DB, MCP manager, file watcher, API routes

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", cli.http_port))
        .await
        .expect("Failed to bind address");

    tracing::info!("Listening on http://0.0.0.0:{}", cli.http_port);
    axum::serve(listener, axum::Router::new()).await.unwrap();
}
