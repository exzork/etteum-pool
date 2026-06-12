/**
 * Sync Worker: connects to master node via WebSocket.
 * Handles authentication, full sync, and delta propagation.
 */
import type { SyncConfig, SyncMessage, SyncDelta } from "./types";
import { extractFullState, applyFullState, applyDelta } from "./data";

let syncConfig: SyncConfig | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let authenticated = false;
let connected = false;

const RECONNECT_DELAY_MS = 5_000;
const PING_INTERVAL_MS = 30_000;

export function initSyncWorker(config: SyncConfig) {
  syncConfig = config;
  if (!config.masterUrl) {
    console.error("[Sync Worker] No SYNC_MASTER_URL configured");
    return;
  }
  console.log(`[Sync Worker] Initialized. Node ID: ${config.nodeId}, Master: ${config.masterUrl}`);
  connect();
}

function connect() {
  if (!syncConfig?.masterUrl) return;

  const url = syncConfig.masterUrl.replace(/\/$/, "") + "/sync";
  console.log(`[Sync Worker] Connecting to ${url}...`);

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error(`[Sync Worker] Failed to create WebSocket:`, e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    console.log(`[Sync Worker] Connected to master`);

    // Send auth
    send({
      type: "sync_auth",
      nodeId: syncConfig!.nodeId,
      timestamp: Date.now(),
      data: { syncKey: syncConfig!.syncKey },
    });
  };

  ws.onmessage = async (event) => {
    let msg: SyncMessage;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "sync_auth_ok": {
        authenticated = true;
        console.log(`[Sync Worker] Authenticated with master (${(msg.data as any)?.masterNodeId})`);

        // Start ping interval
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          send({ type: "sync_ping", nodeId: syncConfig!.nodeId, timestamp: Date.now() });
        }, PING_INTERVAL_MS);

        // Request full state from master
        send({ type: "sync_full_request", nodeId: syncConfig!.nodeId, timestamp: Date.now() });

        // Also send our full state to master (bidirectional)
        const localState = await extractFullState();
        send({
          type: "sync_full_response",
          nodeId: syncConfig!.nodeId,
          timestamp: Date.now(),
          data: localState,
        });
        break;
      }

      case "sync_auth_fail": {
        console.error(`[Sync Worker] Auth failed:`, (msg.data as any)?.error);
        authenticated = false;
        break;
      }

      case "sync_full_response": {
        // Master sent us their full state
        const data = msg.data as any;
        if (data) {
          await applyFullState(data, msg.nodeId);
          console.log(`[Sync Worker] Applied full state from master`);
        }
        break;
      }

      case "sync_full_request": {
        // Master is requesting our full state
        const state = await extractFullState();
        send({
          type: "sync_full_response",
          nodeId: syncConfig!.nodeId,
          timestamp: Date.now(),
          data: state,
        });
        break;
      }

      case "sync_delta": {
        // Master (or another worker via master) sent a delta
        const delta = msg.data as SyncDelta;
        if (delta) {
          await applyDelta(delta);
        }
        break;
      }

      case "sync_pong": {
        // Heartbeat response, connection is alive
        break;
      }

      case "sync_ack": {
        // Our delta was acknowledged
        break;
      }
    }
  };

  ws.onclose = (event) => {
    connected = false;
    authenticated = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    console.log(`[Sync Worker] Disconnected (code: ${event.code}, reason: ${event.reason || "none"})`);
    scheduleReconnect();
  };

  ws.onerror = (event) => {
    console.error(`[Sync Worker] WebSocket error`);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function send(msg: SyncMessage) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    console.error(`[Sync Worker] Send failed:`, e);
  }
}

/**
 * Push a local delta to master.
 * Called when this worker makes a local change.
 */
export function pushDeltaToMaster(delta: SyncDelta) {
  if (!syncConfig || !authenticated) return;

  send({
    type: "sync_delta",
    nodeId: syncConfig.nodeId,
    timestamp: Date.now(),
    data: delta,
  });
}

/**
 * Get worker sync status
 */
export function getWorkerSyncStatus() {
  return {
    connected,
    authenticated,
    masterUrl: syncConfig?.masterUrl || null,
    nodeId: syncConfig?.nodeId || null,
  };
}

/**
 * Stop the sync worker
 */
export function stopSyncWorker() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (ws) { ws.close(1000, "shutdown"); ws = null; }
  connected = false;
  authenticated = false;
}
