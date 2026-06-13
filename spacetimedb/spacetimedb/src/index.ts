/**
 * Etteum Pool — SpacetimeDB Server Module
 *
 * Replaces SQLite + custom sync with a single realtime database.
 * All workers connect as clients and subscribe to tables.
 * Changes propagate instantly to all connected workers.
 */
import { schema, table, t } from "spacetimedb/server";

// ─── Custom Types ───────────────────────────────────────────────────────────

const JsonData = t.option(t.string()); // JSON stored as string, nullable

// ─── Tables ─────────────────────────────────────────────────────────────────

const accounts = table(
  {
    name: "accounts",
    public: true,
    indexes: [
      {
        accessor: "by_provider_email",
        algorithm: "btree" as const,
        columns: ["provider", "email"],
      },
      {
        accessor: "by_provider",
        algorithm: "btree" as const,
        columns: ["provider"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    provider: t.string(), // kiro | codebuddy | canva | codex | qoder | gitlab-duo
    email: t.string(),
    password: t.string(), // encrypted
    status: t.string(), // active | exhausted | error | pending
    enabled: t.bool(),
    tokens: JsonData, // { access_token, refresh_token, ... }
    quotaLimit: t.f64(),
    quotaRemaining: t.f64(),
    quotaResetAt: t.option(t.u64()), // epoch ms
    lastUsedAt: t.option(t.u64()), // epoch ms
    lastLoginAt: t.option(t.u64()), // epoch ms
    errorMessage: t.option(t.string()),
    metadata: JsonData, // extra provider-specific data
    createdAt: t.u64(), // epoch ms
    updatedAt: t.u64(), // epoch ms
  }
);

const apiKeys = table(
  {
    name: "api_keys",
    public: true,
  },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    key: t.string().unique(),
    createdAt: t.u64(), // epoch ms
  }
);

const settings = table(
  {
    name: "settings",
    public: true,
  },
  {
    key: t.string().primaryKey(),
    value: t.option(t.string()),
    updatedAt: t.u64(), // epoch ms
  }
);

const requestLogs = table(
  {
    name: "request_logs",
    public: true,
    indexes: [
      {
        accessor: "by_created_at",
        algorithm: "btree" as const,
        columns: ["createdAt"],
      },
      {
        accessor: "by_provider",
        algorithm: "btree" as const,
        columns: ["provider"],
      },
      {
        accessor: "by_account",
        algorithm: "btree" as const,
        columns: ["accountId"],
      },
      {
        accessor: "by_api_key",
        algorithm: "btree" as const,
        columns: ["apiKeyId"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    accountId: t.option(t.u64()),
    provider: t.string(),
    model: t.option(t.string()),
    promptTokens: t.u64(),
    completionTokens: t.u64(),
    totalTokens: t.u64(),
    creditsUsed: t.f64(),
    status: t.string(), // success | error
    durationMs: t.option(t.u64()),
    errorMessage: t.option(t.string()),
    requestBody: JsonData,
    responseBody: JsonData,
    accountEmail: t.option(t.string()),
    accountQuotaBefore: t.f64(),
    accountQuotaAfter: t.f64(),
    apiKeyId: t.option(t.u64()),
    apiKeyName: t.option(t.string()),
    createdAt: t.u64(), // epoch ms
  }
);

const usageSummary = table(
  {
    name: "usage_summary",
    public: true,
    indexes: [
      {
        accessor: "by_bucket",
        algorithm: "btree" as const,
        columns: ["bucket"],
      },
      {
        accessor: "by_bucket_provider_model_key",
        algorithm: "btree" as const,
        columns: ["bucket", "provider", "model", "apiKeyId"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    bucket: t.string(), // ISO-8601 hour bucket
    provider: t.string(),
    model: t.string(),
    apiKeyId: t.u64(), // 0 = no key
    apiKeyName: t.option(t.string()),
    totalRequests: t.u64(),
    successRequests: t.u64(),
    errorRequests: t.u64(),
    promptTokens: t.u64(),
    completionTokens: t.u64(),
    totalTokens: t.u64(),
    creditsUsed: t.f64(),
    totalDurationMs: t.u64(),
  }
);

const filterRules = table(
  {
    name: "filter_rules",
    public: true,
  },
  {
    id: t.u64().primaryKey().autoInc(),
    ruleId: t.string().unique(),
    pattern: t.string(),
    replacement: t.string(),
    isActive: t.bool(),
    isRegex: t.bool(),
    sortOrder: t.u32(),
    createdAt: t.u64(),
    updatedAt: t.u64(),
  }
);

const modelMappings = table(
  {
    name: "model_mappings",
    public: true,
    indexes: [
      {
        accessor: "by_priority",
        algorithm: "btree" as const,
        columns: ["priority"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sourcePattern: t.string(),
    matchType: t.string(), // contains | exact | regex
    targetModel: t.string(),
    enabled: t.bool(),
    priority: t.u32(), // lower = evaluated first
    label: t.option(t.string()),
    createdAt: t.u64(),
    updatedAt: t.u64(),
  }
);

const proxyPool = table(
  {
    name: "proxy_pool",
    public: true,
    indexes: [
      {
        accessor: "by_status",
        algorithm: "btree" as const,
        columns: ["status"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    url: t.string(),
    proxyType: t.string(), // http | socks5
    label: t.option(t.string()),
    status: t.string(), // active | disabled | error
    lastUsedAt: t.option(t.u64()),
    lastCheckedAt: t.option(t.u64()),
    errorMessage: t.option(t.string()),
    latencyMs: t.option(t.u64()),
    successCount: t.u64(),
    failCount: t.u64(),
    createdAt: t.u64(),
    updatedAt: t.u64(),
  }
);

const vccCards = table(
  {
    name: "vcc_cards",
    public: true,
    indexes: [
      {
        accessor: "by_status",
        algorithm: "btree" as const,
        columns: ["status"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    number: t.string(),
    expMonth: t.string(),
    expYear: t.string(),
    cvv: t.string(),
    name: t.string(),
    status: t.string(), // active | used | declined
    usedByAccountId: t.option(t.u64()),
    createdAt: t.u64(),
    updatedAt: t.u64(),
  }
);

const vccTransactions = table(
  {
    name: "vcc_transactions",
    public: true,
    indexes: [
      {
        accessor: "by_account",
        algorithm: "btree" as const,
        columns: ["accountId"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    accountId: t.option(t.u64()),
    cardLast4: t.string(),
    cardBrand: t.option(t.string()),
    amount: t.option(t.f64()),
    currency: t.string(),
    status: t.string(), // success | declined | error
    stripeChargeId: t.option(t.string()),
    createdAt: t.u64(),
  }
);

const imageStudioChats = table(
  {
    name: "image_studio_chats",
    public: true,
  },
  {
    id: t.u64().primaryKey().autoInc(),
    title: t.option(t.string()),
    messages: t.string(), // JSON array
    finalPrompt: t.option(t.string()),
    options: t.string(), // JSON array
    assistModel: t.option(t.string()),
    createdAt: t.u64(),
    updatedAt: t.u64(),
  }
);

const imageStudioResults = table(
  {
    name: "image_studio_results",
    public: true,
    indexes: [
      {
        accessor: "by_chat",
        algorithm: "btree" as const,
        columns: ["chatId"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    chatId: t.option(t.u64()),
    prompt: t.string(),
    resultType: t.string(), // "image" etc
    aspectRatio: t.string(),
    n: t.u32(),
    urls: t.string(), // JSON array
    creditsUsed: t.f64(),
    createdAt: t.u64(),
  }
);

// ─── Schema Export ──────────────────────────────────────────────────────────

const spacetimedb = schema({
  accounts,
  apiKeys,
  settings,
  requestLogs,
  usageSummary,
  filterRules,
  modelMappings,
  proxyPool,
  vccCards,
  vccTransactions,
  imageStudioChats,
  imageStudioResults,
});
export default spacetimedb;

// ─── Lifecycle Hooks ────────────────────────────────────────────────────────

export const init = spacetimedb.init((_ctx) => {
  console.info("[Etteum] Module initialized");
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  console.info(`[Etteum] Client connected: ${ctx.sender}`);
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  console.info(`[Etteum] Client disconnected: ${ctx.sender}`);
});


// ─── Account Reducers ───────────────────────────────────────────────────────

export const upsertAccount = spacetimedb.reducer(
  {
    id: t.u64(), // 0n for new
    provider: t.string(),
    email: t.string(),
    password: t.string(),
    status: t.string(),
    enabled: t.bool(),
    tokens: t.option(t.string()),
    quotaLimit: t.f64(),
    quotaRemaining: t.f64(),
    quotaResetAt: t.option(t.u64()),
    lastUsedAt: t.option(t.u64()),
    lastLoginAt: t.option(t.u64()),
    errorMessage: t.option(t.string()),
    metadata: t.option(t.string()),
  },
  (ctx, args) => {
    const ts = BigInt(Date.now());
    if (args.id === 0n) {
      // Insert new
      ctx.db.accounts.insert({
        id: 0n,
        provider: args.provider,
        email: args.email,
        password: args.password,
        status: args.status,
        enabled: args.enabled,
        tokens: args.tokens,
        quotaLimit: args.quotaLimit,
        quotaRemaining: args.quotaRemaining,
        quotaResetAt: args.quotaResetAt,
        lastUsedAt: args.lastUsedAt,
        lastLoginAt: args.lastLoginAt,
        errorMessage: args.errorMessage,
        metadata: args.metadata,
        createdAt: ts,
        updatedAt: ts,
      });
    } else {
      // Update existing
      const existing = ctx.db.accounts.id.find(args.id);
      if (!existing) throw new Error(`Account ${args.id} not found`);
      ctx.db.accounts.id.update({
        ...existing,
        provider: args.provider,
        email: args.email,
        password: args.password,
        status: args.status,
        enabled: args.enabled,
        tokens: args.tokens,
        quotaLimit: args.quotaLimit,
        quotaRemaining: args.quotaRemaining,
        quotaResetAt: args.quotaResetAt,
        lastUsedAt: args.lastUsedAt,
        lastLoginAt: args.lastLoginAt,
        errorMessage: args.errorMessage,
        metadata: args.metadata,
        updatedAt: ts,
      });
    }
  }
);

export const updateAccountStatus = spacetimedb.reducer(
  {
    id: t.u64(),
    status: t.string(),
    errorMessage: t.option(t.string()),
  },
  (ctx, { id, status, errorMessage }) => {
    const existing = ctx.db.accounts.id.find(id);
    if (!existing) throw new Error(`Account ${id} not found`);
    ctx.db.accounts.id.update({
      ...existing,
      status,
      errorMessage,
      updatedAt: BigInt(Date.now()),
    });
  }
);

export const updateAccountQuota = spacetimedb.reducer(
  {
    id: t.u64(),
    quotaRemaining: t.f64(),
    quotaResetAt: t.option(t.u64()),
    lastUsedAt: t.option(t.u64()),
  },
  (ctx, { id, quotaRemaining, quotaResetAt, lastUsedAt }) => {
    const existing = ctx.db.accounts.id.find(id);
    if (!existing) throw new Error(`Account ${id} not found`);
    ctx.db.accounts.id.update({
      ...existing,
      quotaRemaining,
      quotaResetAt,
      lastUsedAt,
      updatedAt: BigInt(Date.now()),
    });
  }
);

export const updateAccountTokens = spacetimedb.reducer(
  {
    id: t.u64(),
    tokens: t.option(t.string()),
    lastLoginAt: t.option(t.u64()),
  },
  (ctx, { id, tokens, lastLoginAt }) => {
    const existing = ctx.db.accounts.id.find(id);
    if (!existing) throw new Error(`Account ${id} not found`);
    ctx.db.accounts.id.update({
      ...existing,
      tokens,
      lastLoginAt,
      updatedAt: BigInt(Date.now()),
    });
  }
);

export const updateAccountEnabled = spacetimedb.reducer(
  { id: t.u64(), enabled: t.bool() },
  (ctx, { id, enabled }) => {
    const existing = ctx.db.accounts.id.find(id);
    if (!existing) throw new Error(`Account ${id} not found`);
    ctx.db.accounts.id.update({
      ...existing,
      enabled,
      updatedAt: BigInt(Date.now()),
    });
  }
);

export const deleteAccount = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    ctx.db.accounts.id.delete(id);
  }
);

// ─── API Key Reducers ───────────────────────────────────────────────────────

export const upsertApiKey = spacetimedb.reducer(
  { id: t.u64(), name: t.string(), key: t.string() },
  (ctx, { id, name, key }) => {
    if (id === 0n) {
      ctx.db.apiKeys.insert({ id: 0n, name, key, createdAt: BigInt(Date.now()) });
    } else {
      const existing = ctx.db.apiKeys.id.find(id);
      if (!existing) throw new Error(`API key ${id} not found`);
      ctx.db.apiKeys.id.update({ ...existing, name });
    }
  }
);

export const deleteApiKey = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    ctx.db.apiKeys.id.delete(id);
  }
);

// ─── Settings Reducers ──────────────────────────────────────────────────────

export const upsertSetting = spacetimedb.reducer(
  { key: t.string(), value: t.option(t.string()) },
  (ctx, { key, value }) => {
    const existing = ctx.db.settings.key.find(key);
    if (existing) {
      ctx.db.settings.key.update({ ...existing, value, updatedAt: BigInt(Date.now()) });
    } else {
      ctx.db.settings.insert({ key, value, updatedAt: BigInt(Date.now()) });
    }
  }
);

export const deleteSetting = spacetimedb.reducer(
  { key: t.string() },
  (ctx, { key }) => {
    ctx.db.settings.key.delete(key);
  }
);

// ─── Request Log Reducers ───────────────────────────────────────────────────

export const insertRequestLog = spacetimedb.reducer(
  {
    accountId: t.option(t.u64()),
    provider: t.string(),
    model: t.option(t.string()),
    promptTokens: t.u64(),
    completionTokens: t.u64(),
    totalTokens: t.u64(),
    creditsUsed: t.f64(),
    status: t.string(),
    durationMs: t.option(t.u64()),
    errorMessage: t.option(t.string()),
    requestBody: t.option(t.string()),
    responseBody: t.option(t.string()),
    accountEmail: t.option(t.string()),
    accountQuotaBefore: t.f64(),
    accountQuotaAfter: t.f64(),
    apiKeyId: t.option(t.u64()),
    apiKeyName: t.option(t.string()),
  },
  (ctx, args) => {
    ctx.db.requestLogs.insert({
      id: 0n,
      ...args,
      createdAt: BigInt(Date.now()),
    });
  }
);

export const updateRequestLog = spacetimedb.reducer(
  {
    id: t.u64(),
    promptTokens: t.u64(),
    completionTokens: t.u64(),
    totalTokens: t.u64(),
    creditsUsed: t.f64(),
    status: t.string(),
    durationMs: t.option(t.u64()),
    errorMessage: t.option(t.string()),
    accountQuotaAfter: t.f64(),
  },
  (ctx, args) => {
    const existing = ctx.db.requestLogs.id.find(args.id);
    if (!existing) return; // Silently skip if not found (race condition)
    ctx.db.requestLogs.id.update({
      ...existing,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      totalTokens: args.totalTokens,
      creditsUsed: args.creditsUsed,
      status: args.status,
      durationMs: args.durationMs,
      errorMessage: args.errorMessage,
      accountQuotaAfter: args.accountQuotaAfter,
    });
  }
);

// ─── Usage Summary Reducers ─────────────────────────────────────────────────

export const upsertUsageSummary = spacetimedb.reducer(
  {
    bucket: t.string(),
    provider: t.string(),
    model: t.string(),
    apiKeyId: t.u64(),
    apiKeyName: t.option(t.string()),
    totalRequests: t.u64(),
    successRequests: t.u64(),
    errorRequests: t.u64(),
    promptTokens: t.u64(),
    completionTokens: t.u64(),
    totalTokens: t.u64(),
    creditsUsed: t.f64(),
    totalDurationMs: t.u64(),
  },
  (ctx, args) => {
    // Find existing by composite key
    const existing = [...ctx.db.usageSummary.by_bucket_provider_model_key.filter([
      args.bucket,
      args.provider,
      args.model,
      args.apiKeyId,
    ])][0];

    if (existing) {
      ctx.db.usageSummary.id.update({
        ...existing,
        apiKeyName: args.apiKeyName,
        totalRequests: args.totalRequests,
        successRequests: args.successRequests,
        errorRequests: args.errorRequests,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        totalTokens: args.totalTokens,
        creditsUsed: args.creditsUsed,
        totalDurationMs: args.totalDurationMs,
      });
    } else {
      ctx.db.usageSummary.insert({ id: 0n, ...args });
    }
  }
);

export const deleteUsageSummary = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    ctx.db.usageSummary.id.delete(id);
  }
);

// ─── Filter Rules Reducers ──────────────────────────────────────────────────

export const upsertFilterRule = spacetimedb.reducer(
  {
    id: t.u64(),
    ruleId: t.string(),
    pattern: t.string(),
    replacement: t.string(),
    isActive: t.bool(),
    isRegex: t.bool(),
    sortOrder: t.u32(),
  },
  (ctx, args) => {
    const ts = BigInt(Date.now());
    if (args.id === 0n) {
      ctx.db.filterRules.insert({
        id: 0n,
        ruleId: args.ruleId,
        pattern: args.pattern,
        replacement: args.replacement,
        isActive: args.isActive,
        isRegex: args.isRegex,
        sortOrder: args.sortOrder,
        createdAt: ts,
        updatedAt: ts,
      });
    } else {
      const existing = ctx.db.filterRules.id.find(args.id);
      if (!existing) throw new Error(`Filter rule ${args.id} not found`);
      ctx.db.filterRules.id.update({
        ...existing,
        ruleId: args.ruleId,
        pattern: args.pattern,
        replacement: args.replacement,
        isActive: args.isActive,
        isRegex: args.isRegex,
        sortOrder: args.sortOrder,
        updatedAt: ts,
      });
    }
  }
);

export const deleteFilterRule = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    ctx.db.filterRules.id.delete(id);
  }
);

// ─── Model Mapping Reducers ─────────────────────────────────────────────────

export const upsertModelMapping = spacetimedb.reducer(
  {
    id: t.u64(),
    sourcePattern: t.string(),
    matchType: t.string(),
    targetModel: t.string(),
    enabled: t.bool(),
    priority: t.u32(),
    label: t.option(t.string()),
  },
  (ctx, args) => {
    const ts = BigInt(Date.now());
    if (args.id === 0n) {
      ctx.db.modelMappings.insert({
        id: 0n,
        sourcePattern: args.sourcePattern,
        matchType: args.matchType,
        targetModel: args.targetModel,
        enabled: args.enabled,
        priority: args.priority,
        label: args.label,
        createdAt: ts,
        updatedAt: ts,
      });
    } else {
      const existing = ctx.db.modelMappings.id.find(args.id);
      if (!existing) throw new Error(`Model mapping ${args.id} not found`);
      ctx.db.modelMappings.id.update({
        ...existing,
        sourcePattern: args.sourcePattern,
        matchType: args.matchType,
        targetModel: args.targetModel,
        enabled: args.enabled,
        priority: args.priority,
        label: args.label,
        updatedAt: ts,
      });
    }
  }
);

export const deleteModelMapping = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    ctx.db.modelMappings.id.delete(id);
  }
);

// ─── Proxy Pool Reducers ────────────────────────────────────────────────────

export const upsertProxy = spacetimedb.reducer(
  {
    id: t.u64(),
    url: t.string(),
    proxyType: t.string(),
    label: t.option(t.string()),
    status: t.string(),
    latencyMs: t.option(t.u64()),
    errorMessage: t.option(t.string()),
  },
  (ctx, args) => {
    const ts = BigInt(Date.now());
    if (args.id === 0n) {
      ctx.db.proxyPool.insert({
        id: 0n,
        url: args.url,
        proxyType: args.proxyType,
        label: args.label,
        status: args.status,
        lastUsedAt: undefined,
        lastCheckedAt: undefined,
        errorMessage: args.errorMessage,
        latencyMs: args.latencyMs,
        successCount: 0n,
        failCount: 0n,
        createdAt: ts,
        updatedAt: ts,
      });
    } else {
      const existing = ctx.db.proxyPool.id.find(args.id);
      if (!existing) throw new Error(`Proxy ${args.id} not found`);
      ctx.db.proxyPool.id.update({
        ...existing,
        url: args.url,
        proxyType: args.proxyType,
        label: args.label,
        status: args.status,
        errorMessage: args.errorMessage,
        latencyMs: args.latencyMs,
        updatedAt: ts,
      });
    }
  }
);

export const updateProxyStats = spacetimedb.reducer(
  {
    id: t.u64(),
    successCount: t.u64(),
    failCount: t.u64(),
    lastUsedAt: t.option(t.u64()),
    lastCheckedAt: t.option(t.u64()),
    latencyMs: t.option(t.u64()),
    status: t.string(),
    errorMessage: t.option(t.string()),
  },
  (ctx, args) => {
    const existing = ctx.db.proxyPool.id.find(args.id);
    if (!existing) return;
    ctx.db.proxyPool.id.update({
      ...existing,
      successCount: args.successCount,
      failCount: args.failCount,
      lastUsedAt: args.lastUsedAt,
      lastCheckedAt: args.lastCheckedAt,
      latencyMs: args.latencyMs,
      status: args.status,
      errorMessage: args.errorMessage,
      updatedAt: BigInt(Date.now()),
    });
  }
);

export const deleteProxy = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    ctx.db.proxyPool.id.delete(id);
  }
);

// ─── VCC Card Reducers ──────────────────────────────────────────────────────

export const upsertVccCard = spacetimedb.reducer(
  {
    id: t.u64(),
    number: t.string(),
    expMonth: t.string(),
    expYear: t.string(),
    cvv: t.string(),
    name: t.string(),
    status: t.string(),
    usedByAccountId: t.option(t.u64()),
  },
  (ctx, args) => {
    const ts = BigInt(Date.now());
    if (args.id === 0n) {
      ctx.db.vccCards.insert({
        id: 0n,
        number: args.number,
        expMonth: args.expMonth,
        expYear: args.expYear,
        cvv: args.cvv,
        name: args.name,
        status: args.status,
        usedByAccountId: args.usedByAccountId,
        createdAt: ts,
        updatedAt: ts,
      });
    } else {
      const existing = ctx.db.vccCards.id.find(args.id);
      if (!existing) throw new Error(`VCC card ${args.id} not found`);
      ctx.db.vccCards.id.update({
        ...existing,
        status: args.status,
        usedByAccountId: args.usedByAccountId,
        updatedAt: ts,
      });
    }
  }
);

export const deleteVccCard = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    ctx.db.vccCards.id.delete(id);
  }
);

// ─── VCC Transaction Reducers ───────────────────────────────────────────────

export const insertVccTransaction = spacetimedb.reducer(
  {
    accountId: t.option(t.u64()),
    cardLast4: t.string(),
    cardBrand: t.option(t.string()),
    amount: t.option(t.f64()),
    currency: t.string(),
    status: t.string(),
    stripeChargeId: t.option(t.string()),
  },
  (ctx, args) => {
    ctx.db.vccTransactions.insert({
      id: 0n,
      ...args,
      createdAt: BigInt(Date.now()),
    });
  }
);

// ─── Image Studio Reducers ──────────────────────────────────────────────────

export const upsertImageStudioChat = spacetimedb.reducer(
  {
    id: t.u64(),
    title: t.option(t.string()),
    messages: t.string(),
    finalPrompt: t.option(t.string()),
    options: t.string(),
    assistModel: t.option(t.string()),
  },
  (ctx, args) => {
    const ts = BigInt(Date.now());
    if (args.id === 0n) {
      ctx.db.imageStudioChats.insert({
        id: 0n,
        title: args.title,
        messages: args.messages,
        finalPrompt: args.finalPrompt,
        options: args.options,
        assistModel: args.assistModel,
        createdAt: ts,
        updatedAt: ts,
      });
    } else {
      const existing = ctx.db.imageStudioChats.id.find(args.id);
      if (!existing) throw new Error(`Chat ${args.id} not found`);
      ctx.db.imageStudioChats.id.update({
        ...existing,
        title: args.title,
        messages: args.messages,
        finalPrompt: args.finalPrompt,
        options: args.options,
        assistModel: args.assistModel,
        updatedAt: ts,
      });
    }
  }
);

export const deleteImageStudioChat = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    ctx.db.imageStudioChats.id.delete(id);
    // Also delete associated results
    for (const result of ctx.db.imageStudioResults.by_chat.filter(id)) {
      ctx.db.imageStudioResults.id.delete(result.id);
    }
  }
);

export const insertImageStudioResult = spacetimedb.reducer(
  {
    chatId: t.option(t.u64()),
    prompt: t.string(),
    resultType: t.string(),
    aspectRatio: t.string(),
    n: t.u32(),
    urls: t.string(),
    creditsUsed: t.f64(),
  },
  (ctx, args) => {
    ctx.db.imageStudioResults.insert({
      id: 0n,
      ...args,
      createdAt: BigInt(Date.now()),
    });
  }
);

// ─── Bulk Operations ────────────────────────────────────────────────────────

export const bulkDeleteRequestLogs = spacetimedb.reducer(
  { olderThanMs: t.u64() },
  (ctx, { olderThanMs }) => {
    for (const log of ctx.db.requestLogs.iter()) {
      if (log.createdAt < olderThanMs) {
        ctx.db.requestLogs.id.delete(log.id);
      }
    }
  }
);


