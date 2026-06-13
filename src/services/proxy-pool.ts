import { db, call, type ProxyPoolEntry } from "../db/index";

interface CachedProxy {
  id: bigint;
  url: string;
  type: string;
}

// ── Proxy list cache ────────────────────────────────────────────────
let cachedProxies: CachedProxy[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000;

async function refreshCache(): Promise<CachedProxy[]> {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL_MS && cachedProxies.length > 0) {
    return cachedProxies;
  }

  const rows = db.proxyPool.getActive();
  cachedProxies = rows.map((r) => ({ id: r.id, url: r.url, type: r.proxyType }));
  cacheTimestamp = now;
  return cachedProxies;
}

export function invalidateProxyCache() {
  cacheTimestamp = 0;
}

// ── Proxy pool settings cache ───────────────────────────────────────
type ProxyUsage = "all" | "model" | "auth";
type ProxyRotation = "round_robin" | "sequential";

interface ProxyPoolSettings {
  usage: ProxyUsage;
  rotation: ProxyRotation;
}

let settingsCache: ProxyPoolSettings = { usage: "all", rotation: "round_robin" };
let settingsCacheTs = 0;
const SETTINGS_CACHE_TTL_MS = 10_000;

async function getProxyPoolSettings(): Promise<ProxyPoolSettings> {
  const now = Date.now();
  if (now - settingsCacheTs < SETTINGS_CACHE_TTL_MS) return settingsCache;

  const usageVal = db.settings.get("proxy_pool_usage");
  const rotationVal = db.settings.get("proxy_pool_rotation");

  let usage: ProxyUsage = "all";
  let rotation: ProxyRotation = "round_robin";

  if (usageVal === "all" || usageVal === "model" || usageVal === "auth") {
    usage = usageVal;
  }
  if (rotationVal === "round_robin" || rotationVal === "sequential") {
    rotation = rotationVal;
  }

  settingsCache = { usage, rotation };
  settingsCacheTs = now;
  return settingsCache;
}

export function invalidateProxySettingsCache() {
  settingsCacheTs = 0;
}

// ── Rotation state ──────────────────────────────────────────────────
let roundRobinIndex = 0;
let sequentialIndex = 0;

// ── Core: get next proxy ────────────────────────────────────────────
/**
 * Get the next proxy from the pool.
 *
 * @param purpose - What the proxy will be used for: `"model"` (upstream API
 *   calls) or `"auth"` (login automation). If the pool's usage setting
 *   doesn't include this purpose, returns `null`.
 * @param type - Optional protocol filter (`"http"` or `"socks5"`).
 */
export async function getNextProxy(
  purpose: "model" | "auth" = "model",
  type?: "http" | "socks5",
): Promise<{ id: bigint; url: string } | null> {
  const cfg = await getProxyPoolSettings();

  // Check if proxy pool is enabled for this purpose
  if (cfg.usage !== "all" && cfg.usage !== purpose) return null;

  const proxies = await refreshCache();
  const filtered = type ? proxies.filter((p) => p.type === type) : proxies;
  if (filtered.length === 0) return null;

  let proxy: CachedProxy | undefined;

  if (cfg.rotation === "sequential") {
    // Sequential: stick with current index, only advance on failure
    if (sequentialIndex >= filtered.length) sequentialIndex = 0;
    proxy = filtered[sequentialIndex];
  } else {
    // Round-robin (default)
    const index = roundRobinIndex % filtered.length;
    roundRobinIndex = (roundRobinIndex + 1) % Number.MAX_SAFE_INTEGER;
    proxy = filtered[index];
  }

  if (!proxy) return null;

  // Update lastUsedAt in background via reducer
  void call.updateProxyStats({
    id: proxy.id,
    successCount: BigInt(0),
    failCount: BigInt(0),
    lastUsedAt: BigInt(Date.now()),
    lastCheckedAt: null,
    latencyMs: null,
    status: "active",
    errorMessage: null,
  });

  return { id: proxy.id, url: proxy.url };
}

/**
 * Advance the sequential index (call on proxy failure so the next call
 * picks a different proxy).
 */
export function advanceSequentialIndex() {
  sequentialIndex++;
}

// ── Success / Fail tracking ─────────────────────────────────────────
export async function markProxySuccess(id: bigint) {
  // Read current stats from cache to increment
  const all = db.proxyPool.getAll();
  const entry = all.find((p) => p.id === id);
  const currentSuccess = entry?.successCount ?? BigInt(0);

  await call.updateProxyStats({
    id,
    successCount: currentSuccess + BigInt(1),
    failCount: entry?.failCount ?? BigInt(0),
    lastUsedAt: BigInt(Date.now()),
    lastCheckedAt: null,
    latencyMs: null,
    status: "active",
    errorMessage: null,
  });
}

export async function markProxyFail(id: bigint, error?: string) {
  const all = db.proxyPool.getAll();
  const entry = all.find((p) => p.id === id);
  const currentFail = entry?.failCount ?? BigInt(0);

  await call.updateProxyStats({
    id,
    successCount: entry?.successCount ?? BigInt(0),
    failCount: currentFail + BigInt(1),
    lastUsedAt: null,
    lastCheckedAt: null,
    latencyMs: null,
    status: "active",
    errorMessage: error || null,
  });

  // In sequential mode, advance to next proxy on failure
  advanceSequentialIndex();
}

// ── Health check ────────────────────────────────────────────────────
export async function checkProxyHealth(proxyUrl: string): Promise<{ ok: boolean; latencyMs: number; error?: string; ip?: string }> {
  const start = Date.now();
  try {
    const proc = Bun.spawn(
      ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}|%{remote_ip}", "--proxy", proxyUrl, "--max-time", "10", "https://httpbin.org/ip"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    const latencyMs = Date.now() - start;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { ok: false, latencyMs, error: stderr.trim() || `curl exit ${exitCode}` };
    }

    const [statusCode, ip] = stdout.trim().split("|");
    if (statusCode === "200") {
      return { ok: true, latencyMs, ip };
    }
    return { ok: false, latencyMs, error: `HTTP ${statusCode}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}
