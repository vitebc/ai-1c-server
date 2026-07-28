use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub server_type: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<String>,
    pub env: Option<String>,
    pub url: Option<String>,
    pub enabled: bool,
    pub config: Option<String>,
}

impl McpServerConfig {
    pub fn load_all(db: &crate::db::Database) -> Result<Vec<Self>, Box<dyn std::error::Error>> {
        let mut stmt = db.conn.prepare(
            "SELECT id, name, description, server_type, transport, command, args, env, url, enabled, config
             FROM mcp_servers WHERE enabled = 1",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(McpServerConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                server_type: row.get(3)?,
                transport: row.get(4)?,
                command: row.get(5)?,
                args: row.get(6)?,
                env: row.get(7)?,
                url: row.get(8)?,
                enabled: row.get::<_, i32>(9)? != 0,
                config: row.get(10)?,
            })
        })?;
        let mut configs = Vec::new();
        for row in rows {
            configs.push(row?);
        }
        Ok(configs)
    }
}
