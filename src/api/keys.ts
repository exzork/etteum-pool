import { Hono } from "hono";
import { db, call, type ApiKey } from "../db/index";
import { config } from "../config";

export const keysRouter = new Hono();

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `sk-pool-${token}`;
}

export interface ResolvedApiKey {
  id: number;
  name: string;
  key: string;
}

/**
 * Validate an API key and return its metadata if valid.
 * Checks both the env-configured key and all DB keys.
 */
export async function resolveApiKey(token: string): Promise<ResolvedApiKey | null> {
  if (!token) return null;

  // Check env-configured key (legacy single key)
  if (token === config.apiKey) {
    return { id: 0, name: "default", key: token };
  }

  // Check DB keys
  const row = db.apiKeys.findByKey(token);
  if (row) {
    return { id: Number(row.id), name: row.name, key: row.key };
  }

  return null;
}

export async function isValidApiKey(token: string): Promise<boolean> {
  return (await resolveApiKey(token)) !== null;
}

/**
 * No-op: SpacetimeDB handles schema automatically.
 * Kept for backward compatibility with startup code.
 */
export function ensureApiKeysTable() {
  // No-op — SpacetimeDB manages the schema
}

// ── CRUD Routes ──────────────────────────────────────────────────

/** GET /api/keys - List all API keys */
keysRouter.get("/", async (c) => {
  const rows = db.apiKeys.getAll();
  // Also include the env key as "default" if it exists
  const envKey = config.apiKey;
  const all = [
    { id: 0, name: "default", key: envKey, source: "env", createdAt: null },
    ...rows.map((r) => ({ id: Number(r.id), name: r.name, key: r.key, createdAt: Number(r.createdAt), source: "database" })),
  ];
  return c.json({ data: all });
});

/** POST /api/keys - Create a new API key */
keysRouter.post("/", async (c) => {
  const body = await c.req.json<{ name: string; key?: string }>();
  if (!body.name || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }

  const key = body.key && body.key.length >= 16 ? body.key : generateApiKey();
  // id=0n signals "create new" — the autoInc primary key assigns the real ID server-side.
  await call.upsertApiKey({ id: 0n, name: body.name.trim(), key });
  // Look up the row we just inserted (uniqueness on `key`) so we can return its real ID.
  const created = db.apiKeys.findByKey(key);
  return c.json(
    {
      data: {
        id: created ? Number(created.id) : 0,
        name: body.name.trim(),
        key,
      },
    },
    201,
  );
});

/** PUT /api/keys/:id - Update key name */
keysRouter.put("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  if (id === 0n) return c.json({ error: "Cannot modify the default env key" }, 400);

  const body = await c.req.json<{ name?: string }>();
  if (!body.name || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }

  const existing = db.apiKeys.findById(id);
  if (!existing) return c.json({ error: "Key not found" }, 404);

  await call.upsertApiKey({ id, name: body.name.trim(), key: existing.key });
  return c.json({ data: { id: Number(id), name: body.name.trim(), key: existing.key } });
});

/** DELETE /api/keys/:id - Delete an API key */
keysRouter.delete("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  if (id === 0n) return c.json({ error: "Cannot delete the default env key" }, 400);

  const existing = db.apiKeys.findById(id);
  if (!existing) return c.json({ error: "Key not found" }, 404);

  await call.deleteApiKey({ id });
  return c.json({ success: true });
});

/** POST /api/keys/regenerate/:id - Regenerate a key's secret */
keysRouter.post("/regenerate/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  if (id === 0n) return c.json({ error: "Cannot regenerate the default env key" }, 400);

  const existing = db.apiKeys.findById(id);
  if (!existing) return c.json({ error: "Key not found" }, 404);

  const key = generateApiKey();
  await call.upsertApiKey({ id, name: existing.name, key });
  return c.json({ data: { id: Number(id), name: existing.name, key } });
});

/** POST /api/keys/test - Validate a key (no auth required) */
keysRouter.post("/test", async (c) => {
  const body = await c.req.json<{ key: string }>();
  const resolved = await resolveApiKey(body.key || "");
  return c.json({ valid: resolved !== null, name: resolved?.name || null });
});
