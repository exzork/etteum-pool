import { db, type FilterRule } from "../db/index";

let cache: FilterRule[] = [];

export async function loadFilterCache(): Promise<void> {
  cache = db.filterRules.getActive();
}

export function getFilterRulesCached(): FilterRule[] {
  return cache;
}

export function invalidateFilterCache(): void {
  loadFilterCache().catch((e) => console.error("[FilterCache] reload failed", e));
}
