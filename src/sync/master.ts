/**
 * Sync Master: accepts WebSocket connections from worker nodes.
 * Handles authentication, full sync, and delta propagation.
 */
import type { ServerWebSocket } from "bun";
import type { SyncConfig, SyncMessage, SyncDelta, SyncNodeInfo } from "./types";
import { extractFullState, applyFullState, applyDelta } from "./data";

interface SyncPeer {
  ws: ServerWebSocket<unknown>;
  nodeId: string;
  authenticated: boolean;
  connectedAt: number;
  lastSyncAt: number;
}

const peers = new Map<ServerWebSocket<unknown>, SyncPeer>();
let syncConfig: SyncConfig | null = null;

export function initSyncMaster(config: SyncConfig) {
  syncConfig = config;
  console.log(`[Sync Master] Initialized. Node ID: ${config.nodeId}, Key: ${config.syncKey.slice(0, 4)}...`);
}

export function getSyncPeers(): SyncNodeInfo[] {
  return Array.from(peers.values())
    .filter((p) => p.authenticated)
    .map((p) => ({
      nodeId: p.nodeId,
      role: "worker" as const,
      connectedAt: p.connectedAt,
      lastSyncAt: p.lastSyncAt,
    }));
}

/**
 * Handle a new sync WebSocket connection (called from Bun.serve websocket handler)
 */
export function handleSyncOpen(ws: ServerWebSocket<unknown>) {
  peers.set(ws, {
    ws,
    nodeId: "",
    authenticated: false,
    connectedAt: Date.now(),
    lastSyncAt: 0,
  });
  console.log(`[Sync Master] New connection, awaiting auth...`);
}

/**
 * Handle sync WebSocket message
 */
export async function handleSyncMessage(ws: ServerWebSocket<unknown>, raw: string) {
  const peer = peers.get(ws);
  if (!peer) return;

  let msg: SyncMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // Authentication
  if (msg.type === "sync_auth") {
    const authData = msg.data as { syncKey: string } | undefined;
    if (!syncConfig || authData?.syncKey !== syncConfig.syncKey) {
      ws.send(JSON.stringify({
        type: "sync_auth_fail",
        nodeId: syncConfig?.nodeId || "master",
        timestamp: Date.now(),
        data: { error: "Invalid sync key" },
      }));
      ws.close(4001, "Invalid sync key");
      peers.delete(ws);
      console.log(`[Sync Master] Auth failed for node ${msg.nodeId}`);
      return;
    }

    peer.authenticated = true;
    peer.nodeId = msg.nodeId;
    ws.send(JSON.stringify({
      type: "sync_auth_ok",
      nodeId: syncConfig.nodeId,
      timestamp: Date.now(),
      data: { masterNodeId: syncConfig.nodeId },
    }));
    console.log(`[Sync Master] Node ${msg.nodeId} authenticated`);
    return;
  }

  // All other messages require authentication
  if (!peer.authenticated) {
    ws.close(4001, "Not authenticated");
    peers.delete(ws);
    return;
  }

  switch (msg.type) {
    case "sync_full_request": {
      // Worker is requesting full state from master
      const state = await extractFullState();
      ws.send(JSON.stringify({
        type: "sync_full_response",
        nodeId: syncConfig!.nodeId,
        timestamp: Date.now(),
        data: state,
      }));
      peer.lastSyncAt = Date.now();
      console.log(`[Sync Master] Sent full state to ${peer.nodeId}`);
      break;
    }

    case "sync_full_response": {
      // Worker sent us their full state (bidirectional)
      const data = msg.data as any;
      if (data) {
        await applyFullState(data, peer.nodeId);
        peer.lastSyncAt = Date.now();
        console.log(`[Sync Master] Applied full state from ${peer.nodeId}`);
      }
      break;
    }

    case "sync_delta": {
      // Worker sent an incremental change
      const delta = msg.data as SyncDelta;
      if (delta) {
        const ok = await applyDelta(delta);
        if (ok) {
          peer.lastSyncAt = Date.now();
          // Propagate to other connected peers
          propagateDelta(ws, msg);
        }
        ws.send(JSON.stringify({
          type: "sync_ack",
          nodeId: syncConfig!.nodeId,
          timestamp: Date.now(),
          data: { ok },
        }));
      }
      break;
    }

    case "sync_ping": {
      ws.send(JSON.stringify({
        type: "sync_pong",
        nodeId: syncConfig!.nodeId,
        timestamp: Date.now(),
      }));
      break;
    }
  }
}

/**
 * Handle sync WebSocket close
 */
export function handleSyncClose(ws: ServerWebSocket<unknown>) {
  const peer = peers.get(ws);
  if (peer) {
    console.log(`[Sync Master] Node ${peer.nodeId || "unknown"} disconnected`);
  }
  peers.delete(ws);
}

/**
 * Broadcast a delta to all authenticated peers (except the sender)
 */
function propagateDelta(sender: ServerWebSocket<unknown>, msg: SyncMessage) {
  const payload = JSON.stringify(msg);
  for (const [ws, peer] of peers) {
    if (ws === sender || !peer.authenticated) continue;
    try {
      ws.send(payload);
    } catch {
      peers.delete(ws);
    }
  }
}

/**
 * Push a local delta to all connected workers.
 * Called when the master itself makes a change.
 */
export function pushDeltaToWorkers(delta: SyncDelta) {
  if (!syncConfig || peers.size === 0) return;

  const msg: SyncMessage = {
    type: "sync_delta",
    nodeId: syncConfig.nodeId,
    timestamp: Date.now(),
    data: delta,
  };
  const payload = JSON.stringify(msg);

  for (const [ws, peer] of peers) {
    if (!peer.authenticated) continue;
    try {
      ws.send(payload);
    } catch {
      peers.delete(ws);
    }
  }
}
