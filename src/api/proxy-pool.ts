import { Hono } from "hono";
import { db, call, type ProxyPoolEntry } from "../db/index";
import {
  getNextProxy,
  markProxySuccess,
  markProxyFail,
  checkProxyHealth,
  invalidateProxyCache,
} from "../services/proxy-pool";
import {
  scrapeProxies,
  verifyProxies,
  COUNTRIES,
  type ScrapeSource,
  type ScrapeProtocol,
} from "../services/proxy-scraper";

export const proxyPoolRouter = new Hono();

proxyPoolRouter.get("/pool", async (c) => {
  const proxies = db.proxyPool.getAll().sort((a, b) => Number(b.createdAt - a.createdAt));

  return c.json({
    count: proxies.length,
    activeCount: proxies.filter((p) => p.status === "active").length,
    proxies,
  });
});

proxyPoolRouter.post("/pool", async (c) => {
  const body = await c.req.json<{ proxies: string[] }>();
  if (!Array.isArray(body.proxies) || body.proxies.length === 0) {
    return c.json({ error: "proxies must be a non-empty array of URLs" }, 400);
  }

  let added = 0;
  for (const url of body.proxies) {
    const trimmed = url.trim();
    if (!trimmed) continue;

    const proxyType = trimmed.startsWith("socks5://") ? "socks5" : "http";
    const label = new URL(trimmed).hostname || trimmed;

    await call.upsertProxy({
      id: BigInt(Date.now() + added),
      url: trimmed,
      proxyType,
      label,
      status: "active",
      latencyMs: null,
      errorMessage: null,
    });
    added++;
  }

  invalidateProxyCache();
  return c.json({ added });
});

proxyPoolRouter.put("/pool/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const body = await c.req.json<{ status?: string; label?: string }>();

  const existing = db.proxyPool.getAll().find((p) => p.id === id);
  if (!existing) return c.json({ error: "Proxy not found" }, 404);

  await call.upsertProxy({
    id,
    url: existing.url,
    proxyType: existing.proxyType,
    label: body.label !== undefined ? body.label : (existing.label ?? null),
    status: body.status || existing.status,
    latencyMs: existing.latencyMs ?? null,
    errorMessage: existing.errorMessage ?? null,
  });

  invalidateProxyCache();
  return c.json({ success: true });
});

proxyPoolRouter.delete("/pool/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  await call.deleteProxy({ id });
  invalidateProxyCache();
  return c.json({ success: true });
});

proxyPoolRouter.delete("/pool", async (c) => {
  const allProxies = db.proxyPool.getAll();
  for (const proxy of allProxies) {
    await call.deleteProxy({ id: proxy.id });
  }
  invalidateProxyCache();
  return c.json({ success: true });
});

proxyPoolRouter.post("/pool/:id/check", async (c) => {
  const id = BigInt(c.req.param("id"));
  const proxy = db.proxyPool.getAll().find((p) => p.id === id);
  if (!proxy) return c.json({ error: "Proxy not found" }, 404);

  const result = await checkProxyHealth(proxy.url);

  await call.updateProxyStats({
    id,
    successCount: proxy.successCount,
    failCount: proxy.failCount,
    lastUsedAt: proxy.lastUsedAt ?? null,
    lastCheckedAt: BigInt(Date.now()),
    latencyMs: result.latencyMs != null ? BigInt(result.latencyMs) : null,
    status: result.ok ? "active" : "error",
    errorMessage: result.error || null,
  });

  invalidateProxyCache();
  return c.json({ id: Number(id), ...result });
});

proxyPoolRouter.post("/pool/check-all", async (c) => {
  const proxies = db.proxyPool.getActive();

  const results = await Promise.allSettled(
    proxies.map(async (proxy) => {
      const result = await checkProxyHealth(proxy.url);
      await call.updateProxyStats({
        id: proxy.id,
        successCount: proxy.successCount,
        failCount: proxy.failCount,
        lastUsedAt: proxy.lastUsedAt ?? null,
        lastCheckedAt: BigInt(Date.now()),
        latencyMs: result.latencyMs != null ? BigInt(result.latencyMs) : null,
        status: result.ok ? "active" : "error",
        errorMessage: result.error || null,
      });
      return { id: Number(proxy.id), url: proxy.url, ...result };
    })
  );

  invalidateProxyCache();
  return c.json({
    checked: results.length,
    results: results.map((r) => (r.status === "fulfilled" ? r.value : { error: "check failed" })),
  });
});

// List the regions available for scraping (for the dashboard dropdown).
proxyPoolRouter.get("/scrape/countries", (c) => {
  return c.json({ countries: COUNTRIES });
});

// Scrape proxies from free sources, optionally filtered by region/protocol,
// optionally health-verified, then add the survivors to the pool.
proxyPoolRouter.post("/scrape", async (c) => {
  const body = await c.req.json<{
    source?: ScrapeSource;
    country?: string;
    protocol?: ScrapeProtocol;
    limit?: number;
    verify?: boolean;
  }>().catch(() => ({} as Record<string, never>));

  const source = (body.source ?? "all") as ScrapeSource;
  const country = body.country ?? "all";
  const protocol = (body.protocol ?? "all") as ScrapeProtocol;
  const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
  const verify = body.verify !== false; // verify by default

  let scraped = await scrapeProxies({ source, country, protocol, limit });
  const scrapedCount = scraped.length;

  if (scrapedCount === 0) {
    return c.json({ scraped: 0, verified: 0, added: 0, skipped: 0, proxies: [] });
  }

  // Health-check before adding so the pool only gets working proxies.
  let verifiedCount = scrapedCount;
  if (verify) {
    scraped = await verifyProxies(scraped);
    verifiedCount = scraped.length;
  }

  // Skip proxies already in the pool (dedupe by URL).
  const existingProxies = db.proxyPool.getAll();
  const existingSet = new Set(existingProxies.map((e) => e.url));

  const toInsert = scraped.filter((p) => !existingSet.has(p.url));
  if (toInsert.length > 0) {
    const baseTs = Date.now();
    for (let i = 0; i < toInsert.length; i++) {
      const p = toInsert[i];
      await call.upsertProxy({
        id: BigInt(baseTs + i),
        url: p.url,
        proxyType: p.type,
        label: p.country ? `scraped:${p.country}` : "scraped",
        status: "active",
        latencyMs: null,
        errorMessage: null,
      });
    }
    invalidateProxyCache();
  }

  return c.json({
    scraped: scrapedCount,
    verified: verifiedCount,
    added: toInsert.length,
    skipped: verifiedCount - toInsert.length,
  });
});
