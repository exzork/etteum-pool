/**
 * Sync data extraction and application.
 * Handles reading full state and applying deltas to the local DB.
 */
import { db } from "../db/index";
import { client } from "../db/index";
import { accounts, apiKeys, settings, filterRules, modelMappings, proxyPool, requestLogs, usageSummary } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import type { SyncDelta, SyncFullData, SyncTable } from "./types";
import { setSuppressEmit } from "./state";

/**
 * Extract full sync-able state from local DB.
 * Excludes large transient data (request_logs, usage_summary) from full sync —
 * those are synced incrementally via deltas only.
 */
export async function extractFullState(): Promise<SyncFullData> {
  const [accs, keys, sets, filters, mappings, proxies] = await Promise.all([
    db.select().from(accounts),
    db.select().from(apiKeys),
    db.select().from(settings),
    db.select().from(filterRules),
    db.select().from(modelMappings),
    db.select().from(proxyPool),
  ]);

  return {
    accounts: accs as Record<string, unknown>[],
    apiKeys: keys as Record<string, unknown>[],
    settings: sets as Record<string, unknown>[],
    filterRules: filters as Record<string, unknown>[],
    modelMappings: mappings as Record<string, unknown>[],
    proxyPool: proxies as Record<string, unknown>[],
  };
}

/**
 * Apply a full state snapshot from a remote node.
 * Uses INSERT OR REPLACE semantics — remote data overwrites local if newer.
 */
export async function applyFullState(data: SyncFullData, remoteNodeId: string): Promise<number> {
  setSuppressEmit(true);
  let applied = 0;

  // Accounts: upsert by provider+email unique key
  for (const row of data.accounts || []) {
    try {
      const r = row as any;
      client.exec(`
        INSERT INTO accounts (id, provider, email, password, status, enabled, tokens, quota_limit, quota_remaining, quota_reset_at, last_used_at, last_login_at, error_message, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider, email) DO UPDATE SET
          password = excluded.password,
          status = excluded.status,
          enabled = excluded.enabled,
          tokens = excluded.tokens,
          quota_limit = excluded.quota_limit,
          quota_remaining = CASE WHEN excluded.updated_at > accounts.updated_at THEN excluded.quota_remaining ELSE accounts.quota_remaining END,
          quota_reset_at = excluded.quota_reset_at,
          last_used_at = CASE WHEN excluded.last_used_at > COALESCE(accounts.last_used_at, 0) THEN excluded.last_used_at ELSE accounts.last_used_at END,
          last_login_at = CASE WHEN excluded.last_login_at > COALESCE(accounts.last_login_at, 0) THEN excluded.last_login_at ELSE accounts.last_login_at END,
          error_message = excluded.error_message,
          metadata = excluded.metadata,
          updated_at = CASE WHEN excluded.updated_at > COALESCE(accounts.updated_at, 0) THEN excluded.updated_at ELSE accounts.updated_at END
      `, [
        r.id, r.provider, r.email, r.password, r.status, r.enabled ? 1 : 0,
        typeof r.tokens === "string" ? r.tokens : JSON.stringify(r.tokens),
        r.quotaLimit, r.quotaRemaining,
        r.quotaResetAt ? new Date(r.quotaResetAt).getTime() : null,
        r.lastUsedAt ? new Date(r.lastUsedAt).getTime() : null,
        r.lastLoginAt ? new Date(r.lastLoginAt).getTime() : null,
        r.errorMessage,
        typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata),
        r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
        r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now(),
      ]);
      applied++;
    } catch (e) {
      console.error(`[Sync] Failed to apply account:`, e);
    }
  }

  // API Keys: upsert by unique key
  for (const row of data.apiKeys || []) {
    try {
      const r = row as any;
      client.exec(`
        INSERT INTO api_keys (id, name, key, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET name = excluded.name
      `, [r.id, r.name, r.key, r.createdAt ? new Date(r.createdAt).getTime() : Date.now()]);
      applied++;
    } catch (e) {
      console.error(`[Sync] Failed to apply api_key:`, e);
    }
  }

  // Settings: upsert by key
  for (const row of data.settings || []) {
    try {
      const r = row as any;
      // Skip sync_node_id — each node keeps its own
      if (r.key === "sync_node_id") continue;
      client.exec(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET
          value = CASE WHEN excluded.updated_at > COALESCE(settings.updated_at, 0) THEN excluded.value ELSE settings.value END,
          updated_at = CASE WHEN excluded.updated_at > COALESCE(settings.updated_at, 0) THEN excluded.updated_at ELSE settings.updated_at END
      `, [r.key, r.value, r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now()]);
      applied++;
    } catch (e) {
      console.error(`[Sync] Failed to apply setting:`, e);
    }
  }

  // Filter rules: upsert by rule_id
  for (const row of data.filterRules || []) {
    try {
      const r = row as any;
      client.exec(`
        INSERT INTO filter_rules (id, rule_id, pattern, replacement, is_active, is_regex, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (rule_id) DO UPDATE SET
          pattern = excluded.pattern,
          replacement = excluded.replacement,
          is_active = excluded.is_active,
          is_regex = excluded.is_regex,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `, [
        r.id, r.ruleId, r.pattern, r.replacement,
        r.isActive ? 1 : 0, r.isRegex ? 1 : 0, r.sortOrder,
        r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
        r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now(),
      ]);
      applied++;
    } catch (e) {
      console.error(`[Sync] Failed to apply filter_rule:`, e);
    }
  }

  // Model mappings: upsert by id
  for (const row of data.modelMappings || []) {
    try {
      const r = row as any;
      client.exec(`
        INSERT OR REPLACE INTO model_mappings (id, source_pattern, match_type, target_model, enabled, priority, label, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        r.id, r.sourcePattern, r.matchType, r.targetModel,
        r.enabled ? 1 : 0, r.priority, r.label,
        r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
        r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now(),
      ]);
      applied++;
    } catch (e) {
      console.error(`[Sync] Failed to apply model_mapping:`, e);
    }
  }

  // Proxy pool: upsert by url
  for (const row of data.proxyPool || []) {
    try {
      const r = row as any;
      client.exec(`
        INSERT INTO proxy_pool (id, url, type, label, status, last_used_at, last_checked_at, error_message, latency_ms, success_count, fail_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `, [
        r.id, r.url, r.type, r.label, r.status,
        r.lastUsedAt ? new Date(r.lastUsedAt).getTime() : null,
        r.lastCheckedAt ? new Date(r.lastCheckedAt).getTime() : null,
        r.errorMessage, r.latencyMs, r.successCount, r.failCount,
        r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
        r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now(),
      ]);
      applied++;
    } catch (e) {
      console.error(`[Sync] Failed to apply proxy_pool:`, e);
    }
  }

  console.log(`[Sync] Applied ${applied} rows from node ${remoteNodeId}`);
  setSuppressEmit(false);
  return applied;
}

