/**
 * Migrate data from SQLite to SpacetimeDB.
 * Reads all tables from the local SQLite DB and inserts into SpacetimeDB via reducers.
 *
 * Usage: bun run scripts/migrate-to-stdb.ts
 */
import { Database } from "bun:sqlite";
import { DbConnection } from "../src/stdb/bindings";

const SQLITE_PATH = process.env.DATABASE_PATH || "./data/poolprox3.db";
const STDB_HOST = process.env.STDB_HOST || "http://zorkmail.xyz:3000";
const STDB_DATABASE = process.env.STDB_DATABASE || "etteum-pool";

console.log(`[Migrate] SQLite: ${SQLITE_PATH}`);
console.log(`[Migrate] SpacetimeDB: ${STDB_HOST} / ${STDB_DATABASE}`);

const sqlite = new Database(SQLITE_PATH, { readonly: true });

// Helper: convert SQLite timestamp (epoch seconds) to epoch ms (bigint)
function tsToMs(val: number | null | undefined): bigint | undefined {
  if (val == null || val === 0) return undefined;
  // If > 10 billion, already ms
  if (val > 10_000_000_000) return BigInt(val);
  // Otherwise seconds -> ms
  return BigInt(val) * 1000n;
}

function strOrUndef(val: string | null | undefined): string | undefined {
  return val == null ? undefined : val;
}

function numOrZero(val: number | null | undefined): number {
  return val ?? 0;
}

// Connect to SpacetimeDB
const conn = await new Promise<DbConnection>((resolve, reject) => {
  DbConnection.builder()
    .withUri(STDB_HOST)
    .withDatabaseName(STDB_DATABASE)
    .onConnect((connection, identity, _token) => {
      console.log(`[Migrate] Connected to SpacetimeDB. Identity: ${identity}`);
      const sub = connection.subscriptionBuilder();
      sub.onApplied(() => {
        console.log("[Migrate] Subscription ready");
        resolve(connection);
      });
      sub.onError((_ctx, err) => reject(err));
      sub.subscribeToAllTables();
    })
    .onConnectError((_ctx, err) => reject(err))
    .onDisconnect(() => {})
    .build();
});

// Helper: wait for reducer to be applied (poll local cache)
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// Batch helper: call reducers in batches with small delays to avoid overwhelming
async function batchCall<T>(items: T[], fn: (item: T) => void, label: string, batchSize = 50) {
  console.log(`[Migrate] ${label}: ${items.length} rows`);
  let done = 0;
  for (let i = 0; i < items.length; i++) {
    fn(items[i]);
    done++;
    if (done % batchSize === 0) {
      process.stdout.write(`  ${done}/${items.length}\r`);
      await sleep(100); // Let the server breathe
    }
  }
  console.log(`  ${done}/${items.length} done`);
  await sleep(500); // Wait for last batch to propagate
}

// ─── Migrate Settings ───────────────────────────────────────────────────────
const settingsRows = sqlite.prepare("SELECT * FROM settings").all() as any[];
await batchCall(settingsRows, (r) => {
  conn.reducers.upsertSetting({
    key: r.key,
    value: strOrUndef(r.value),
  });
}, "settings");

// ─── Migrate API Keys ───────────────────────────────────────────────────────
const apiKeyRows = sqlite.prepare("SELECT * FROM api_keys").all() as any[];
await batchCall(apiKeyRows, (r) => {
  conn.reducers.upsertApiKey({
    id: 0n, // Let SpacetimeDB assign new IDs
    name: r.name,
    key: r.key,
  });
}, "api_keys");

// ─── Migrate Accounts ───────────────────────────────────────────────────────
const accountRows = sqlite.prepare("SELECT * FROM accounts").all() as any[];
await batchCall(accountRows, (r) => {
  conn.reducers.upsertAccount({
    id: 0n, // New IDs
    provider: r.provider,
    email: r.email,
    password: r.password,
    status: r.status || "pending",
    enabled: r.enabled === 1 || r.enabled === true,
    tokens: strOrUndef(r.tokens),
    quotaLimit: numOrZero(r.quota_limit),
    quotaRemaining: numOrZero(r.quota_remaining),
    quotaResetAt: tsToMs(r.quota_reset_at),
    lastUsedAt: tsToMs(r.last_used_at),
    lastLoginAt: tsToMs(r.last_login_at),
    errorMessage: strOrUndef(r.error_message),
    metadata: strOrUndef(r.metadata),
  });
}, "accounts", 100);

// ─── Migrate Filter Rules ───────────────────────────────────────────────────
const filterRows = sqlite.prepare("SELECT * FROM filter_rules").all() as any[];
await batchCall(filterRows, (r) => {
  conn.reducers.upsertFilterRule({
    id: 0n,
    ruleId: r.rule_id,
    pattern: r.pattern,
    replacement: r.replacement || "",
    isActive: r.is_active === 1 || r.is_active === true,
    isRegex: r.is_regex === 1 || r.is_regex === true,
    sortOrder: r.sort_order || 0,
  });
}, "filter_rules");

// ─── Migrate Model Mappings ─────────────────────────────────────────────────
const mappingRows = sqlite.prepare("SELECT * FROM model_mappings").all() as any[];
await batchCall(mappingRows, (r) => {
  conn.reducers.upsertModelMapping({
    id: 0n,
    sourcePattern: r.source_pattern,
    matchType: r.match_type || "contains",
    targetModel: r.target_model || "",
    enabled: r.enabled === 1 || r.enabled === true,
    priority: r.priority || 0,
    label: strOrUndef(r.label),
  });
}, "model_mappings");

