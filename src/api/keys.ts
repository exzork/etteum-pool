import { Hono } from "hono";
import { db } from "../db/index";
import { client } from "../db/index";
import { apiKeys } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { emitDelta } from "../sync/index";

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
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.key, token));
  if (row) {
    return { id: row.id, name: row.name, key: row.key };
  }

  return null;
}

export async function isValidApiKey(token: string): Promise<boolean> {
  return (await resolveApiKey(token)) !== null;
}

/**
 * Ensure the api_keys table and new columns exist (idempotent).
 * Called on startup before any key operations.
 */
export function ensureApiKeysTable() {
  client.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  // Add api_key_id and api_key_name columns to request_logs if missing
  try { client.exec(`ALTER TABLE request_logs ADD COLUMN api_key_id INTEGER`); } catch {}
  try { client.exec(`ALTER TABLE request_logs ADD COLUMN api_key_name TEXT`); } catch {}
  // Add api_key_id and api_key_name columns to usage_summary if missing
  try { client.exec(`ALTER TABLE usage_summary ADD COLUMN api_key_id INTEGER`); } catch {}
  try { client.exec(`ALTER TABLE usage_summary ADD COLUMN api_key_name TEXT`); } catch {}
  // Add index on api_key_id for request_logs
  try { client.exec(`CREATE INDEX IF NOT EXISTS request_logs_api_key_idx ON request_logs(api_key_id)`); } catch {}
  try { client.exec(`CREATE INDEX IF NOT EXISTS usage_summary_api_key_idx ON usage_summary(api_key_id)`); } catch {}
  // Migrate unique index to include api_key_id (set NULL → 0 first, then recreate index)
  try {
    client.exec(`UPDATE usage_summary SET api_key_id = 0 WHERE api_key_id IS NULL`);
    client.exec(`DROP INDEX IF EXISTS usage_summary_bucket_provider_model_idx`);
    client.exec(`CREATE UNIQUE INDEX IF NOT EXISTS usage_summary_bucket_provider_model_key_idx ON usage_summary(bucket, provider, model, api_key_id)`);
  } catch {}
}

// ── CRUD Routes ──────────────────────────────────────────────────

/** GET /api/keys - List all API keys */
keysRouter.get("/", async (c) => {
  const rows = await db.select().from(apiKeys);
  // Also include the env key as "default" if it exists
  const envKey = config.apiKey;
  const all = [
    { id: 0, name: "default", key: envKey, source: "env", createdAt: null },
    ...rows.map((r) => ({ ...r, source: "database" })),
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
  const [row] = await db.insert(apiKeys).values({ name: body.name.trim(), key }).returning();
  emitDelta("api_keys", "upsert", row as Record<string, unknown>);
  return c.json({ data: row }, 201);
});

/** PUT /api/keys/:id - Update key name */
keysRouter.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === 0) return c.json({ error: "Cannot modify the default env key" }, 400);

  const body = await c.req.json<{ name?: string }>();
  if (!body.name || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }

  const [updated] = await db
    .update(apiKeys)
    .set({ name: body.name.trim() })
    .where(eq(apiKeys.id, id))
    .returning();

  if (!updated) return c.json({ error: "Key not found" }, 404);
  return c.json({ data: updated });
});

/** DELETE /api/keys/:id - Delete an API key */
keysRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === 0) return c.json({ error: "Cannot delete the default env key" }, 400);

  const deleted = await db.delete(apiKeys).where(eq(apiKeys.id, id)).returning();
  if (deleted.length === 0) return c.json({ error: "Key not found" }, 404);
  emitDelta("api_keys", "delete", { id });
  return c.json({ success: true });
});

/** POST /api/keys/regenerate/:id - Regenerate a key's secret */
keysRouter.post("/regenerate/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === 0) return c.json({ error: "Cannot regenerate the default env key" }, 400);

  const key = generateApiKey();
  const [updated] = await db
    .update(apiKeys)
    .set({ key })
    .where(eq(apiKeys.id, id))
    .returning();

  if (!updated) return c.json({ error: "Key not found" }, 404);
  return c.json({ data: updated });
});

/** POST /api/keys/test - Validate a key (no auth required) */
keysRouter.post("/test", async (c) => {
  const body = await c.req.json<{ key: string }>();
  const resolved = await resolveApiKey(body.key || "");
  return c.json({ valid: resolved !== null, name: resolved?.name || null });
});
