import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, modelColor } from "@/lib/utils";
import { fetchPerAccountUsage, type PerAccountUsageRow } from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";

interface Props {
  /** API-key filter inherited from the page header */
  apiKeyId?: number;
}

const PROVIDER_LABELS: Record<string, string> = {
  kiro: "Kiro",
  "kiro-pro": "Kiro Pro",
  codebuddy: "CodeBuddy",
  canva: "Canva",
  "gitlab-duo": "GitLab Duo",
};

function labelForProvider(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider]!;
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function statusColor(status: string | null, enabled: boolean | null): string {
  if (enabled === false) return "text-[var(--muted-foreground)]";
  switch (status) {
    case "active": return "text-emerald-400";
    case "exhausted": return "text-amber-400";
    case "error": return "text-red-400";
    case "pending": return "text-sky-400";
    default: return "text-[var(--muted-foreground)]";
  }
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function formatWindow(windowStartIso: string | null): string {
  if (!windowStartIso) return "no requests yet";
  const ms = Date.now() - new Date(windowStartIso).getTime();
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `last ~${min} min`;
  const hr = Math.round(min / 60);
  return `last ~${hr}h`;
}

export default function PerAccountAverage({ apiKeyId }: Props) {
  const [rows, setRows] = useState<PerAccountUsageRow[]>([]);
  const [meta, setMeta] = useState<{
    totalLogs: number;
    uniqueAccounts: number;
    windowStartIso: string | null;
  }>({ totalLogs: 0, uniqueAccounts: 0, windowStartIso: null });
  const [loading, setLoading] = useState(true);
  const [providerFilter, setProviderFilter] = useState<string>("");
  const [showAll, setShowAll] = useState(false);
  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetchPerAccountUsage(
        apiKeyId,
        providerFilter || undefined,
      );
      setRows(res.data || []);
      setMeta({
        totalLogs: res.meta?.totalLogs || 0,
        uniqueAccounts: res.meta?.uniqueAccounts || 0,
        windowStartIso: res.meta?.windowStartIso ?? null,
      });
    } catch {
      setRows([]);
      setMeta({ totalLogs: 0, uniqueAccounts: 0, windowStartIso: null });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyId, providerFilter]);

  // Refresh on every new request log so the panel stays live (debounced 750ms
  // so a burst of WS events only triggers one fetch).
  useWsEvent(["request_log", "request_error"], () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => {
      load();
    }, 750);
  });

  useEffect(() => {
    return () => {
      if (reloadRef.current) clearTimeout(reloadRef.current);
    };
  }, []);

  // Provider list for the filter dropdown — derived from rows so it only shows
  // providers that actually have traffic in the window.
  const providersInData = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.provider);
    return Array.from(set).sort();
  }, [rows]);

  // Aggregate totals across the visible rows
  const totals = useMemo(() => {
    let tokens = 0;
    let requests = 0;
    for (const r of rows) {
      tokens += r.totalTokens;
      requests += r.totalRequests;
    }
    const accounts = rows.filter((r) => r.accountId !== null).length;
    return {
      tokens,
      requests,
      accounts,
      avgTokensPerAccount: accounts > 0 ? tokens / accounts : 0,
      avgRequestsPerAccount: accounts > 0 ? requests / accounts : 0,
    };
  }, [rows]);

  const maxTokens = useMemo(
    () => Math.max(1, ...rows.map((r) => r.totalTokens)),
    [rows],
  );

  const visibleRows = showAll ? rows : rows.slice(0, 10);

  return (
    <Card className="border-[var(--border)]">
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">Tokens per Account</CardTitle>
            <p className="text-sm text-[var(--muted-foreground)] mt-1">
              Per-account consumption from request logs ·{" "}
              <span className="text-[var(--foreground)]">
                {formatWindow(meta.windowStartIso)}
              </span>{" "}
              · {meta.totalLogs} requests across {meta.uniqueAccounts} accounts
            </p>
          </div>
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
          >
            <option value="">All Providers</option>
            {providersInData.map((p) => (
              <option key={p} value={p}>{labelForProvider(p)}</option>
            ))}
          </select>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Aggregate cards */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3">
            <p className="text-xs text-[var(--muted-foreground)]">Tokens (window)</p>
            <p className="text-xl font-bold mt-1">{formatNumber(totals.tokens)}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3">
            <p className="text-xs text-[var(--muted-foreground)]">Accounts Used</p>
            <p className="text-xl font-bold mt-1">{formatNumber(totals.accounts)}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3">
            <p className="text-xs text-[var(--muted-foreground)]">Avg Tokens / Account</p>
            <p className="text-xl font-bold mt-1">
              {formatNumber(Math.round(totals.avgTokensPerAccount))}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3">
            <p className="text-xs text-[var(--muted-foreground)]">Avg Requests / Account</p>
            <p className="text-xl font-bold mt-1">
              {formatNumber(Math.round(totals.avgRequestsPerAccount))}
            </p>
          </div>
        </div>

        {/* Table */}
        <div>
          <div className="hidden md:grid grid-cols-12 gap-3 text-xs uppercase tracking-wide text-[var(--muted-foreground)] mb-2 px-1">
            <div className="col-span-4">Account</div>
            <div className="col-span-2">Provider</div>
            <div className="col-span-2 text-right">Requests</div>
            <div className="col-span-2 text-right">Tokens</div>
            <div className="col-span-2 text-right">Last seen</div>
          </div>

          {loading && rows.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">
              No request activity in the recent window.
            </p>
          ) : (
            <div className="space-y-2">
              {visibleRows.map((row, idx) => {
                const color = modelColor(`${row.provider}/${row.accountEmail || row.accountId || "?"}`, idx);
                const errorRate =
                  row.totalRequests > 0
                    ? (row.errorRequests / row.totalRequests) * 100
                    : 0;
                return (
                  <div
                    key={row.accountId ?? `noacc-${row.provider}`}
                    className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/50 p-3"
                  >
                    <div className="grid grid-cols-2 md:grid-cols-12 gap-3 items-center">
                      <div className="md:col-span-4 flex items-center gap-2 min-w-0">
                        <span
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {row.accountEmail || (
                              <span className="text-[var(--muted-foreground)] italic">
                                {row.accountId === null
                                  ? "(no account attribution)"
                                  : `Account #${row.accountId} (deleted)`}
                              </span>
                            )}
                          </div>
                          {row.status ? (
                            <div className={`text-xs ${statusColor(row.status, row.enabled)}`}>
                              {row.enabled === false ? "disabled · " : ""}
                              {row.status}
                              {errorRate > 0 ? (
                                <span className="text-[var(--muted-foreground)]">
                                  {" "}· {errorRate.toFixed(0)}% errors
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="md:col-span-2">
                        <span className="md:hidden text-xs text-[var(--muted-foreground)] mr-2">
                          Provider:
                        </span>
                        <span className="text-sm">{labelForProvider(row.provider)}</span>
                      </div>

                      <div className="md:col-span-2 md:text-right">
                        <span className="md:hidden text-xs text-[var(--muted-foreground)] mr-2">
                          Requests:
                        </span>
                        <span className="font-medium">{formatNumber(row.totalRequests)}</span>
                      </div>

                      <div className="md:col-span-2 md:text-right">
                        <span className="md:hidden text-xs text-[var(--muted-foreground)] mr-2">
                          Tokens:
                        </span>
                        <span className="font-semibold">{formatNumber(row.totalTokens)}</span>
                      </div>

                      <div className="md:col-span-2 md:text-right text-xs text-[var(--muted-foreground)]">
                        {formatRelative(row.lastSeenAt)}
                      </div>
                    </div>

                    {/* Bar — relative to the busiest account in the window */}
                    <div className="mt-2 h-1.5 rounded-full bg-[var(--secondary)] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(100, (row.totalTokens / maxTokens) * 100)}%`,
                          backgroundColor: color,
                        }}
                      />
                    </div>
                  </div>
                );
              })}

              {rows.length > 10 && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] mt-2"
                >
                  {showAll ? `Show top 10 only` : `Show all ${rows.length} accounts`}
                </button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