// ─── Migrate Proxy Pool ─────────────────────────────────────────────────────
const proxyRows = sqlite.prepare("SELECT * FROM proxy_pool").all() as any[];
await batchCall(proxyRows, (r) => {
  conn.reducers.upsertProxy({
    id: 0n,
    url: r.url,
    proxyType: r.type || "http",
    label: strOrUndef(r.label),
    status: r.status || "active",
    latencyMs: r.latency_ms != null ? BigInt(r.latency_ms) : undefined,
    errorMessage: strOrUndef(r.error_message),
  });
}, "proxy_pool");

// ─── Migrate Usage Summary ──────────────────────────────────────────────────
const usageRows = sqlite.prepare("SELECT * FROM usage_summary").all() as any[];
await batchCall(usageRows, (r) => {
  conn.reducers.upsertUsageSummary({
    bucket: r.bucket,
    provider: r.provider,
    model: r.model,
    apiKeyId: BigInt(r.api_key_id || 0),
    apiKeyName: strOrUndef(r.api_key_name),
    totalRequests: BigInt(r.total_requests || 0),
    successRequests: BigInt(r.success_requests || 0),
    errorRequests: BigInt(r.error_requests || 0),
    promptTokens: BigInt(r.prompt_tokens || 0),
    completionTokens: BigInt(r.completion_tokens || 0),
    totalTokens: BigInt(r.total_tokens || 0),
    creditsUsed: numOrZero(r.credits_used),
    totalDurationMs: BigInt(r.total_duration_ms || 0),
  });
}, "usage_summary");

// ─── Migrate Request Logs (only recent ones) ────────────────────────────────
const logRows = sqlite.prepare("SELECT * FROM request_logs ORDER BY id DESC LIMIT 500").all() as any[];
await batchCall(logRows, (r) => {
  conn.reducers.insertRequestLog({
    accountId: r.account_id != null ? BigInt(r.account_id) : undefined,
    provider: r.provider,
    model: strOrUndef(r.model),
    promptTokens: BigInt(r.prompt_tokens || 0),
    completionTokens: BigInt(r.completion_tokens || 0),
    totalTokens: BigInt(r.total_tokens || 0),
    creditsUsed: numOrZero(r.credits_used),
    status: r.status || "success",
    durationMs: r.duration_ms != null ? BigInt(r.duration_ms) : undefined,
    errorMessage: strOrUndef(r.error_message),
    requestBody: strOrUndef(r.request_body),
    responseBody: strOrUndef(r.response_body),
    accountEmail: strOrUndef(r.account_email),
    accountQuotaBefore: numOrZero(r.account_quota_before),
    accountQuotaAfter: numOrZero(r.account_quota_after),
    apiKeyId: r.api_key_id != null ? BigInt(r.api_key_id) : undefined,
    apiKeyName: strOrUndef(r.api_key_name),
  });
}, "request_logs", 50);

// ─── Migrate VCC Cards ──────────────────────────────────────────────────────
const vccRows = sqlite.prepare("SELECT * FROM vcc_cards").all() as any[];
if (vccRows.length > 0) {
  await batchCall(vccRows, (r) => {
    conn.reducers.upsertVccCard({
      id: 0n,
      number: r.number,
      expMonth: r.exp_month,
      expYear: r.exp_year,
      cvv: r.cvv,
      name: r.name || "John Doe",
      status: r.status || "active",
      usedByAccountId: r.used_by_account_id != null ? BigInt(r.used_by_account_id) : undefined,
    });
  }, "vcc_cards");
}

// ─── Migrate Image Studio Chats ─────────────────────────────────────────────
const chatRows = sqlite.prepare("SELECT * FROM image_studio_chats").all() as any[];
if (chatRows.length > 0) {
  await batchCall(chatRows, (r) => {
    conn.reducers.upsertImageStudioChat({
      id: 0n,
      title: strOrUndef(r.title),
      messages: typeof r.messages === "string" ? r.messages : JSON.stringify(r.messages || []),
      finalPrompt: strOrUndef(r.final_prompt),
      options: typeof r.options === "string" ? r.options : JSON.stringify(r.options || []),
      assistModel: strOrUndef(r.assist_model),
    });
  }, "image_studio_chats");
}

// ─── Verify ─────────────────────────────────────────────────────────────────
console.log("\n[Migrate] Waiting for all data to propagate...");
await sleep(3000);

// Count rows in SpacetimeDB
const counts = {
  accounts: [...conn.db.accounts.iter()].length,
  apiKeys: [...conn.db.apiKeys.iter()].length,
  settings: [...conn.db.settings.iter()].length,
  filterRules: [...conn.db.filterRules.iter()].length,
  modelMappings: [...conn.db.modelMappings.iter()].length,
  proxyPool: [...conn.db.proxyPool.iter()].length,
  requestLogs: [...conn.db.requestLogs.iter()].length,
  usageSummary: [...conn.db.usageSummary.iter()].length,
  vccCards: [...conn.db.vccCards.iter()].length,
  imageStudioChats: [...conn.db.imageStudioChats.iter()].length,
};

console.log("\n[Migrate] Final counts in SpacetimeDB:");
for (const [table, count] of Object.entries(counts)) {
  console.log(`  ${table}: ${count}`);
}

console.log("\n✓ Migration complete!");
process.exit(0);
