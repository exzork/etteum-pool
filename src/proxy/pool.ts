import { db, call, type Account } from "../db/index";
import { broadcast } from "../ws/index";
import { config } from "../config";
import { getProviderForModel, type ProviderName } from "./providers/registry";

export type { ProviderName };

interface PoolState {
  lastIndex: Map<ProviderName, number>;
}

interface ActiveAccountsCacheEntry {
  accounts: Account[];
  expiresAt: number;
  inFlight?: Promise<Account[]>;
}

class AccountPool {
  private state: PoolState = {
    lastIndex: new Map(),
  };

  private activeAccountsCache = new Map<ProviderName, ActiveAccountsCacheEntry>();
  private inFlightByAccountId = new Map<number, number>();
  private lbMethodCache: { global: string; perProvider: Map<ProviderName, string>; expiresAt: number } | null = null;

  /**
   * Clear cached active accounts after account mutations or status changes.
   */
  invalidate(provider?: ProviderName): void {
    if (provider) {
      this.activeAccountsCache.delete(provider);
      return;
    }

    this.activeAccountsCache.clear();
  }

  private getLoadBalancingMethod(provider: ProviderName): string {
    const now = Date.now();
    if (!this.lbMethodCache || this.lbMethodCache.expiresAt <= now) {
      try {
        const allSettings = db.settings.getAll();
        const perProvider = new Map<ProviderName, string>();
        let global = "round_robin";
        for (const row of allSettings) {
          if (!row.value) continue;
          if (row.key === "load_balancing_method") {
            global = row.value;
            continue;
          }
          const match = row.key.match(/^provider_(.+)_lb_method$/);
          if (match && match[1]) perProvider.set(match[1] as ProviderName, row.value);
        }
        this.lbMethodCache = { global, perProvider, expiresAt: now + 10000 };
      } catch {
        this.lbMethodCache = { global: "round_robin", perProvider: new Map(), expiresAt: now + 10000 };
      }
    }
    return this.lbMethodCache.perProvider.get(provider) || this.lbMethodCache.global;
  }

  invalidateLoadBalancingCache(): void {
    this.lbMethodCache = null;
  }

  /**
   * Get the next available account for a provider using configured method.
   */
  async getNextAccount(provider: ProviderName): Promise<Account | null> {
    const activeAccounts = await this.getActiveAccounts(provider);

    if (activeAccounts.length === 0) {
      return null;
    }

    const method = this.getLoadBalancingMethod(provider);

    if (method === "sequential") {
      // Sequential: use first account with lowest in-flight, prefer order
      for (const account of activeAccounts) {
        if (this.getInFlightCount(Number(account.id)) === 0) return account;
      }
      return activeAccounts[0] || null;
    }

    // Round Robin (default)
    const startIdx = ((this.state.lastIndex.get(provider) || 0) + 1) % activeAccounts.length;
    let selected = activeAccounts[startIdx];
    let selectedIdx = startIdx;
    let selectedLoad = selected ? this.getInFlightCount(Number(selected.id)) : Number.POSITIVE_INFINITY;

    for (let i = 1; i < activeAccounts.length; i++) {
      const idx = (startIdx + i) % activeAccounts.length;
      const candidate = activeAccounts[idx];
      if (!candidate) continue;
      const load = this.getInFlightCount(Number(candidate.id));
      if (load < selectedLoad) {
        selected = candidate;
        selectedIdx = idx;
        selectedLoad = load;
        if (load === 0) break;
      }
    }

    this.state.lastIndex.set(provider, selectedIdx);
    return selected || null;
  }

  private getInFlightCount(accountId: number): number {
    return this.inFlightByAccountId.get(accountId) || 0;
  }

  trackRequestStart(accountId: number): void {
    this.inFlightByAccountId.set(accountId, this.getInFlightCount(accountId) + 1);
  }

  trackRequestEnd(accountId: number): void {
    const next = this.getInFlightCount(accountId) - 1;
    if (next > 0) this.inFlightByAccountId.set(accountId, next);
    else this.inFlightByAccountId.delete(accountId);
  }

  async decrementQuota(accountId: number, creditsUsed: number): Promise<number> {
    const account = db.accounts.findById(BigInt(accountId));
    if (!account) return 0;

    if (!Number.isFinite(creditsUsed) || creditsUsed <= 0) {
      return Number(account.quotaRemaining || 0);
    }

    const newRemaining = Math.max(0, (account.quotaRemaining || 0) - creditsUsed);
    call.updateAccountQuota({
      id: BigInt(accountId),
      quotaRemaining: newRemaining,
      quotaResetAt: account.quotaResetAt ?? null,
      lastUsedAt: account.lastUsedAt ?? null,
    });

    return newRemaining;
  }