/**
 * Apply a single delta (incremental change) from a remote node.
 */
export async function applyDelta(delta: SyncDelta): Promise<boolean> {
  setSuppressEmit(true);
  try {
    const { table, operation, row } = delta;

    if (operation === "delete") {
      const result = applyDelete(table, row);
      setSuppressEmit(false);
      return result;
    }

    // Upsert
    const result = applyUpsert(table, row);
    setSuppressEmit(false);
    return result;
  } catch (e) {
    setSuppressEmit(false);
    console.error(`[Sync] Failed to apply delta:`, e);
    return false;
  }
}

function applyDelete(table: SyncTable, row: Record<string, unknown>): boolean {
  const id = row.id as number;
  if (!id) return false;

  const tableMap: Record<SyncTable, string> = {
    accounts: "accounts",
    api_keys: "api_keys",
    settings: "settings",
    request_logs: "request_logs",
    usage_summary: "usage_summary",
    filter_rules: "filter_rules",
    model_mappings: "model_mappings",
    proxy_pool: "proxy_pool",
    vcc_cards: "vcc_cards",
  };

  const sqlTable = tableMap[table];
  if (!sqlTable) return false;

  if (table === "settings") {
    client.exec(`DELETE FROM settings WHERE key = ?`, [row.key as string]);
  } else {
    client.exec(`DELETE FROM ${sqlTable} WHERE id = ?`, [id]);
  }
  return true;
}

