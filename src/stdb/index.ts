/**
 * SpacetimeDB Client — replaces SQLite + Drizzle + custom sync.
 *
 * Connects to the SpacetimeDB server, subscribes to all tables,
 * and provides a drizzle-like interface for reading + writing.
 *
 * All workers connect to the same SpacetimeDB instance.
 * Changes propagate instantly via WebSocket subscriptions.
 */
import {
  DbConnection,
  DbConnectionBuilder,
  SubscriptionBuilder,
  tables,
  reducers,
  type EventContext,
  type SubscriptionEventContext,
  type ErrorContext,
  type ReducerEventContext,
} from "./bindings";

// ─── Configuration ──────────────────────────────────────────────────────────

const STDB_HOST = process.env.STDB_HOST || "https://stdb.exzork.me";
const STDB_DATABASE = process.env.STDB_DATABASE || "etteum-pool";
const STDB_TOKEN = process.env.STDB_TOKEN || ""; // identity token, empty = anonymous

// ─── Connection State ───────────────────────────────────────────────────────

let connection: DbConnection | null = null;
let connected = false;
let subscriptionReady = false;
let connectPromise: Promise<void> | null = null;

// Event emitter for table changes (used by WebSocket broadcast to dashboard)
type ChangeListener = (table: string, event: "insert" | "update" | "delete", row: any) => void;
const changeListeners: Set<ChangeListener> = new Set();

