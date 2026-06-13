/**
 * SQLite Change Tracker — uses triggers to capture all writes to synced tables.
 * A fast polling loop reads the changelog and emits deltas via the sync system.
 * This ensures ALL DB changes are synced regardless of code path (drizzle, raw SQL, etc).
 */
import { client } from "./index";

export type ChangeOperation = "INSERT" | "UPDATE" | "DELETE";

export interface ChangeEntry {
  id: number;
  table_name: string;
  operation: ChangeOperation;
  row_id: number;
  row_data: string; // JSON
  created_at: number;
}

// Tables to track for sync
const SYNCED_TABLES = [
  "accounts",
  "api_keys",
  "settings",
  "filter_rules",
  "model_mappings",
  "proxy_pool",
  "request_logs",
  "usage_summary",
] as const;

// High-frequency tables that should be batched/debounced
const HIGH_FREQ_TABLES = new Set(["request_logs", "usage_summary"]);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let changeCallback: ((entries: ChangeEntry[]) => void) | null = null;

/**
 * Create the changelog table and triggers for all synced tables.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export function installChangeTracking() {
  // Create changelog table
  client.exec(`
    CREATE TABLE IF NOT EXISTS _sync_changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      row_data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Index for fast polling
  client.exec(`
    CREATE INDEX IF NOT EXISTS _sync_changelog_id_idx ON _sync_changelog(id)
  `);

  // Create triggers for each synced table
  for (const table of SYNCED_TABLES) {
    const pkCol = table === "settings" ? "key" : "id";
    const rowIdExpr = table === "settings" ? "0" : `NEW.id`;
    const rowIdExprDel = table === "settings" ? "0" : `OLD.id`;

    // For settings table, use key as identifier in row_data
    // For other tables, capture the full row as JSON

    // INSERT trigger
    client.exec(`
      CREATE TRIGGER IF NOT EXISTS _sync_trg_${table}_insert
      AFTER INSERT ON ${table}
      BEGIN
        INSERT INTO _sync_changelog (table_name, operation, row_id, row_data, created_at)
        VALUES ('${table}', 'INSERT', ${rowIdExpr}, '{}', unixepoch() * 1000);
      END
    `);

    // UPDATE trigger
    client.exec(`
      CREATE TRIGGER IF NOT EXISTS _sync_trg_${table}_update
      AFTER UPDATE ON ${table}
      BEGIN
        INSERT INTO _sync_changelog (table_name, operation, row_id, row_data, created_at)
        VALUES ('${table}', 'UPDATE', ${rowIdExpr}, '{}', unixepoch() * 1000);
      END
    `);

    // DELETE trigger
    client.exec(`
      CREATE TRIGGER IF NOT EXISTS _sync_trg_${table}_delete
      AFTER DELETE ON ${table}
      BEGIN
        INSERT INTO _sync_changelog (table_name, operation, row_id, row_data, created_at)
        VALUES ('${table}', 'DELETE', ${rowIdExprDel}, '{}', unixepoch() * 1000);
      END
    `);
  }

  console.log(`[ChangeTracker] Installed triggers for ${SYNCED_TABLES.length} tables`);
}

/**
 * Start polling the changelog for new entries.
 * Calls the callback with batches of changes.
 */
export function startChangePolling(callback: (entries: ChangeEntry[]) => void, intervalMs = 100) {
  changeCallback = callback;
  let lastId = getMaxChangelogId();

  pollTimer = setInterval(() => {
    try {
      const entries = client
        .prepare(`SELECT id, table_name, operation, row_id, row_data, created_at FROM _sync_changelog WHERE id > ? ORDER BY id LIMIT 500`)
        .all(lastId) as ChangeEntry[];

      if (entries.length > 0) {
        lastId = entries[entries.length - 1].id;
        callback(entries);

        // Prune old entries (keep last 1000)
        if (lastId > 1000) {
          client.exec(`DELETE FROM _sync_changelog WHERE id < ${lastId - 1000}`);
        }
      }
    } catch (e) {
      // Silently continue on error (DB might be busy)
    }
  }, intervalMs);

  console.log(`[ChangeTracker] Polling started (${intervalMs}ms interval)`);
}

/**
 * Stop polling.
 */
export function stopChangePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Clear all pending changelog entries.
 * Call after applying remote state to prevent echo-back.
 */
export function clearChangelog() {
  try {
    client.exec(`DELETE FROM _sync_changelog`);
  } catch {}
}

function getMaxChangelogId(): number {
  try {
    const row = client.prepare(`SELECT MAX(id) as max_id FROM _sync_changelog`).get() as { max_id: number | null } | null;
    return row?.max_id || 0;
  } catch {
    return 0;
  }
}

/**
 * Read the full row data for a given table and row_id.
 * Used to populate the delta with actual data after a trigger fires.
 * Returns data in camelCase format (matching drizzle ORM output).
 */
export function readRowData(tableName: string, rowId: number): Record<string, unknown> | null {
  try {
    if (tableName === "settings") {
      // Settings uses key as PK, rowId is 0 — can't look up by id
      // Return null, caller should handle settings differently
      return null;
    }
    const row = client.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(rowId) as Record<string, unknown> | null;
    if (!row) return null;
    // Convert snake_case columns to camelCase to match drizzle format
    return snakeToCamel(row);
  } catch {
    return null;
  }
}

/**
 * Convert snake_case keys to camelCase.
 */
function snakeToCamel(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}
