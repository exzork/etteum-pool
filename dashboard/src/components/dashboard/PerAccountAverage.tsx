import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, modelColor } from "@/lib/utils";

interface ModelUsage {
  provider?: string;
  model: string;
  tokens: number;
  requests?: number;
}

export interface ProviderAccountInfo {
  provider: string;
  totalAccounts: number;
  activeAccounts: number;
  exhaustedAccounts?: number;
  errorAccounts?: number;
}

interface Props {
  modelUsage: ModelUsage[];
  providers: ProviderAccountInfo[];
  /** Human label for the active period — used in the subtitle */
  periodLabel?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  kiro: "Kiro",
  "kiro-pro": "Kiro Pro",
  codebuddy: "CodeBuddy",
  canva: "Canva",
  "gitlab-duo": "GitLab Duo",
};

function labelFor(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider]!;
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

interface Row {
  provider: string;
  tokens: number;
  requests: number;
  totalAccounts: number;
  activeAccounts: number;
  perAccount: number;
  perActiveAccount: number;
  color: string;
}

export default function PerAccountAverage({ modelUsage, providers, periodLabel }: Props) {
  // Aggregate period-aware tokens per provider from modelUsage
  const tokensByProvider = new Map<string, { tokens: number; requests: number }>();
  for (const m of modelUsage) {
    const provider = m.provider || "unknown";
    const existing = tokensByProvider.get(provider) || { tokens: 0, requests: 0 };
    existing.tokens += Number(m.tokens || 0);
    existing.requests += Number(m.requests || 0);
    tokensByProvider.set(provider, existing);
  }

  // Build rows: include any provider with accounts OR usage so empty providers
  // are still visible (gives a sense of capacity headroom).
  const providerKeys = new Set<string>([
    ...providers.map((p) => p.provider),
    ...tokensByProvider.keys(),
  ]);

  const rows: Row[] = Array.from(providerKeys).map((provider, idx) => {
    const info = providers.find((p) => p.provider === provider);
    const usage = tokensByProvider.get(provider) || { tokens: 0, requests: 0 };
    const totalAccounts = info?.totalAccounts || 0;
    const activeAccounts = info?.activeAccounts || 0;
    return {
      provider,
      tokens: usage.tokens,
      requests: usage.requests,
      totalAccounts,
      activeAccounts,
      perAccount: totalAccounts > 0 ? usage.tokens / totalAccounts : 0,
      perActiveAccount: activeAccounts > 0 ? usage.tokens / activeAccounts : 0,
      color: modelColor(provider, idx),
    };
  });

  // Sort by per-account average desc — most-consumed-per-account at the top
  rows.sort((a, b) => b.perAccount - a.perAccount);

  // Aggregate totals across providers
  const totalTokens = rows.reduce((sum, r) => sum + r.tokens, 0);
  const totalAccounts = rows.reduce((sum, r) => sum + r.totalAccounts, 0);
  const totalActive = rows.reduce((sum, r) => sum + r.activeAccounts, 0);
  const overallPerAccount = totalAccounts > 0 ? totalTokens / totalAccounts : 0;
  const overallPerActive = totalActive > 0 ? totalTokens / totalActive : 0;

  const maxPerAccount = Math.max(1, ...rows.map((r) => r.perAccount));

  return (
    <Card className="border-[var(--border)]">
      <CardHeader>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-lg">Tokens per Account</CardTitle>
          {periodLabel ? (
            <span className="text-xs text-[var(--muted-foreground)]">{periodLabel}</span>
          ) : null}
        </div>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          Average tokens consumed per account, by provider — useful to see how heavily
          the account pool is being drained.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Top-line aggregate cards */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3">
            <p className="text-xs text-[var(--muted-foreground)]">Total Tokens</p>
            <p className="text-xl font-bold mt-1">{formatNumber(totalTokens)}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3">
            <p className="text-xs text-[var(--muted-foreground)]">Accounts</p>
            <p className="text-xl font-bold mt-1">
              {formatNumber(totalActive)}
              <span className="text-sm font-normal text-[var(--muted-foreground)]">
                {" "}
                / {formatNumber(totalAccounts)}
              </span>
            </p>
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5">active / total</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3">
            <p className="text-xs text-[var(--muted-foreground)]">Avg / Account</p>
            <p className="text-xl font-bold mt-1">{formatNumber(Math.round(overallPerAccount))}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3">
            <p className="text-xs text-[var(--muted-foreground)]">Avg / Active Account</p>
            <p className="text-xl font-bold mt-1">{formatNumber(Math.round(overallPerActive))}</p>
          </div>
        </div>

        {/* Per-provider breakdown */}
        <div>
          <div className="hidden md:grid grid-cols-12 gap-3 text-xs uppercase tracking-wide text-[var(--muted-foreground)] mb-2 px-1">
            <div className="col-span-3">Provider</div>
            <div className="col-span-2 text-right">Tokens</div>
            <div className="col-span-2 text-right">Accounts (active/total)</div>
            <div className="col-span-2 text-right">Avg / Account</div>
            <div className="col-span-3 text-right">Avg / Active Account</div>
          </div>

          <div className="space-y-3">
            {rows.map((row) => (
              <div
                key={row.provider}
                className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/50 p-3"
              >
                <div className="grid grid-cols-2 md:grid-cols-12 gap-3 items-center">
                  <div className="md:col-span-3 flex items-center gap-2 min-w-0">
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: row.color }}
                    />
                    <span className="truncate font-medium">{labelFor(row.provider)}</span>
                  </div>

                  <div className="md:col-span-2 md:text-right">
                    <span className="md:hidden text-xs text-[var(--muted-foreground)] mr-2">
                      Tokens
                    </span>
                    <span className="font-medium">{formatNumber(row.tokens)}</span>
                    {row.requests > 0 ? (
                      <span className="ml-2 text-xs text-[var(--muted-foreground)]">
                        · {formatNumber(row.requests)} req
                      </span>
                    ) : null}
                  </div>

                  <div className="md:col-span-2 md:text-right">
                    <span className="md:hidden text-xs text-[var(--muted-foreground)] mr-2">
                      Accounts
                    </span>
                    <span className="font-medium">{row.activeAccounts}</span>
                    <span className="text-[var(--muted-foreground)]">
                      {" "}
                      / {row.totalAccounts}
                    </span>
                  </div>

                  <div className="md:col-span-2 md:text-right">
                    <span className="md:hidden text-xs text-[var(--muted-foreground)] mr-2">
                      Avg / Account
                    </span>
                    <span className="font-semibold">
                      {row.totalAccounts > 0
                        ? formatNumber(Math.round(row.perAccount))
                        : "—"}
                    </span>
                  </div>

                  <div className="md:col-span-3 md:text-right">
                    <span className="md:hidden text-xs text-[var(--muted-foreground)] mr-2">
                      Avg / Active Account
                    </span>
                    <span className="font-semibold">
                      {row.activeAccounts > 0
                        ? formatNumber(Math.round(row.perActiveAccount))
                        : "—"}
                    </span>
                  </div>
                </div>

                {/* Bar — relative to the heaviest-consumed provider on this page */}
                <div className="mt-2 h-1.5 rounded-full bg-[var(--secondary)] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, (row.perAccount / maxPerAccount) * 100)}%`,
                      backgroundColor: row.color,
                    }}
                  />
                </div>
              </div>
            ))}

            {rows.length === 0 && (
              <p className="text-sm text-[var(--muted-foreground)]">
                No provider data yet
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
