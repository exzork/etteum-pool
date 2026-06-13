import { Hono } from "hono";
import { db, call, type FilterRule } from "../db/index";
import { invalidateFilterCache } from "../proxy/filter-cache";
import { broadcast } from "../ws/index";

export const filtersRouter = new Hono();

filtersRouter.get("/", async (c) => {
  const rules = db.filterRules.getAll().sort((a, b) => a.sortOrder - b.sortOrder);
  return c.json({ count: rules.length, activeCount: rules.filter((r) => r.isActive).length, rules });
});

filtersRouter.post("/", async (c) => {
  const body = await c.req.json<{
    pattern: string;
    replacement?: string;
    isRegex?: boolean;
    isActive?: boolean;
    ruleId?: string;
  }>();
  if (!body.pattern || typeof body.pattern !== "string") {
    return c.json({ error: "pattern is required" }, 400);
  }
  if (body.isRegex) {
    try { new RegExp(body.pattern); } catch (e) {
      return c.json({ error: `Invalid regex: ${(e as Error).message}` }, 400);
    }
  }

  const allRules = db.filterRules.getAll();
  const maxOrder = allRules.reduce((max, r) => Math.max(max, r.sortOrder), 0);

  const ruleId = body.ruleId?.trim() || `rule_${crypto.randomUUID().slice(0, 8)}`;
  const id = BigInt(Date.now());

  await call.upsertFilterRule({
    id,
    ruleId,
    pattern: body.pattern,
    replacement: body.replacement ?? "",
    isRegex: Boolean(body.isRegex),
    isActive: body.isActive !== false,
    sortOrder: maxOrder + 1,
  });

  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: {} });

  // Return the created rule
  const created = db.filterRules.getAll().find((r) => r.ruleId === ruleId);
  return c.json(created || { id, ruleId, pattern: body.pattern, replacement: body.replacement ?? "", isRegex: Boolean(body.isRegex), isActive: body.isActive !== false, sortOrder: maxOrder + 1 }, 201);
});

filtersRouter.patch("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const body = await c.req.json<{
    pattern?: string;
    replacement?: string;
    isRegex?: boolean;
    isActive?: boolean;
    sortOrder?: number;
  }>();

  const existing = db.filterRules.getAll().find((r) => r.id === id);
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (typeof body.pattern === "string" && (body.isRegex ?? existing.isRegex)) {
    try { new RegExp(body.pattern); } catch (e) {
      return c.json({ error: `Invalid regex: ${(e as Error).message}` }, 400);
    }
  }

  await call.upsertFilterRule({
    id,
    ruleId: existing.ruleId,
    pattern: body.pattern ?? existing.pattern,
    replacement: body.replacement ?? existing.replacement,
    isRegex: body.isRegex ?? existing.isRegex,
    isActive: body.isActive ?? existing.isActive,
    sortOrder: body.sortOrder ?? existing.sortOrder,
  });

  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: {} });

  const updated = db.filterRules.getAll().find((r) => r.id === id);
  return c.json(updated || existing);
});

filtersRouter.delete("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const existing = db.filterRules.getAll().find((r) => r.id === id);
  if (!existing) return c.json({ error: "Not found" }, 404);

  await call.deleteFilterRule({ id });

  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: {} });
  return c.json({ success: true });
});
