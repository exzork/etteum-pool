import TokenUsage from "@/components/dashboard/TokenUsage";
import PerAccountAverage, {
  type ProviderAccountInfo,
} from "@/components/dashboard/PerAccountAverage";
import { useEffect, useState, useRef } from "react";
import {
  fetchDashboardStats,
  fetchModelUsage,
  fetchAllApiKeys,
  fetchProviders,
  type ApiKeyEntry,
} from "@/lib/api";
import { modelColor } from "@/lib/utils";
import { useWsEvent } from "@/hooks/useWebSocket";

export default function Usage() {
  const [stats, setStats] = useState<any>(null);
  const [modelStats, setModelStats] = useState<any[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<number>(0);
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccountInfo[]>([]);
  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchAllApiKeys().then((res) => setApiKeys(res.data || [])).catch(() => {});
  }, []);

  async function load() {
    const keyParam = selectedKeyId > 0 ? selectedKeyId : undefined;
    await Promise.all([
      fetchDashboardStats(undefined, undefined, keyParam).then(setStats).catch(() => setStats(null)),
      fetchModelUsage(undefined, undefined, keyParam).then((res: { data: any[] }) => setModelStats(res.data || [])).catch(() => setModelStats([])),
      fetchProviders()
        .then((res: { data: ProviderAccountInfo[] }) => setProviderAccounts(res.data || []))
        .catch(() => setProviderAccounts([])),
    ]);
  }

  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { load(); }, 500);
  };

  useEffect(() => {
    load();
    return () => { if (reloadRef.current) clearTimeout(reloadRef.current); };
  }, [selectedKeyId]);

  useWsEvent(["request_log", "request_error"], scheduleReload);

  const tokenStats = {
    total: Number(stats?.tokens?.total || 0),
    prompt: Number(stats?.tokens?.prompt || 0),
    completion: Number(stats?.tokens?.completion || 0),
    credits: Number(stats?.tokens?.credits || 0),
  };

  // Filter model usage by selected API key (client-side for now since usage_summary
  // doesn't have per-key breakdown in the aggregated view)
  const modelUsage = modelStats.map((m, idx) => ({
    provider: m.provider || "unknown",
    model: m.model || "unknown",
    tokens: Number(m.totalTokens || 0),
    promptTokens: Number(m.promptTokens || 0),
    completionTokens: Number(m.completionTokens || 0),
    credits: Number(m.credits || 0),
    requests: Number(m.totalRequests || 0),
    creditSource: m.creditSource || "estimated",
    color: modelColor(`${m.provider || "unknown"}/${m.model || "unknown"}`, idx),
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Usage</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Detailed token and credit usage analytics
          </p>
        </div>
        <select
          value={selectedKeyId}
          onChange={(e) => setSelectedKeyId(Number(e.target.value))}
          className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
        >
          <option value={0}>All API Keys</option>
          {apiKeys.map((k) => (
            <option key={k.id} value={k.id}>{k.name}</option>
          ))}
        </select>
      </div>

      <TokenUsage stats={tokenStats} modelUsage={modelUsage} />

      <PerAccountAverage
        modelUsage={modelUsage}
        providers={providerAccounts}
        periodLabel="Lifetime totals"
      />
    </div>
  );
}
