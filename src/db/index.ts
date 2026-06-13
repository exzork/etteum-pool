/**
 * Database layer — SpacetimeDB backed.
 *
 * Provides a drizzle-like query interface over the SpacetimeDB subscription cache.
 * All reads are instant (local cache). All writes go through reducers.
 *
 * This replaces the old SQLite + Drizzle + sync system entirely.
 */
import { initStdb, stdb, call, onTableChange, isReady, getStdbStatus } from "../stdb/index";
import type {
  Account, ApiKey, Setting, RequestLog, UsageSummary,
  FilterRule, ModelMapping, ProxyPoolEntry, VccCard,
  ImageStudioChat, ImageStudioResult,
} from "./compat";

export { initStdb, onTableChange, isReady, getStdbStatus, call };
export type { Account, ApiKey, Setting, RequestLog, UsageSummary, FilterRule, ModelMapping, ProxyPoolEntry, VccCard, ImageStudioChat, ImageStudioResult };

/**
 * Query helper that mimics drizzle's select().from() pattern.
 * Returns arrays from the SpacetimeDB subscription cache.
 */
export const db = {
  accounts: {
    getAll: (): Account[] => [...stdb.accounts.iter()] as any[],
    findById: (id: bigint): Account | undefined => stdb.accounts.id.find(id) as any,
    findByProviderEmail: (provider: string, email: string): Account | undefined => {
      for (const acc of stdb.accounts.iter()) {
        if ((acc as any).provider === provider && (acc as any).email === email) return acc as any;
      }
      return undefined;
    },
    getByProvider: (provider: string): Account[] => {
      return [...stdb.accounts.by_provider.filter(provider)] as any[];
    },
    getActive: (provider: string): Account[] => {
      const all = [...stdb.accounts.by_provider.filter(provider)] as any[];
      return all.filter((a: any) => a.status === "active" && a.enabled);
    },
  },
  apiKeys: {
    getAll: (): ApiKey[] => [...stdb.apiKeys.iter()] as any[],
    findById: (id: bigint): ApiKey | undefined => stdb.apiKeys.id.find(id) as any,
    findByKey: (key: string): ApiKey | undefined => stdb.apiKeys.key.find(key) as any,
  },
  settings: {
    getAll: (): Setting[] => [...stdb.settings.iter()] as any[],
    get: (key: string): string | undefined => {
      const row = stdb.settings.key.find(key) as any;
      return row?.value;
    },
    getRow: (key: string): Setting | undefined => stdb.settings.key.find(key) as any,
  },
  requestLogs: {
    getAll: (): RequestLog[] => [...stdb.requestLogs.iter()] as any[],
    findById: (id: bigint): RequestLog | undefined => stdb.requestLogs.id.find(id) as any,
    getRecent: (limit: number): RequestLog[] => {
      const all = [...stdb.requestLogs.iter()] as any[];
      all.sort((a: any, b: any) => Number(b.createdAt - a.createdAt));
      return all.slice(0, limit);
    },
    getByProvider: (provider: string): RequestLog[] => {
      return [...stdb.requestLogs.by_provider.filter(provider)] as any[];
    },
  },
  usageSummary: {
    getAll: (): UsageSummary[] => [...stdb.usageSummary.iter()] as any[],
  },
  filterRules: {
    getAll: (): FilterRule[] => [...stdb.filterRules.iter()] as any[],
    getActive: (): FilterRule[] => {
      const all = [...stdb.filterRules.iter()] as any[];
      return all.filter((r: any) => r.isActive).sort((a: any, b: any) => a.sortOrder - b.sortOrder);
    },
  },
  modelMappings: {
    getAll: (): ModelMapping[] => [...stdb.modelMappings.iter()] as any[],
    getEnabled: (): ModelMapping[] => {
      const all = [...stdb.modelMappings.iter()] as any[];
      return all.filter((m: any) => m.enabled).sort((a: any, b: any) => a.priority - b.priority);
    },
  },
  proxyPool: {
    getAll: (): ProxyPoolEntry[] => [...stdb.proxyPool.iter()] as any[],
    getActive: (): ProxyPoolEntry[] => {
      return ([...stdb.proxyPool.by_status.filter("active")] as any[]);
    },
  },
  vccCards: {
    getAll: (): VccCard[] => [...stdb.vccCards.iter()] as any[],
    getAvailable: (): VccCard[] => {
      return ([...stdb.vccCards.by_status.filter("active")] as any[]);
    },
  },
  imageStudioChats: {
    getAll: (): ImageStudioChat[] => [...stdb.imageStudioChats.iter()] as any[],
    findById: (id: bigint): ImageStudioChat | undefined => stdb.imageStudioChats.id.find(id) as any,
  },
  imageStudioResults: {
    getAll: (): ImageStudioResult[] => [...stdb.imageStudioResults.iter()] as any[],
    getByChatId: (chatId: bigint): ImageStudioResult[] => {
      return [...stdb.imageStudioResults.by_chat.filter(chatId)] as any[];
    },
  },
};

// Legacy compat: some code uses `client` for raw SQL — not available with SpacetimeDB
// These will need to be rewritten to use the db helpers above.
export const client = null;
