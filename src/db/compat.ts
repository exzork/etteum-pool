/**
 * Database compatibility layer.
 * 
 * This module provides the same interface as the old SQLite/Drizzle setup
 * but is backed by SpacetimeDB. All reads come from the local subscription
 * cache (instant), all writes go through reducers (realtime sync).
 * 
 * The old `db` and `client` exports are replaced with SpacetimeDB equivalents.
 */
import { initStdb, stdb, call, onTableChange, isReady, getStdbStatus, getAll, findById } from "../stdb/index";

export { initStdb, stdb, call, onTableChange, isReady, getStdbStatus };

// Re-export types that match the old schema types
export type Account = {
  id: bigint;
  provider: string;
  email: string;
  password: string;
  status: string;
  enabled: boolean;
  tokens: string | undefined;
  quotaLimit: number;
  quotaRemaining: number;
  quotaResetAt: bigint | undefined;
  lastUsedAt: bigint | undefined;
  lastLoginAt: bigint | undefined;
  errorMessage: string | undefined;
  metadata: string | undefined;
  createdAt: bigint;
  updatedAt: bigint;
};

export type ApiKey = {
  id: bigint;
  name: string;
  key: string;
  createdAt: bigint;
};

export type Setting = {
  key: string;
  value: string | undefined;
  updatedAt: bigint;
};

export type RequestLog = {
  id: bigint;
  accountId: bigint | undefined;
  provider: string;
  model: string | undefined;
  promptTokens: bigint;
  completionTokens: bigint;
  totalTokens: bigint;
  creditsUsed: number;
  status: string;
  durationMs: bigint | undefined;
  errorMessage: string | undefined;
  requestBody: string | undefined;
  responseBody: string | undefined;
  accountEmail: string | undefined;
  accountQuotaBefore: number;
  accountQuotaAfter: number;
  apiKeyId: bigint | undefined;
  apiKeyName: string | undefined;
  createdAt: bigint;
};

export type UsageSummary = {
  id: bigint;
  bucket: string;
  provider: string;
  model: string;
  apiKeyId: bigint;
  apiKeyName: string | undefined;
  totalRequests: bigint;
  successRequests: bigint;
  errorRequests: bigint;
  promptTokens: bigint;
  completionTokens: bigint;
  totalTokens: bigint;
  creditsUsed: number;
  totalDurationMs: bigint;
};

export type FilterRule = {
  id: bigint;
  ruleId: string;
  pattern: string;
  replacement: string;
  isActive: boolean;
  isRegex: boolean;
  sortOrder: number;
  createdAt: bigint;
  updatedAt: bigint;
};

export type ModelMapping = {
  id: bigint;
  sourcePattern: string;
  matchType: string;
  targetModel: string;
  enabled: boolean;
  priority: number;
  label: string | undefined;
  createdAt: bigint;
  updatedAt: bigint;
};

export type ProxyPoolEntry = {
  id: bigint;
  url: string;
  proxyType: string;
  label: string | undefined;
  status: string;
  lastUsedAt: bigint | undefined;
  lastCheckedAt: bigint | undefined;
  errorMessage: string | undefined;
  latencyMs: bigint | undefined;
  successCount: bigint;
  failCount: bigint;
  createdAt: bigint;
  updatedAt: bigint;
};

export type VccCard = {
  id: bigint;
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  name: string;
  status: string;
  usedByAccountId: bigint | undefined;
  createdAt: bigint;
  updatedAt: bigint;
};

export type ImageStudioChat = {
  id: bigint;
  title: string | undefined;
  messages: string;
  finalPrompt: string | undefined;
  options: string;
  assistModel: string | undefined;
  createdAt: bigint;
  updatedAt: bigint;
};

export type ImageStudioResult = {
  id: bigint;
  chatId: bigint | undefined;
  prompt: string;
  resultType: string;
  aspectRatio: string;
  n: number;
  urls: string;
  creditsUsed: number;
  createdAt: bigint;
};
