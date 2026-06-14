/**
 * Rebuild usage_summary from request_logs.
 *
 * Why this exists:
 *   The old upsertUsageSummary reducer overwrote rows with per-request deltas
 *   instead of accumulating them, so historical buckets only reflect the LAST
 *   request that landed in each (bucket, provider, model, apiKeyId) cell.
 *   This script wipes usage_summary and re-aggregates from request_logs, which
 *   is the per-request source of truth and was always recorded correctly.
 *
 * Caveat:
 *   request_logs is pruned to the last ~1 hour by the proxy
 *   (see pruneRequestLogs in src/proxy/index.ts). Rows older than that are
 *   gone — this script can only restore the window that request_logs still
 *   covers. Older buckets keep whatever broken values they had.
 *
 * Usage:
 *   bun run scripts/rebuild-usage-summary.ts
 *
 * Env:
 *   STDB_HOST     (default: http://zorkmail.xyz:3000)
 *   STDB_DATABASE (default: etteum-pool)
 *   DRY_RUN=1     to print the plan without mutating
 */
import { DbConnection } from "../src/stdb/bindings";

const STDB_HOST = process.env.STDB_HOST || "http://zorkmail.xyz:3000";
const STDB_DATABASE = process.env.STDB_DATABASE || "etteum-pool";
const DRY_RUN = process.env.DRY_RUN === "1";

console.log(`[Rebuild] SpacetimeDB: ${STDB_HOST} / ${STDB_DATABASE}`);
if (DRY_RUN) console.log("[Rebuild] DRY_RUN=1 — no mutations will be sent");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// 5-minute bucket key, matching upsertUsageSummary in src/proxy/index.ts.
function bucketIso(epochMs: bigint): string {
  const d = new Date(Number(epochMs));
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return d.toISOString();
}

const conn = await new Promise<DbConnection>((resolve, reject) => {
  DbConnection.builder()
    .withUri(STDB_HOST)
    .withDatabaseName(STDB_DATABASE)
    .onConnect((connection, identity) => {
      console.log(`[Rebuild] Connected. Identity: ${identity}`);
      const sub = connection.subscriptionBuilder();
      sub.onApplied(() => {
        console.log("[Rebuild] Subscription ready");
        resolve(connection);
      });
      sub.onError((_ctx, err) => reject(err));
      sub.subscribeToAllTables();
    })
    .onConnectError((_ctx, err) => reject(err))
    .onDisconnect(() => {})
    .build();
});

// ─── 1. Aggregate request_logs in memory ────────────────────────────────────

type Agg = {
  bucket: string;
  provider: string;
  model: string;
  apiKeyId: bigint;
  apiKeyName: string | undefined;
  totalRequests: bigint;
  successRequests: bigint;
  errorRequests: bigint;
  promptTokens: bigint;
  completionTokens: bigint;
  totalTokens: bigint;
  creditsUsed: number;
  totalDurationMs: bigint;
};

const agg = new Map<string, Agg>();
let logCount = 0;

for (const row of conn.db.requestLogs.iter()) {
  logCount++;
  const provider = row.provider || "unknown";
  const model = row.model || "unknown";
  const apiKeyId = row.apiKeyId ?? 0n;
  const apiKeyName = row.apiKeyName ?? undefined;
  const bucket = bucketIso(row.createdAt);
  const key = `${bucket}|${provider}|${model}|${apiKeyId}`;

  let cell = agg.get(key);
  if (!cell) {
    cell = {
      bucket,
      provider,
      model,
      apiKeyId,
      apiKeyName,
      totalRequests: 0n,
      successRequests: 0n,
      errorRequests: 0n,
      promptTokens: 0n,
      completionTokens: 0n,
      totalTokens: 0n,
      creditsUsed: 0,
      totalDurationMs: 0n,
    };
    agg.set(key, cell);
  }
  // Prefer a non-null name if we ever see one.
  if (cell.apiKeyName == null && apiKeyName != null) cell.apiKeyName = apiKeyName;

  cell.totalRequests += 1n;
  if (row.status === "success") cell.successRequests += 1n;
  else if (row.status === "error") cell.errorRequests += 1n;
  cell.promptTokens += row.promptTokens ?? 0n;
  cell.completionTokens += row.completionTokens ?? 0n;
  cell.totalTokens += row.totalTokens ?? 0n;
  cell.creditsUsed += row.creditsUsed ?? 0;
  cell.totalDurationMs += row.durationMs ?? 0n;
}

console.log(
  `[Rebuild] Aggregated ${logCount} request_logs into ${agg.size} (bucket,provider,model,apiKey) cells`,
);

if (agg.size === 0) {
  console.log("[Rebuild] Nothing to do. Exiting.");
  process.exit(0);
}

// ─── 2. Find existing usage_summary rows in the affected buckets ────────────

const affectedBuckets = new Set([...agg.values()].map((c) => c.bucket));
const toDelete: bigint[] = [];
for (const row of conn.db.usageSummary.iter()) {
  if (affectedBuckets.has(row.bucket)) toDelete.push(row.id);
}

console.log(
  `[Rebuild] ${toDelete.length} existing usage_summary rows to delete (across ${affectedBuckets.size} buckets)`,
);

// Show a sample
const sample = [...agg.values()].slice(0, 5);
console.log("[Rebuild] Sample of cells to write:");
for (const c of sample) {
  console.log(
    `  ${c.bucket} ${c.provider}/${c.model} key=${c.apiKeyId} ` +
      `req=${c.totalRequests} (ok=${c.successRequests} err=${c.errorRequests}) ` +
      `tokens=${c.totalTokens} credits=${c.creditsUsed.toFixed(4)}`,
  );
}

if (DRY_RUN) {
  console.log("[Rebuild] DRY_RUN — exiting without mutations");
  process.exit(0);
}

// ─── 3. Delete stale rows in affected buckets ───────────────────────────────

console.log(`[Rebuild] Deleting ${toDelete.length} stale rows...`);
let delDone = 0;
for (const id of toDelete) {
  conn.reducers.deleteUsageSummary({ id });
  delDone++;
  if (delDone % 50 === 0) {
    process.stdout.write(`  delete ${delDone}/${toDelete.length}\r`);
    await sleep(100);
  }
}
console.log(`  delete ${delDone}/${toDelete.length} done`);
await sleep(500);

// ─── 4. Insert recomputed rows ──────────────────────────────────────────────

console.log(`[Rebuild] Inserting ${agg.size} recomputed rows...`);
let insDone = 0;
for (const c of agg.values()) {
  conn.reducers.upsertUsageSummary({
    bucket: c.bucket,
    provider: c.provider,
    model: c.model,
    apiKeyId: c.apiKeyId,
    apiKeyName: c.apiKeyName,
    totalRequests: c.totalRequests,
    successRequests: c.successRequests,
    errorRequests: c.errorRequests,
    promptTokens: c.promptTokens,
    completionTokens: c.completionTokens,
    totalTokens: c.totalTokens,
    creditsUsed: c.creditsUsed,
    totalDurationMs: c.totalDurationMs,
  });
  insDone++;
  if (insDone % 50 === 0) {
    process.stdout.write(`  insert ${insDone}/${agg.size}\r`);
    await sleep(100);
  }
}
console.log(`  insert ${insDone}/${agg.size} done`);
await sleep(500);

console.log("[Rebuild] Done.");
process.exit(0);
