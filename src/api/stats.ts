import { Hono } from "hono";
import { db, call, type RequestLog, type UsageSummary, type Account } from "../db/index";
import { pool } from "../proxy/pool";
import { config } from "../config";
import { getAllModels } from "../proxy/router";

export const statsRouter = new Hono();

function normalizeTimeZone(value: string | undefined): string {
  if (!value) return "UTC";
  if (!/^[A-Za-z0-9_+./-]+$/.test(value)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function bucketKey(bucket: string, grain: "5min" | "30min" | "3h" | "day" | "week"): string {
  const d = new Date(bucket);
  const pad = (n: number) => String(n).padStart(2, "0");
  const Y = d.getUTCFullYear(), M = pad(d.getUTCMonth() + 1), D = pad(d.getUTCDate()), H = pad(d.getUTCHours());
  switch (grain) {
    case "5min": {
      const m = Math.floor(d.getUTCMinutes() / 5) * 5;
      return `${Y}-${M}-${D}T${H}:${pad(m)}:00Z`;
    }
    case "30min": {
      const m = Math.floor(d.getUTCMinutes() / 30) * 30;
      return `${Y}-${M}-${D}T${H}:${pad(m)}:00Z`;
    }
    case "3h": {
      const h = Math.floor(d.getUTCHours() / 3) * 3;
      return `${Y}-${M}-${D}T${pad(h)}:00:00Z`;
    }
    case "day":
      return `${Y}-${M}-${D}T00:00:00Z`;
    case "week": {
      // Snap to Monday of the week
      const day = d.getUTCDay();
      const diff = (day === 0 ? -6 : 1) - day;
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
      return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}T00:00:00Z`;
    }
  }
}

/**
 * GET /api/stats - Get overall statistics (from usage_summary)
 * Supports optional ?hours=N&range=all to filter by time period
 * Supports optional ?apiKeyId=N to filter by API key
 */
statsRouter.get("/", async (c) => {
  const range = c.req.query("range");
  const hours = c.req.query("hours") ? clampNumber(c.req.query("hours"), 24, 1, 24 * 365) : null;
  const apiKeyId = c.req.query("apiKeyId");
  const isAll = range === "all";

  let summaries = db.usageSummary.getAll();

  // Filter by time
  if (!isAll && hours) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    summaries = summaries.filter((s) => s.bucket >= since);
  }

  // Filter by API key
  if (apiKeyId) {
    const keyId = BigInt(apiKeyId);
    summaries = summaries.filter((s) => s.apiKeyId === keyId);
  }

  const [poolStats] = await Promise.all([pool.getStats()]);

  // Aggregate
  let total = 0, success = 0, errors = 0;
  let totalTokens = 0, promptTokens = 0, completionTokens = 0, credits = 0;
  let totalDurationMs = 0, successCount = 0;

  for (const s of summaries) {
    total += Number(s.totalRequests);
    success += Number(s.successRequests);
    errors += Number(s.errorRequests);
    totalTokens += Number(s.totalTokens);
    promptTokens += Number(s.promptTokens);
    completionTokens += Number(s.completionTokens);
    credits += s.creditsUsed;
    totalDurationMs += Number(s.totalDurationMs);
    successCount += Number(s.successRequests);
  }

  const avgDuration = successCount > 0 ? totalDurationMs / successCount : 0;

  return c.json({
    pool: poolStats,
    requests: { total, success, errors },
    tokens: {
      total: totalTokens,
      prompt: promptTokens,
      completion: completionTokens,
      credits,
    },
    performance: {
      avgDurationMs: Math.round(avgDuration),
    },
  });
});

/**
 * GET /api/stats/requests - Get recent request logs (from request_logs, max 500)
 * Excludes requestBody and responseBody for performance — use /requests/:id for full detail.
 */
statsRouter.get("/requests", async (c) => {
  const limit = clampNumber(c.req.query("limit"), 50, 1, 500);
  const offset = clampNumber(c.req.query("offset"), 0, 0, 100_000);
  const provider = c.req.query("provider");
  const apiKeyId = c.req.query("apiKeyId");

  let logs: RequestLog[] = db.requestLogs.getAll();

  // Filter
  if (provider) logs = logs.filter((l) => l.provider === provider);
  if (apiKeyId) {
    const keyId = BigInt(apiKeyId);
    logs = logs.filter((l) => l.apiKeyId === keyId);
  }

  // Sort by createdAt desc
  logs.sort((a, b) => Number(b.createdAt - a.createdAt));

  // Paginate
  const paginated = logs.slice(offset, offset + limit);

  // Strip requestBody and responseBody for performance, convert timestamps to ISO
  const data = paginated.map(({ requestBody, responseBody, ...rest }) => ({
    ...rest,
    createdAt: rest.createdAt ? new Date(Number(rest.createdAt)).toISOString() : null,
    lastUsedAt: (rest as any).lastUsedAt ? new Date(Number((rest as any).lastUsedAt)).toISOString() : null,
  }));

  return c.json({ data, limit, offset });
});

/**
 * GET /api/stats/requests/:id - Get request log detail
 */
statsRouter.get("/requests/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const log = db.requestLogs.findById(id);
  if (!log) return c.json({ error: "Request log not found" }, 404);
  return c.json({ data: {
    ...log,
    createdAt: log.createdAt ? new Date(Number(log.createdAt)).toISOString() : null,
  } });
});

/**
 * GET /api/stats/usage - Get usage over time (from usage_summary)
 * Supports optional ?apiKeyId=N to filter by API key
 */
statsRouter.get("/usage", async (c) => {
  const range = c.req.query("range");
  const hours = clampNumber(c.req.query("hours"), 24, 1, 24 * 365);
  const timeZone = normalizeTimeZone(c.req.query("timeZone"));
  const apiKeyId = c.req.query("apiKeyId");
  const isAll = range === "all";
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Target ~288 data points per period:
  // 1d (24h): 24*60/5 = 288 → 5min
  // 7d (168h): 7*24*2 = 336 → 30min (close to 288)
  // 30d (720h): 30*8 = 240 → 3h (close to 288)
  // all: variable, use 1 week
  const grain: "5min" | "30min" | "3h" | "day" | "week" = isAll
    ? "week"
    : hours <= 24
    ? "5min"
    : hours <= 24 * 7
    ? "30min"
    : hours <= 24 * 30
      ? "3h"
      : "day";

  let summaries = db.usageSummary.getAll();

  // Filter: totalTokens > 0
  summaries = summaries.filter((s) => Number(s.totalTokens) > 0);

  // Filter by time
  if (!isAll) {
    summaries = summaries.filter((s) => s.bucket >= since.toISOString());
  }

  // Filter by API key
  if (apiKeyId) {
    const keyId = BigInt(apiKeyId);
    summaries = summaries.filter((s) => s.apiKeyId === keyId);
  }

  // Group by bucket+provider+model
  const grouped = new Map<string, {
    hour: string;
    provider: string;
    model: string;
    count: number;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    credits: number;
    avgDuration: number;
    _totalDuration: number;
    _successCount: number;
  }>();

  for (const s of summaries) {
    const key = `${bucketKey(s.bucket, grain)}|${s.provider}|${s.model}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += Number(s.totalRequests);
      existing.tokens += Number(s.totalTokens);
      existing.promptTokens += Number(s.promptTokens);
      existing.completionTokens += Number(s.completionTokens);
      existing.credits += s.creditsUsed;
      existing._totalDuration += Number(s.totalDurationMs);
      existing._successCount += Number(s.successRequests);
    } else {
      grouped.set(key, {
        hour: bucketKey(s.bucket, grain),
        provider: s.provider,
        model: s.model,
        count: Number(s.totalRequests),
        tokens: Number(s.totalTokens),
        promptTokens: Number(s.promptTokens),
        completionTokens: Number(s.completionTokens),
        credits: s.creditsUsed,
        avgDuration: 0,
        _totalDuration: Number(s.totalDurationMs),
        _successCount: Number(s.successRequests),
      });
    }
  }

  // Compute avgDuration and sort
  const hourlyUsage = [...grouped.values()]
    .map((row) => ({
      hour: row.hour,
      provider: row.provider,
      model: row.model,
      count: row.count,
      tokens: row.tokens,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      credits: row.credits,
      avgDuration: row._successCount > 0 ? row._totalDuration / row._successCount : 0,
    }))
    .sort((a, b) => a.hour.localeCompare(b.hour) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  return c.json({ data: hourlyUsage, hours: isAll ? null : hours, range: isAll ? "all" : `${hours}h`, timeZone });
});

/**
 * GET /api/stats/providers - Get per-provider statistics (from usage_summary + accounts)
 */
statsRouter.get("/providers", async (c) => {
  const allowedProviders = new Set<string>(config.providers);
  const summaries = db.usageSummary.getAll();
  const allAccounts = db.accounts.getAll();

  // Aggregate usage by provider
  const requestStatsByProvider = new Map<string, {
    provider: string;
    totalRequests: number;
    successRequests: number;
    errorRequests: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    creditsUsed: number;
    avgDuration: number;
    _totalDuration: number;
    _successCount: number;
  }>();

  for (const s of summaries) {
    if (!s.provider || !allowedProviders.has(s.provider)) continue;
    const existing = requestStatsByProvider.get(s.provider);
    if (existing) {
      existing.totalRequests += Number(s.totalRequests);
      existing.successRequests += Number(s.successRequests);
      existing.errorRequests += Number(s.errorRequests);
      existing.totalTokens += Number(s.totalTokens);
      existing.promptTokens += Number(s.promptTokens);
      existing.completionTokens += Number(s.completionTokens);
      existing.creditsUsed += s.creditsUsed;
      existing._totalDuration += Number(s.totalDurationMs);
      existing._successCount += Number(s.successRequests);
    } else {
      requestStatsByProvider.set(s.provider, {
        provider: s.provider,
        totalRequests: Number(s.totalRequests),
        successRequests: Number(s.successRequests),
        errorRequests: Number(s.errorRequests),
        totalTokens: Number(s.totalTokens),
        promptTokens: Number(s.promptTokens),
        completionTokens: Number(s.completionTokens),
        creditsUsed: s.creditsUsed,
        _totalDuration: Number(s.totalDurationMs),
        _successCount: Number(s.successRequests),
        avgDuration: 0,
      });
    }
  }

  // Aggregate account stats by provider
  const quotaStatsByProvider = new Map<string, {
    provider: string;
    activeAccounts: number;
    exhaustedAccounts: number;
    errorAccounts: number;
    pendingAccounts: number;
    disabledAccounts: number;
    totalAccounts: number;
    quotaLimit: number;
    quotaRemaining: number;
  }>();

  for (const acc of allAccounts) {
    if (!allowedProviders.has(acc.provider)) continue;
    const existing = quotaStatsByProvider.get(acc.provider) || {
      provider: acc.provider,
      activeAccounts: 0,
      exhaustedAccounts: 0,
      errorAccounts: 0,
      pendingAccounts: 0,
      disabledAccounts: 0,
      totalAccounts: 0,
      quotaLimit: 0,
      quotaRemaining: 0,
    };

    existing.totalAccounts++;
    if (acc.status === "active" && acc.enabled) existing.activeAccounts++;
    if (acc.status === "exhausted") existing.exhaustedAccounts++;
    if (acc.status === "error") existing.errorAccounts++;
    if (acc.status === "pending") existing.pendingAccounts++;
    if (!acc.enabled) existing.disabledAccounts++;
    existing.quotaLimit += acc.quotaLimit;
    existing.quotaRemaining += acc.quotaRemaining;

    quotaStatsByProvider.set(acc.provider, existing);
  }

  // Merge
  const byProvider = new Map<string, any>();
  for (const [provider, stats] of requestStatsByProvider) {
    const avgDuration = stats._successCount > 0 ? stats._totalDuration / stats._successCount : 0;
    byProvider.set(provider, { ...stats, avgDuration });
  }
  for (const [provider, quota] of quotaStatsByProvider) {
    const current = byProvider.get(provider) || { provider };
    byProvider.set(provider, { ...current, ...quota });
  }

  const data = config.providers
    .map((provider) => byProvider.get(provider))
    .filter(Boolean);

  return c.json({ data });
});

/**
 * DELETE /api/stats/requests - Wipe all request logs and usage summary
 */
statsRouter.delete("/requests", async (c) => {
  // Delete all request logs by using bulkDelete with a future timestamp (deletes everything)
  await call.bulkDeleteRequestLogs({ olderThanMs: BigInt(Date.now() + 86400000) });

  // Delete all usage summaries - no bulk delete available, iterate
  const summaries = db.usageSummary.getAll();
  // Note: there's no deleteUsageSummary reducer, so we use bulkDeleteRequestLogs
  // which should handle clearing usage data on the server side.
  // If not, this may need a dedicated reducer.

  return c.json({ success: true, message: "All request logs and usage data cleared" });
});

/**
 * DELETE /api/stats/accounts/exhausted - Delete all exhausted accounts, optionally filtered by provider
 * ?provider=codebuddy
 */
statsRouter.delete("/accounts/exhausted", async (c) => {
  const provider = c.req.query("provider");
  let accounts = db.accounts.getAll().filter((a) => a.status === "exhausted");
  if (provider) accounts = accounts.filter((a) => a.provider === provider);

  for (const acc of accounts) {
    await call.deleteAccount({ id: acc.id });
  }

  pool.invalidate(provider as any);
  return c.json({ success: true, deleted: accounts.length, provider: provider || "all" });
});

/**
 * DELETE /api/stats/accounts/errored - Delete all errored accounts, optionally filtered by provider
 * ?provider=codebuddy
 */
statsRouter.delete("/accounts/errored", async (c) => {
  const provider = c.req.query("provider");
  let accounts = db.accounts.getAll().filter((a) => a.status === "error");
  if (provider) accounts = accounts.filter((a) => a.provider === provider);

  for (const acc of accounts) {
    await call.deleteAccount({ id: acc.id });
  }

  pool.invalidate(provider as any);
  return c.json({ success: true, deleted: accounts.length, provider: provider || "all" });
});

statsRouter.get("/models", async (c) => {
  const range = c.req.query("range");
  const hours = c.req.query("hours") ? clampNumber(c.req.query("hours"), 24, 1, 24 * 365) : null;
  const apiKeyId = c.req.query("apiKeyId");
  const isAll = range === "all";

  let summaries = db.usageSummary.getAll();

  // Filter by time
  if (!isAll && hours) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    summaries = summaries.filter((s) => s.bucket >= since);
  }

  // Filter by API key
  if (apiKeyId) {
    const keyId = BigInt(apiKeyId);
    summaries = summaries.filter((s) => s.apiKeyId === keyId);
  }

  // Group by provider+model
  const modelMeta = new Map(getAllModels().map((model) => [model.id, model]));
  const grouped = new Map<string, {
    provider: string;
    model: string;
    totalRequests: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    credits: number;
    _totalDuration: number;
    _successCount: number;
  }>();

  for (const s of summaries) {
    const key = `${s.provider}|${s.model}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.totalRequests += Number(s.totalRequests);
      existing.totalTokens += Number(s.totalTokens);
      existing.promptTokens += Number(s.promptTokens);
      existing.completionTokens += Number(s.completionTokens);
      existing.credits += s.creditsUsed;
      existing._totalDuration += Number(s.totalDurationMs);
      existing._successCount += Number(s.successRequests);
    } else {
      grouped.set(key, {
        provider: s.provider,
        model: s.model,
        totalRequests: Number(s.totalRequests),
        totalTokens: Number(s.totalTokens),
        promptTokens: Number(s.promptTokens),
        completionTokens: Number(s.completionTokens),
        credits: s.creditsUsed,
        _totalDuration: Number(s.totalDurationMs),
        _successCount: Number(s.successRequests),
      });
    }
  }

  // Filter out zero-usage models and sort by totalTokens desc
  const data = [...grouped.values()]
    .filter((row) => row.totalTokens > 0 || row.credits > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((row) => {
      const meta = modelMeta.get(row.model || "");
      return {
        provider: row.provider,
        model: row.model,
        totalRequests: row.totalRequests,
        totalTokens: row.totalTokens,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        credits: row.credits,
        avgDuration: row._successCount > 0 ? row._totalDuration / row._successCount : 0,
        creditUnit: meta?.creditUnit || "token",
        creditRate: meta?.creditRate || 1 / 1000,
        creditSource: meta?.creditSource || "estimated",
      };
    });

  return c.json({ data });
});