  /**
   * Check and reset daily quota for Qoder accounts.
   * - If quotaLimit === 0: initialize with dailyLimit
   * - If quotaResetAt has passed: reset quotaRemaining to dailyLimit, set quotaResetAt to next midnight
   * - Reactivates exhausted accounts after reset (unless server-side rate limited)
   */
  async checkAndResetDailyQuota(accountId: number, dailyLimit: number): Promise<number> {
    const account = db.accounts.findById(BigInt(accountId));
    if (!account) return 0;

    const now = Date.now();
    const resetAt = account.quotaResetAt ? Number(account.quotaResetAt) : null;
    const currentLimit = Number(account.quotaLimit || 0);

    // Check if account is server-side rate limited (exhausted within last 24 hours)
    const updatedAtMs = account.updatedAt ? Number(account.updatedAt) : null;
    const hoursSinceUpdate = updatedAtMs ? (now - updatedAtMs) / (1000 * 60 * 60) : Infinity;
    const isServerRateLimited = account.status === "exhausted" && hoursSinceUpdate < 24;

    // Initialize or reset if:
    // 1. quotaLimit === 0 (first time setup)
    // 2. quotaResetAt has passed (daily reset) AND not server-side rate limited
    if (currentLimit === 0 || (!isServerRateLimited && (!resetAt || now >= resetAt))) {
      // Set next reset to tomorrow midnight
      const nextReset = new Date(now);
      nextReset.setDate(nextReset.getDate() + 1);
      nextReset.setHours(0, 0, 0, 0);

      const nextResetMs = BigInt(nextReset.getTime());

      call.updateAccountQuota({
        id: BigInt(accountId),
        quotaRemaining: dailyLimit,
        quotaResetAt: nextResetMs,
        lastUsedAt: account.lastUsedAt ?? null,
      });

      call.updateAccountStatus({
        id: BigInt(accountId),
        status: "active",
        errorMessage: null,
      });

      this.invalidate(account.provider as ProviderName);
      broadcast({
        type: "account_status",
        data: { id: accountId, status: "active", provider: account.provider, quotaReset: true },
      });

      return dailyLimit;
    }

    return Number(account.quotaRemaining || 0);
  }

  private async getActiveAccounts(provider: ProviderName): Promise<Account[]> {
    const ttlMs = Math.max(0, config.accountCacheTtlMs);
    if (ttlMs === 0) return this.fetchActiveAccounts(provider);

    const now = Date.now();
    const cached = this.activeAccountsCache.get(provider);
    if (cached && cached.expiresAt > now) return cached.accounts;
    if (cached?.inFlight) return cached.inFlight;

    const fetchTime = now;
    const inFlight = Promise.resolve(this.fetchActiveAccounts(provider))
      .then((activeAccounts) => {
        this.activeAccountsCache.set(provider, {
          accounts: activeAccounts,
          expiresAt: fetchTime + ttlMs,
        });
        return activeAccounts;
      })
      .catch((error) => {
        this.activeAccountsCache.delete(provider);
        throw error;
      });

    this.activeAccountsCache.set(provider, {
      accounts: cached?.accounts || [],
      expiresAt: 0,
      inFlight,
    });

    return inFlight;
  }

  private fetchActiveAccounts(provider: ProviderName): Account[] {
    return db.accounts.getActive(provider);
  }

  /**
   * Get any available account across all providers that support the model.
   */
  async getAccountForModel(model: string): Promise<{ account: Account; provider: ProviderName } | null> {
    // Determine which provider handles this model
    const provider = this.getProviderForModel(model);
    if (!provider) return null;

    // BYOK requires special handling - find account by prefix
    if (provider === "byok") {
      const { getByokProvider } = await import("./providers/registry");
      const byokProvider = getByokProvider();
      const account = await byokProvider.findAccountForModel(model);
      if (!account) return null;
      return { account, provider: "byok" };
    }

    const account = await this.getNextAccount(provider);
    if (!account) return null;

    return { account, provider };
  }

  /**
   * Map model name to provider. Delegates to the provider registry, which asks
   * each provider's ownsModel() in priority order (single source of truth).
   */
  getProviderForModel(model: string): ProviderName | null {
    return getProviderForModel(model);
  }

