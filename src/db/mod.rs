use std::path::Path;
use rusqlite::Connection;

pub struct Database {
    pub conn: Connection,
}

impl Database {
    pub fn open(data_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(data_dir)?;
        let db_path = data_dir.join("db.sqlite");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        tracing::info!("Database opened: {}", db_path.display());
        Ok(Self { conn })
    }

    pub fn run_migrations(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (
                name TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )?;

        let migrations_dir = Path::new("migrations");
        if !migrations_dir.exists() {
            tracing::warn!("Migrations directory not found: {}", migrations_dir.display());
            return Ok(());
        }

        let mut files: Vec<_> = std::fs::read_dir(migrations_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "sql"))
            .collect();
        files.sort_by_key(|e| e.file_name());

        for entry in &files {
            let name = entry.file_name().to_string_lossy().to_string();
            let already: bool = self.conn.query_row(
                "SELECT COUNT(*) > 0 FROM _migrations WHERE name = ?1",
                [&name],
                |row| row.get(0),
            )?;
            if already {
                continue;
            }
            let sql = std::fs::read_to_string(entry.path())?;
            self.conn.execute_batch(&sql)?;
            self.conn.execute("INSERT INTO _migrations (name) VALUES (?1)", [&name])?;
            tracing::info!("Applied migration: {}", name);
        }

        Ok(())
    }
}