function applyUpsert(table: SyncTable, row: Record<string, unknown>): boolean {
  switch (table) {
    case "accounts": {
      const r = row as any;
      client.exec(`
        INSERT INTO accounts (id, provider, email, password, status, enabled, tokens, quota_limit, quota_remaining, quota_reset_at, last_used_at, last_login_at, error_message, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider, email) DO UPDATE SET
          password = excluded.password,
          status = excluded.status,
          enabled = excluded.enabled,
          tokens = excluded.tokens,
          quota_limit = excluded.quota_limit,
          quota_remaining = CASE WHEN excluded.updated_at > COALESCE(accounts.updated_at, 0) THEN excluded.quota_remaining ELSE accounts.quota_remaining END,
          last_used_at = CASE WHEN excluded.last_used_at > COALESCE(accounts.last_used_at, 0) THEN excluded.last_used_at ELSE accounts.last_used_at END,
          last_login_at = CASE WHEN excluded.last_login_at > COALESCE(accounts.last_login_at, 0) THEN excluded.last_login_at ELSE accounts.last_login_at END,
          error_message = excluded.error_message,
          metadata = excluded.metadata,
          updated_at = CASE WHEN excluded.updated_at > COALESCE(accounts.updated_at, 0) THEN excluded.updated_at ELSE accounts.updated_at END
      `, [
        r.id, r.provider, r.email, r.password, r.status, r.enabled ? 1 : 0,
        typeof r.tokens === "string" ? r.tokens : JSON.stringify(r.tokens),
        r.quotaLimit, r.quotaRemaining,
        r.quotaResetAt ? new Date(r.quotaResetAt).getTime() : null,
        r.lastUsedAt ? new Date(r.lastUsedAt).getTime() : null,
        r.lastLoginAt ? new Date(r.lastLoginAt).getTime() : null,
        r.errorMessage,
        typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata),
        r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
        r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now(),
      ]);
      return true;
    }

    case "api_keys": {
      const r = row as any;
      client.exec(`
        INSERT INTO api_keys (id, name, key, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET name = excluded.name
      `, [r.id, r.name, r.key, r.createdAt ? new Date(r.createdAt).getTime() : Date.now()]);
      return true;
    }

    case "settings": {
      const r = row as any;
      if (r.key === "sync_node_id") return false;
      client.exec(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET
          value = CASE WHEN excluded.updated_at > COALESCE(settings.updated_at, 0) THEN excluded.value ELSE settings.value END,
          updated_at = CASE WHEN excluded.updated_at > COALESCE(settings.updated_at, 0) THEN excluded.updated_at ELSE settings.updated_at END
      `, [r.key, r.value, r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now()]);
      return true;
    }

    case "request_logs": {
      const r = row as any;
      // Request logs: insert only (no conflict update — each node's logs are unique)
      client.exec(`
        INSERT OR IGNORE INTO request_logs (id, account_id, provider, model, prompt_tokens, completion_tokens, total_tokens, credits_used, status, duration_ms, error_message, account_email, account_quota_before, account_quota_after, api_key_id, api_key_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        r.id, r.accountId, r.provider, r.model,
        r.promptTokens, r.completionTokens, r.totalTokens, r.creditsUsed,
        r.status, r.durationMs, r.errorMessage, r.accountEmail,
        r.accountQuotaBefore, r.accountQuotaAfter, r.apiKeyId, r.apiKeyName,
        r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
      ]);
      return true;
    }

    case "usage_summary": {
      const r = row as any;
      // Usage summary: additive merge on conflict
      client.exec(`
        INSERT INTO usage_summary (bucket, provider, model, api_key_id, api_key_name, total_requests, success_requests, error_requests, prompt_tokens, completion_tokens, total_tokens, credits_used, total_duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bucket, provider, model) DO UPDATE SET
          total_requests = usage_summary.total_requests + excluded.total_requests,
          success_requests = usage_summary.success_requests + excluded.success_requests,
          error_requests = usage_summary.error_requests + excluded.error_requests,
          prompt_tokens = usage_summary.prompt_tokens + excluded.prompt_tokens,
          completion_tokens = usage_summary.completion_tokens + excluded.completion_tokens,
          total_tokens = usage_summary.total_tokens + excluded.total_tokens,
          credits_used = usage_summary.credits_used + excluded.credits_used,
          total_duration_ms = usage_summary.total_duration_ms + excluded.total_duration_ms
      `, [
        r.bucket, r.provider, r.model, r.apiKeyId, r.apiKeyName,
        r.totalRequests, r.successRequests, r.errorRequests,
        r.promptTokens, r.completionTokens, r.totalTokens,
        r.creditsUsed, r.totalDurationMs,
      ]);
      return true;
    }

    case "filter_rules": {
      const r = row as any;
      client.exec(`
        INSERT INTO filter_rules (id, rule_id, pattern, replacement, is_active, is_regex, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (rule_id) DO UPDATE SET
          pattern = excluded.pattern,
          replacement = excluded.replacement,
          is_active = excluded.is_active,
          is_regex = excluded.is_regex,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `, [
        r.id, r.ruleId, r.pattern, r.replacement,
        r.isActive ? 1 : 0, r.isRegex ? 1 : 0, r.sortOrder,
        r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
        r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now(),
      ]);
      return true;
    }

    case "model_mappings": {
      const r = row as any;
      client.exec(`
        INSERT OR REPLACE INTO model_mappings (id, source_pattern, match_type, target_model, enabled, priority, label, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        r.id, r.sourcePattern, r.matchType, r.targetModel,
        r.enabled ? 1 : 0, r.priority, r.label,
        r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
        r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now(),
      ]);
      return true;
    }

    case "proxy_pool": {
      const r = row as any;
      client.exec(`
        INSERT OR REPLACE INTO proxy_pool (id, url, type, label, status, last_used_at, last_checked_at, error_message, latency_ms, success_count, fail_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        r.id, r.url, r.type, r.label, r.status,
        r.lastUsedAt ? new Date(r.lastUsedAt).getTime() : null,
        r.lastCheckedAt ? new Date(r.lastCheckedAt).getTime() : null,
        r.errorMessage, r.latencyMs, r.successCount, r.failCount,
        r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
        r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now(),
      ]);
      return true;
    }

    default:
      return false;
  }
}
