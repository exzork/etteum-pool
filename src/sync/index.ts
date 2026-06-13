/**
 * Sync module entry point.
 * Initializes master or worker based on config, provides realtime DB sync
 * via SQLite triggers + polling.
 */
import type { SyncConfig, SyncDelta, SyncTable, SyncNodeInfo } from "./types";
import { loadSyncConfig } from "./config";
import { initSyncMaster, pushDeltaToWorkers, getSyncPeers, handleSyncOpen, handleSyncMessage, handleSyncClose } from "./master";
import { initSyncWorker, pushDeltaToMaster, getWorkerSyncStatus, stopSyncWorker } from "./worker";
import { installChangeTracking, startChangePolling, stopChangePolling, readRowData, type ChangeEntry } from "../db/change-tracker";
import { client } from "../db/index";
import { getSuppressEmit, setSuppressEmit } from "./state";

export type { SyncDelta, SyncTable, SyncNodeInfo };
export { setSuppressEmit };

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

  // Install change tracking triggers
  installChangeTracking();

  if (config.role === "master") {
    initSyncMaster(config);
  } else {
    initSyncWorker(config);
  }

  // Start realtime change polling — converts DB changes to sync deltas
  startChangePolling(handleChanges, 100);
}

/**
 * Process changelog entries and emit as sync deltas.
 */
function handleChanges(entries: ChangeEntry[]) {
  if (!config?.enabled || getSuppressEmit()) return;

  for (const entry of entries) {
    const table = entry.table_name as SyncTable;
    const operation = entry.operation === "DELETE" ? "delete" : "upsert";

    let row: Record<string, unknown>;

    if (operation === "delete") {
      // For deletes, we only have the row_id
      row = { id: entry.row_id };
    } else {
      // For inserts/updates, read the current row data
      const rowData = readRowData(entry.table_name, entry.row_id);
      if (!rowData) {
        // Row might have been deleted between trigger and poll (rare)
        // For settings table, skip — it's handled via key-based lookup
        if (entry.table_name === "settings") {
          // Read all settings that changed recently
          try {
            const recentSettings = client
              .prepare(`SELECT * FROM settings WHERE updated_at >= ?`)
              .all(entry.created_at - 1000) as Record<string, unknown>[];
            for (const setting of recentSettings) {
              emitDelta("settings", "upsert", setting);
            }
          } catch {}
        }
        continue;
      }
      row = rowData;
    }

    emitDelta(table, operation, row);
  }
}

/**
 * Emit a delta to connected peers.
 * Call this whenever a local DB change happens that should be synced.
 */
export function emitDelta(table: SyncTable, operation: "upsert" | "delete", row: Record<string, unknown>) {
  if (!config?.enabled || getSuppressEmit()) return;

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

/**
 * Stop the sync system (for graceful shutdown)
 */
export function stopSync() {
  stopChangePolling();
  if (config?.role === "worker") {
    stopSyncWorker();
  }
}

// Re-export WebSocket handlers for master
export { handleSyncOpen, handleSyncMessage, handleSyncClose };