  /**
   * Mark an account as used (update last_used_at)
   */
  async markUsed(accountId: number): Promise<void> {
    const account = db.accounts.findById(BigInt(accountId));
    if (!account) return;

    call.updateAccountQuota({
      id: BigInt(accountId),
      quotaRemaining: account.quotaRemaining ?? 0,
      quotaResetAt: account.quotaResetAt ?? null,
      lastUsedAt: BigInt(Date.now()),
    });
  }

  /**
   * Mark an account as exhausted (also zeroes out quota remaining)
   */
  async markExhausted(accountId: number): Promise<void> {
    const account = db.accounts.findById(BigInt(accountId));

    call.updateAccountStatus({
      id: BigInt(accountId),
      status: "exhausted",
      errorMessage: null,
    });

    call.updateAccountQuota({
      id: BigInt(accountId),
      quotaRemaining: 0,
      quotaResetAt: account?.quotaResetAt ?? null,
      lastUsedAt: account?.lastUsedAt ?? null,
    });

    if (account) {
      this.invalidate(account.provider as ProviderName);
      broadcast({
        type: "account_status",
        data: { id: accountId, status: "exhausted", provider: account.provider },
      });
    }
  }

  /**
   * Mark an account as errored
   */
  async markError(accountId: number, errorMessage: string): Promise<void> {
    const account = db.accounts.findById(BigInt(accountId));

    call.updateAccountStatus({
      id: BigInt(accountId),
      status: "error",
      errorMessage,
    });

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "error", error: errorMessage },
    });
  }

  async markTransientFailure(accountId: number, errorMessage: string): Promise<void> {
    const account = db.accounts.findById(BigInt(accountId));

    call.updateAccountStatus({
      id: BigInt(accountId),
      status: "active",
      errorMessage,
    });

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "active", warning: errorMessage },
    });
  }

  /**
   * Update account tokens (stored as json string)
   */
  async updateTokens(accountId: number, tokens: unknown): Promise<void> {
    call.updateAccountTokens({
      id: BigInt(accountId),
      tokens: tokens ? JSON.stringify(tokens) : null,
      lastLoginAt: null,
    });
  }

  /**
   * Toggle account enabled flag (user-controlled active/inactive).
   */
  async setEnabled(accountId: number, enabled: boolean): Promise<Account | null> {
    call.updateAccountEnabled({
      id: BigInt(accountId),
      enabled,
    });

    // Read back from cache (may not be updated yet due to async reducer)
    const account = db.accounts.findById(BigInt(accountId));
    if (!account) return null;

    this.invalidate(account.provider as ProviderName);
    broadcast({
      type: "account_status",
      data: { id: accountId, enabled, provider: account.provider, status: account.status },
    });
    return account;
  }

  /**
   * Bulk toggle enabled flag for all accounts of a provider.
   */
  async setEnabledByProvider(provider: ProviderName, enabled: boolean): Promise<number> {
    const providerAccounts = db.accounts.getByProvider(provider);

    for (const account of providerAccounts) {
      call.updateAccountEnabled({
        id: account.id,
        enabled,
      });
    }

    const count = providerAccounts.length;
    this.invalidate(provider);
    broadcast({
      type: "provider_toggled",
      data: { provider, enabled, count },
    });
    return count;
  }

  /**
   * Get pool statistics
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    exhausted: number;
    error: number;
    pending: number;
    disabled: number;
    byProvider: Record<string, { active: number; total: number; disabled: number }>;
  }> {
    const allAccounts = db.accounts.getAll();

    let total = 0;
    let active = 0;
    let exhausted = 0;
    let error = 0;
    let pending = 0;
    let disabled = 0;
    const byProvider: Record<string, { active: number; total: number; disabled: number }> = {};

    for (const account of allAccounts) {
      total++;

      if (!account.enabled) disabled++;
      if (account.status === "active" && account.enabled) active++;
      else if (account.status === "exhausted") exhausted++;
      else if (account.status === "error") error++;
      else if (account.status === "pending") pending++;

      if (!byProvider[account.provider]) {
        byProvider[account.provider] = { active: 0, total: 0, disabled: 0 };
      }
      byProvider[account.provider].total++;
      if (account.status === "active" && account.enabled) byProvider[account.provider].active++;
      if (!account.enabled) byProvider[account.provider].disabled++;
    }

    return { total, active, exhausted, error, pending, disabled, byProvider };
  }
}

export const pool = new AccountPool();
