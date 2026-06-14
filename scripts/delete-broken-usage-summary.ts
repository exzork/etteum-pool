/**
 * Delete the historical broken usage_summary rows.
 *
 * Context: the old upsertUsageSummary reducer overwrote rows with per-request
 * deltas instead of accumulating them, so any bucket it touched ended up with
 * just "1 last request" worth of stats. request_logs is pruned to ~1 hour, so
 * the deltas are gone — those rows can't be reconstructed.
 *
 * The recent rebuild script (rebuild-usage-summary.ts) already restored the
 * last hour from request_logs, so we keep any row whose bucket is covered by
 * a row in request_logs, and delete the rest.
 *
 * Usage: bun run scripts/delete-broken-usage-summary.ts
 *   DRY_RUN=1 to preview without mutating
 */
import { DbConnection } from "../src/stdb/bindings";

const STDB_HOST = process.env.STDB_HOST || "https://stdb.exzork.me";
const STDB_DATABASE = process.env.STDB_DATABASE || "etteum-pool";
const DRY_RUN = process.env.DRY_RUN === "1";

console.log(`[Cleanup] SpacetimeDB: ${STDB_HOST} / ${STDB_DATABASE}`);
if (DRY_RUN) console.log("[Cleanup] DRY_RUN=1 — no mutations will be sent");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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
      console.log(`[Cleanup] Connected. Identity: ${identity}`);
      const sub = connection.subscriptionBuilder();
      sub.onApplied(() => {
        console.log("[Cleanup] Subscription ready");
        resolve(connection);
      });
      sub.onError((_ctx: any, err: any) => reject(err));
      sub.subscribeToAllTables();
    })
    .onConnectError((_ctx: any, err: any) => reject(err))
    .onDisconnect(() => {})
    .build();
});

// Buckets covered by request_logs (i.e. trustworthy after the rebuild).
const trustedBuckets = new Set<string>();
for (const row of conn.db.requestLogs.iter()) {
  trustedBuckets.add(bucketIso(row.createdAt));
}
console.log(
  `[Cleanup] ${trustedBuckets.size} buckets covered by request_logs (will be kept)`,
);

// Everything else in usage_summary is unrecoverable broken history.
const toDelete: { id: bigint; bucket: string; provider: string; model: string }[] = [];
for (const row of conn.db.usageSummary.iter()) {
  if (!trustedBuckets.has(row.bucket)) {
    toDelete.push({
      id: row.id,
      bucket: row.bucket,
      provider: row.provider,
      model: row.model,
    });
  }
}

console.log(`[Cleanup] ${toDelete.length} broken usage_summary rows to delete`);

if (toDelete.length === 0) {
  console.log("[Cleanup] Nothing to do.");
  process.exit(0);
}

// Show oldest/newest bucket as a sanity check
toDelete.sort((a, b) => a.bucket.localeCompare(b.bucket));
console.log(
  `[Cleanup] Affected bucket range: ${toDelete[0].bucket} → ${toDelete[toDelete.length - 1].bucket}`,
);

if (DRY_RUN) {
  console.log("[Cleanup] DRY_RUN — exiting without mutations");
  process.exit(0);
}

console.log(`[Cleanup] Deleting ${toDelete.length} rows...`);
let done = 0;
for (const r of toDelete) {
  conn.reducers.deleteUsageSummary({ id: r.id });
  done++;
  if (done % 50 === 0) {
    process.stdout.write(`  delete ${done}/${toDelete.length}\r`);
    await sleep(100);
  }
}
console.log(`  delete ${done}/${toDelete.length} done`);
await sleep(500);

console.log("[Cleanup] Done.");
process.exit(0);
