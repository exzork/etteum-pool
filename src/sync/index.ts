/**
 * Sync module entry point.
 * Initializes master or worker based on config, provides emitDelta() for other modules.
 */
import type { SyncConfig, SyncDelta, SyncTable, SyncNodeInfo } from "./types";
import { loadSyncConfig } from "./config";
import { initSyncMaster, pushDeltaToWorkers, getSyncPeers, handleSyncOpen, handleSyncMessage, handleSyncClose } from "./master";
import { initSyncWorker, pushDeltaToMaster, getWorkerSyncStatus, stopSyncWorker } from "./worker";

export type { SyncDelta, SyncTable, SyncNodeInfo };

let config: SyncConfig | null = null;

/**
 * Initialize the sync system. Call once on startup after DB is ready.
 */
export async function initSync() {
  config = await loadSyncConfig();

  if (!config.enabled) {
    console.log("[Sync] Disabled (set SYNC_ENABLED=true to enable)");
    return;
  }

  if (!config.syncKey) {
    console.error("[Sync] SYNC_KEY is required when sync is enabled");
    return;
  }

  if (config.role === "master") {
    initSyncMaster(config);
  } else {
    initSyncWorker(config);
  }
}

/**
 * Emit a delta to connected peers.
 * Call this whenever a local DB change happens that should be synced.
 */
export function emitDelta(table: SyncTable, operation: "upsert" | "delete", row: Record<string, unknown>) {
  if (!config?.enabled) return;

  const delta: SyncDelta = {
    table,
    operation,
    row,
    updatedAt: Date.now(),
  };

  if (config.role === "master") {
    pushDeltaToWorkers(delta);
  } else {
    pushDeltaToMaster(delta);
  }
}

/**
 * Get sync status for the API
 */
export function getSyncStatus() {
  if (!config?.enabled) {
    return { enabled: false, role: null, nodeId: null };
  }

  if (config.role === "master") {
    return {
      enabled: true,
      role: "master" as const,
      nodeId: config.nodeId,
      peers: getSyncPeers(),
    };
  }

  return {
    enabled: true,
    role: "worker" as const,
    ...getWorkerSyncStatus(),
  };
}

/**
 * Get the sync config (for WebSocket handler routing)
 */
export function isSyncEnabled(): boolean {
  return config?.enabled || false;
}

export function isSyncMaster(): boolean {
  return config?.role === "master";
}

// Re-export WebSocket handlers for master
export { handleSyncOpen, handleSyncMessage, handleSyncClose };