export function onTableChange(listener: ChangeListener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitChange(table: string, event: "insert" | "update" | "delete", row: any) {
  for (const listener of changeListeners) {
    try {
      listener(table, event, row);
    } catch {}
  }
}

// ─── Connection Management ──────────────────────────────────────────────────

export async function initStdb(): Promise<void> {
  if (connectPromise) return connectPromise;

  connectPromise = new Promise<void>((resolve, reject) => {
    console.log(`[STDB] Connecting to ${STDB_HOST} database=${STDB_DATABASE}...`);

    const builder = DbConnection.builder()
      .withUri(STDB_HOST)
      .withDatabaseName(STDB_DATABASE);

    if (STDB_TOKEN) {
      builder.withToken(STDB_TOKEN);
    }

    builder
      .onConnect((conn: DbConnection, identity, token) => {
        console.log(`[STDB] Connected. Identity: ${identity}`);
        connected = true;
        connection = conn;

        // Save token for reconnection
        if (token && !STDB_TOKEN) {
          process.env.STDB_TOKEN = token;
        }

        // Subscribe to ALL tables
        const sub = conn.subscriptionBuilder();
        sub.onApplied(() => {
          console.log("[STDB] Subscription applied — all tables synced");
          subscriptionReady = true;
          resolve();
        });
        sub.onError((_ctx: ErrorContext, err: Error) => {
          console.error("[STDB] Subscription error:", err.message);
        });
        sub.subscribeToAllTables();

        // Register table change callbacks for dashboard broadcast
        registerTableCallbacks(conn);
      })
      .onDisconnect((_ctx: any, err?: Error) => {
        console.warn("[STDB] Disconnected:", err?.message || "unknown");
        connected = false;
        subscriptionReady = false;
        // Auto-reconnect is handled by the SDK
      })
      .onConnectError((_ctx: any, err: Error) => {
        console.error("[STDB] Connection error:", err.message);
        reject(err);
      })
      .build();
  });

  return connectPromise;
}

function registerTableCallbacks(conn: DbConnection) {
  // Accounts
  conn.db.accounts.onInsert((ctx, row) => emitChange("accounts", "insert", row));
  conn.db.accounts.onUpdate((ctx, oldRow, newRow) => emitChange("accounts", "update", newRow));
  conn.db.accounts.onDelete((ctx, row) => emitChange("accounts", "delete", row));

  // API Keys
  conn.db.apiKeys.onInsert((ctx, row) => emitChange("api_keys", "insert", row));
  conn.db.apiKeys.onUpdate((ctx, oldRow, newRow) => emitChange("api_keys", "update", newRow));
  conn.db.apiKeys.onDelete((ctx, row) => emitChange("api_keys", "delete", row));

  // Settings
  conn.db.settings.onInsert((ctx, row) => emitChange("settings", "insert", row));
  conn.db.settings.onUpdate((ctx, oldRow, newRow) => emitChange("settings", "update", newRow));
  conn.db.settings.onDelete((ctx, row) => emitChange("settings", "delete", row));

  // Filter Rules
  conn.db.filterRules.onInsert((ctx, row) => emitChange("filter_rules", "insert", row));
  conn.db.filterRules.onUpdate((ctx, oldRow, newRow) => emitChange("filter_rules", "update", newRow));
  conn.db.filterRules.onDelete((ctx, row) => emitChange("filter_rules", "delete", row));

  // Model Mappings
  conn.db.modelMappings.onInsert((ctx, row) => emitChange("model_mappings", "insert", row));
  conn.db.modelMappings.onUpdate((ctx, oldRow, newRow) => emitChange("model_mappings", "update", newRow));
  conn.db.modelMappings.onDelete((ctx, row) => emitChange("model_mappings", "delete", row));

  // Proxy Pool
  conn.db.proxyPool.onInsert((ctx, row) => emitChange("proxy_pool", "insert", row));
  conn.db.proxyPool.onUpdate((ctx, oldRow, newRow) => emitChange("proxy_pool", "update", newRow));
  conn.db.proxyPool.onDelete((ctx, row) => emitChange("proxy_pool", "delete", row));

  // Request Logs
  conn.db.requestLogs.onInsert((ctx, row) => emitChange("request_logs", "insert", row));
  conn.db.requestLogs.onUpdate((ctx, oldRow, newRow) => emitChange("request_logs", "update", newRow));
  conn.db.requestLogs.onDelete((ctx, row) => emitChange("request_logs", "delete", row));

  // Usage Summary
  conn.db.usageSummary.onInsert((ctx, row) => emitChange("usage_summary", "insert", row));
  conn.db.usageSummary.onUpdate((ctx, oldRow, newRow) => emitChange("usage_summary", "update", newRow));
  conn.db.usageSummary.onDelete((ctx, row) => emitChange("usage_summary", "delete", row));

  // VCC Cards
  conn.db.vccCards.onInsert((ctx, row) => emitChange("vcc_cards", "insert", row));
  conn.db.vccCards.onUpdate((ctx, oldRow, newRow) => emitChange("vcc_cards", "update", newRow));
  conn.db.vccCards.onDelete((ctx, row) => emitChange("vcc_cards", "delete", row));
}

// ─── Getters (read from local cache — instant, no network) ──────────────────

function getConn(): DbConnection {
  if (!connection || !subscriptionReady) {
    throw new Error("[STDB] Not connected or subscription not ready. Call initStdb() first.");
  }
  return connection;
}

export function isReady(): boolean {
  return connected && subscriptionReady;
}

// ─── Table Accessors (read from local subscription cache) ───────────────────

export const stdb = {
  get accounts() {
    return getConn().db.accounts;
  },
  get apiKeys() {
    return getConn().db.apiKeys;
  },
  get settings() {
    return getConn().db.settings;
  },
  get requestLogs() {
    return getConn().db.requestLogs;
  },
  get usageSummary() {
    return getConn().db.usageSummary;
  },
  get filterRules() {
    return getConn().db.filterRules;
  },
  get modelMappings() {
    return getConn().db.modelMappings;
  },
  get proxyPool() {
    return getConn().db.proxyPool;
  },
  get vccCards() {
    return getConn().db.vccCards;
  },
  get vccTransactions() {
    return getConn().db.vccTransactions;
  },
  get imageStudioChats() {
    return getConn().db.imageStudioChats;
  },
  get imageStudioResults() {
    return getConn().db.imageStudioResults;
  },
};

// ─── Reducer Callers (write operations) ─────────────────────────────────────

export const call = {
  // Accounts
  upsertAccount: (args: {
    id: bigint;
    provider: string;
    email: string;
    password: string;
    status: string;
    enabled: boolean;
    tokens: string | null;
    quotaLimit: number;
    quotaRemaining: number;
    quotaResetAt: bigint | null;
    lastUsedAt: bigint | null;
    lastLoginAt: bigint | null;
    errorMessage: string | null;
    metadata: string | null;
  }) => getConn().reducers.upsertAccount(args),

  updateAccountStatus: (args: { id: bigint; status: string; errorMessage: string | null }) =>
    getConn().reducers.updateAccountStatus(args),

  updateAccountQuota: (args: {
    id: bigint;
    quotaRemaining: number;
    quotaResetAt: bigint | null;
    lastUsedAt: bigint | null;
  }) => getConn().reducers.updateAccountQuota(args),

  updateAccountTokens: (args: { id: bigint; tokens: string | null; lastLoginAt: bigint | null }) =>
    getConn().reducers.updateAccountTokens(args),

  updateAccountEnabled: (args: { id: bigint; enabled: boolean }) =>
    getConn().reducers.updateAccountEnabled(args),

  deleteAccount: (args: { id: bigint }) => getConn().reducers.deleteAccount(args),

  // API Keys
  upsertApiKey: (args: { id: bigint; name: string; key: string }) =>
    getConn().reducers.upsertApiKey(args),

  deleteApiKey: (args: { id: bigint }) => getConn().reducers.deleteApiKey(args),

  // Settings
  upsertSetting: (args: { key: string; value: string | null }) =>
    getConn().reducers.upsertSetting(args),

  deleteSetting: (args: { key: string }) => getConn().reducers.deleteSetting(args),

  // Request Logs
  insertRequestLog: (args: {
    accountId: bigint | null;
    provider: string;
    model: string | null;
    promptTokens: bigint;
    completionTokens: bigint;
    totalTokens: bigint;
    creditsUsed: number;
    status: string;
    durationMs: bigint | null;
    errorMessage: string | null;
    requestBody: string | null;
    responseBody: string | null;
    accountEmail: string | null;
    accountQuotaBefore: number;
    accountQuotaAfter: number;
    apiKeyId: bigint | null;
    apiKeyName: string | null;
  }) => getConn().reducers.insertRequestLog(args),

  updateRequestLog: (args: {
    id: bigint;
    promptTokens: bigint;
    completionTokens: bigint;
    totalTokens: bigint;
    creditsUsed: number;
    status: string;
    durationMs: bigint | null;
    errorMessage: string | null;
    accountQuotaAfter: number;
  }) => getConn().reducers.updateRequestLog(args),

  bulkDeleteRequestLogs: (args: { olderThanMs: bigint }) =>
    getConn().reducers.bulkDeleteRequestLogs(args),

  // Usage Summary
  upsertUsageSummary: (args: {
    bucket: string;
    provider: string;
    model: string;
    apiKeyId: bigint;
    apiKeyName: string | null;
    totalRequests: bigint;
    successRequests: bigint;
    errorRequests: bigint;
    promptTokens: bigint;
    completionTokens: bigint;
    totalTokens: bigint;
    creditsUsed: number;
    totalDurationMs: bigint;
  }) => getConn().reducers.upsertUsageSummary(args),

  // Filter Rules
  upsertFilterRule: (args: {
    id: bigint;
    ruleId: string;
    pattern: string;
    replacement: string;
    isActive: boolean;
    isRegex: boolean;
    sortOrder: number;
  }) => getConn().reducers.upsertFilterRule(args),

  deleteFilterRule: (args: { id: bigint }) => getConn().reducers.deleteFilterRule(args),

  // Model Mappings
  upsertModelMapping: (args: {
    id: bigint;
    sourcePattern: string;
    matchType: string;
    targetModel: string;
    enabled: boolean;
    priority: number;
    label: string | null;
  }) => getConn().reducers.upsertModelMapping(args),

  deleteModelMapping: (args: { id: bigint }) => getConn().reducers.deleteModelMapping(args),

  // Proxy Pool
  upsertProxy: (args: {
    id: bigint;
    url: string;
    proxyType: string;
    label: string | null;
    status: string;
    latencyMs: bigint | null;
    errorMessage: string | null;
  }) => getConn().reducers.upsertProxy(args),

  updateProxyStats: (args: {
    id: bigint;
    successCount: bigint;
    failCount: bigint;
    lastUsedAt: bigint | null;
    lastCheckedAt: bigint | null;
    latencyMs: bigint | null;
    status: string;
    errorMessage: string | null;
  }) => getConn().reducers.updateProxyStats(args),

  deleteProxy: (args: { id: bigint }) => getConn().reducers.deleteProxy(args),

  // VCC Cards
  upsertVccCard: (args: {
    id: bigint;
    number: string;
    expMonth: string;
    expYear: string;
    cvv: string;
    name: string;
    status: string;
    usedByAccountId: bigint | null;
  }) => getConn().reducers.upsertVccCard(args),

  deleteVccCard: (args: { id: bigint }) => getConn().reducers.deleteVccCard(args),

  // VCC Transactions
  insertVccTransaction: (args: {
    accountId: bigint | null;
    cardLast4: string;
    cardBrand: string | null;
    amount: number | null;
    currency: string;
    status: string;
    stripeChargeId: string | null;
  }) => getConn().reducers.insertVccTransaction(args),

  // Image Studio
  upsertImageStudioChat: (args: {
    id: bigint;
    title: string | null;
    messages: string;
    finalPrompt: string | null;
    options: string;
    assistModel: string | null;
  }) => getConn().reducers.upsertImageStudioChat(args),

  deleteImageStudioChat: (args: { id: bigint }) =>
    getConn().reducers.deleteImageStudioChat(args),

  insertImageStudioResult: (args: {
    chatId: bigint | null;
    prompt: string;
    resultType: string;
    aspectRatio: string;
    n: number;
    urls: string;
    creditsUsed: number;
  }) => getConn().reducers.insertImageStudioResult(args),
};

// ─── Convenience Helpers (match old drizzle patterns) ───────────────────────

/**
 * Get all rows from a table as an array.
 * Replaces: db.select().from(table)
 */
export function getAll<T>(tableAccessor: { iter: () => Iterable<T> }): T[] {
  return [...tableAccessor.iter()];
}

/**
 * Find a row by primary key.
 * Replaces: db.select().from(table).where(eq(table.id, id))
 */
export function findById<T>(tableAccessor: { id: { find: (id: bigint) => T | undefined } }, id: bigint): T | undefined {
  return tableAccessor.id.find(id);
}

/**
 * Get connection status for API
 */
export function getStdbStatus() {
  return {
    connected,
    subscriptionReady,
    host: STDB_HOST,
    database: STDB_DATABASE,
  };
}
