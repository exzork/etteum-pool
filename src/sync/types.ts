/**
 * Sync Protocol Types
 * 
 * Architecture:
 * - Master: publicly accessible, accepts WebSocket connections from workers
 * - Worker: connects to master, authenticates with sync key
 * - Bidirectional: both sides push changes, last-write-wins with updatedAt timestamp
 * 
 * Sync flow:
 * 1. Worker connects to master via WS at /sync
 * 2. Worker sends { type: "sync_auth", syncKey: "..." }
 * 3. Master validates key, responds with { type: "sync_auth_ok", nodeId: "..." }
 * 4. Both sides exchange { type: "sync_full_request" } to get initial state
 * 5. After initial sync, changes are pushed incrementally via { type: "sync_delta" }
 * 
 * Conflict resolution: updatedAt timestamp wins. On tie, master wins.
 */

export interface SyncConfig {
  enabled: boolean;
  role: "master" | "worker";
  syncKey: string;
  masterUrl?: string; // Only for workers: ws(s)://master-domain/sync
  nodeId: string; // Unique identifier for this instance
}

export interface SyncMessage {
  type: SyncMessageType;
  nodeId: string;
  timestamp: number;
  data?: unknown;
}

export type SyncMessageType =
  | "sync_auth"
  | "sync_auth_ok"
  | "sync_auth_fail"
  | "sync_full_request"
  | "sync_full_response"
  | "sync_delta"
  | "sync_ack"
  | "sync_ping"
  | "sync_pong";

export interface SyncDelta {
  table: SyncTable;
  operation: "upsert" | "delete";
  row: Record<string, unknown>;
  updatedAt: number; // epoch ms
}

export type SyncTable =
  | "accounts"
  | "api_keys"
  | "settings"
  | "request_logs"
  | "usage_summary"
  | "filter_rules"
  | "model_mappings"
  | "proxy_pool"
  | "vcc_cards";

export interface SyncFullData {
  accounts: Record<string, unknown>[];
  apiKeys: Record<string, unknown>[];
  settings: Record<string, unknown>[];
  filterRules: Record<string, unknown>[];
  modelMappings: Record<string, unknown>[];
  proxyPool: Record<string, unknown>[];
  usageSummary?: Record<string, unknown>[];
}

export interface SyncNodeInfo {
  nodeId: string;
  role: "master" | "worker";
  connectedAt: number;
  lastSyncAt: number;
}
