/**
 * Model mapping for CLI integration (the assistant, etc.).
 *
 * Popular CLIs (notably the assistant) hardcode their own model ids — e.g.
 * "claude-3-5-haiku-20241022", "claude-sonnet-4-20250514". The user only sets a
 * base URL + API key; the CLI keeps calling those Anthropic model ids. This
 * module rewrites the incoming model id at the proxy edge to a target model
 * actually available in the pool, configured from the dashboard.
 *
 * Rules are read from an in-memory cache (SpacetimeDB-backed), mirroring filter-cache.ts.
 * resolveModelAlias() runs on the request hot path so it must stay synchronous.
 */
import { db, call, type ModelMapping } from "../db/index";

const MAPPING_ENABLED_SETTING = "model_mapping_enabled";

let cache: ModelMapping[] = [];
let masterEnabled = true;

/**
 * Default mappings seeded on first boot. Templates for the assistant's three
 * model classes (haiku / sonnet / opus). They start disabled with an empty
 * target so nothing changes until the user wires them up in the dashboard.
 */
export const DEFAULT_MODEL_MAPPINGS: Array<{
  sourcePattern: string;
  matchType: string;
  targetModel: string;
  enabled: boolean;
  priority: number;
  label: string;
}> = [
  { sourcePattern: "haiku", matchType: "contains", targetModel: "", enabled: false, priority: 0, label: "the assistant · Haiku (small/fast)" },
  { sourcePattern: "sonnet", matchType: "contains", targetModel: "", enabled: false, priority: 1, label: "the assistant · Sonnet (main)" },
  { sourcePattern: "opus", matchType: "contains", targetModel: "", enabled: false, priority: 2, label: "the assistant · Opus (heavy)" },
];

/** Seed default mappings if the table is empty (first boot only). */
export async function seedModelMappings(): Promise<void> {
  const existing = db.modelMappings.getAll();
  if (existing.length > 0) return;
  for (const m of DEFAULT_MODEL_MAPPINGS) {
    call.upsertModelMapping({
      id: 0n,
      sourcePattern: m.sourcePattern,
      matchType: m.matchType,
      targetModel: m.targetModel,
      enabled: m.enabled,
      priority: m.priority,
      label: m.label,
    });
  }
}

/** Load mappings + master toggle into the in-memory cache. */
export async function loadModelMappingCache(): Promise<void> {
  cache = db.modelMappings.getEnabled();
  const settingVal = db.settings.get(MAPPING_ENABLED_SETTING);
  // Default ON when the setting was never written.
  masterEnabled = settingVal == null ? true : settingVal !== "false";
}

export function invalidateModelMappingCache(): void {
  loadModelMappingCache().catch((e) => console.error("[ModelMapping] reload failed", e));
}

export function getModelMappingsCached(): ModelMapping[] {
  return cache;
}

export function isModelMappingEnabled(): boolean {
  return masterEnabled;
}

function matchesPattern(model: string, rule: ModelMapping): boolean {
  const source = rule.sourcePattern;
  if (!source) return false;
  switch (rule.matchType) {
    case "exact":
      return model.toLowerCase() === source.toLowerCase();
    case "regex":
      try {
        return new RegExp(source, "i").test(model);
      } catch (e) {
        console.error(`[ModelMapping] invalid regex "${source}":`, e);
        return false;
      }
    case "contains":
    default:
      return model.toLowerCase().includes(source.toLowerCase());
  }
}

/**
 * Rewrite an incoming model id to its mapped target, if any. Single pass (no
 * recursive remapping). Returns the original model when mapping is disabled,
 * no rule matches, or the target is empty/identical.
 */
export function resolveModelAlias(model: string): string {
  if (!model || !masterEnabled) return model;
  for (const rule of cache) {
    if (!rule.enabled) continue;
    if (!rule.targetModel) continue;
    if (matchesPattern(model, rule)) {
      return rule.targetModel === model ? model : rule.targetModel;
    }
  }
  return model;
}
