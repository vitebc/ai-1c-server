#!/usr/bin/env node
/**
 * SSE → WebSocket bridge for OpenCode v2.
 *
 * Connects to OpenCode's /api/event (SSE) and relays events as WS messages.
 * 1C form connects via web-transport-addin (AddIn.WebTransport.ws).
 *
 * Usage:
 *   node opencode-sse-ws-bridge.mjs [options]
 *
 * Options (env or CLI):
 *   SSE_URL      — OpenCode SSE endpoint (default: http://127.0.0.1:4040/api/event)
 *   WS_PORT      — WebSocket port to listen on (default: 4041)
 *   WS_HOST      — Host to bind (default: 0.0.0.0)
 *   BASIC_USER   — Basic auth username (default: opencode)
 *   BASIC_PASS   — Basic auth password (default: 123)
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const SSE_URL = process.env.SSE_URL || "http://127.0.0.1:4040/api/event";
const WS_PORT = parseInt(process.env.WS_PORT || "4041", 10);
const WS_HOST = process.env.WS_HOST || "0.0.0.0";
const BASIC_USER = process.env.BASIC_USER || "opencode";
const BASIC_PASS = process.env.BASIC_PASS || "123";

const authHeader = "Basic " + Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64");

// --- SSE client: connect to OpenCode, parse frames, broadcast to WS clients ---

let sseAbort = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

async function connectSSE() {
  try {
    const controller = new AbortController();
    sseAbort = controller;

    const response = await fetch(SSE_URL, {
      headers: {
        Authorization: authHeader,
        Accept: "text/event-stream",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE HTTP ${response.status}`);
    }

    reconnectDelay = 1000; // reset on successful connect
    console.log(`[bridge] SSE connected to ${SSE_URL}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by double newline.
      // Process complete frames.
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.trim()) {
          broadcast(frame + "\n");
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return; // intentional disconnect
    console.error(`[bridge] SSE error: ${err.message}`);
  }

  // Reconnect with exponential backoff.
  console.log(`[bridge] SSE reconnecting in ${reconnectDelay}ms`);
  setTimeout(connectSSE, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// --- WebSocket server: relay SSE frames to connected 1C clients ---

const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });
const clients = new Set();

function broadcast(message) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[bridge] WS client connected (${clients.size} total)`);

  // Send initial heartbeat so the client knows we're alive.
  ws.send(": bridge ready\n");

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[bridge] WS client disconnected (${clients.size} total)`);
  });

  ws.on("error", (err) => {
    console.error(`[bridge] WS error: ${err.message}`);
    clients.delete(ws);
  });
});

wss.on("listening", () => {
  console.log(`[bridge] WebSocket server listening on ws://${WS_HOST}:${WS_PORT}`);
  console.log(`[bridge] SSE source: ${SSE_URL}`);
});

// Graceful shutdown.
process.on("SIGINT", () => {
  console.log("\n[bridge] Shutting down...");
  if (sseAbort) sseAbort.abort();
  for (const client of clients) client.close(1000, "bridge shutting down");
  wss.close(() => process.exit(0));
});

process.on("SIGTERM", () => process.exit(0));

// Start SSE connection.
connectSSE();
