//! In-memory ring buffer of `tracing` events, exposed via `GET /api/admin/logs`.
//!
//! Captures everything the server logs (startup, MCP lifecycle, MCP stderr,
//! admin errors) without depending on the log file location.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::Serialize;
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub ts: String,
    pub level: String,
    pub target: String,
    pub msg: String,
}

#[derive(Debug, Clone)]
pub struct LogBuffer {
    inner: Arc<Mutex<VecDeque<LogEntry>>>,
    cap: usize,
}

impl LogBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(cap.min(10000)))),
            cap,
        }
    }

    pub fn push(&self, entry: LogEntry) {
        if let Ok(mut q) = self.inner.lock() {
            while q.len() >= self.cap {
                q.pop_front();
            }
            q.push_back(entry);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut q) = self.inner.lock() {
            q.clear();
        }
    }

    /// Newest last. `level` is a minimum severity ("warn" → warn + error).
    pub fn entries(
        &self,
        level: Option<Level>,
        limit: usize,
        search: Option<&str>,
    ) -> Vec<LogEntry> {
        let q = match self.inner.lock() {
            Ok(q) => q,
            Err(_) => return Vec::new(),
        };
        let limit = limit.clamp(1, 2000);
        let needle = search.map(|s| s.to_lowercase());
        q.iter()
            .filter(|e| {
                if let Some(min) = &level {
                    if severity(&e.level) > severity(&min.to_string()) {
                        return false;
                    }
                }
                if let Some(n) = &needle {
                    let hay = format!("{} {} {}", e.target, e.msg, e.level).to_lowercase();
                    if !hay.contains(n) {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .take(limit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    pub fn layer<S: Subscriber>(&self) -> LogBufferLayer {
        LogBufferLayer { buf: self.clone() }
    }
}

/// Lower number = more severe.
fn severity(level: &str) -> u8 {
    match level.to_uppercase().as_str() {
        "ERROR" => 0,
        "WARN" => 1,
        "INFO" => 2,
        "DEBUG" => 3,
        "TRACE" => 4,
        _ => 5,
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    rest: Vec<String>,
}

impl FieldVisitor {
    fn finish(self) -> String {
        match (self.message, self.rest.is_empty()) {
            (Some(m), true) => m,
            (Some(m), false) => format!("{} {}", m, self.rest.join(" ")),
            (None, _) => self.rest.join(" "),
        }
    }
}

impl tracing::field::Visit for FieldVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let v = format!("{value:?}");
        if field.name() == "message" {
            self.message = Some(v);
        } else {
            self.rest.push(format!("{}={v}", field.name()));
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        } else {
            self.rest.push(format!("{}={value}", field.name()));
        }
    }
}

#[derive(Debug, Clone)]
pub struct LogBufferLayer {
    buf: LogBuffer,
}

impl<S: Subscriber> Layer<S> for LogBufferLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        self.buf.push(LogEntry {
            ts: Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            level: meta.level().to_string(),
            target: meta.target().to_string(),
            msg: visitor.finish(),
        });
    }
}
