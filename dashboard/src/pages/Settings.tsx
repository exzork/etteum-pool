import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save, RefreshCw, Zap, Flame, Globe } from "lucide-react";
import {
  fetchSettings,
  updateSettings,
  fetchProviderList,
  fetchAutoWarmupStatus,
  type AutoWarmupStatus,
} from "@/lib/api";
import { useApi } from "@/hooks/useApi";
import { useTimedMessage } from "@/hooks/useTimedMessage";

const PROVIDER_LABELS: Record<string, string> = {
  kiro: "Kiro",
  "kiro-pro": "Kiro Pro",
  codebuddy: "CodeBuddy",
  canva: "Canva",
};

function labelFor(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider]!;
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export default function Settings() {
  const [form, setForm] = useState<Record<string, string>>({
    load_balancing_method: "round_robin",
    auto_warmup_interval_minutes: "15",
    proxy_pool_usage: "all",
    proxy_pool_rotation: "round_robin",
  });
  const [warmupStatus, setWarmupStatus] = useState<AutoWarmupStatus | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const providerListApi = useApi<{ data: string[] }>(fetchProviderList, []);

  const providers = useMemo(
    () => providerListApi.data?.data || [],
    [providerListApi.data]
  );

  async function load() {
    const res = (await fetchSettings()) as { data: Record<string, string> };
    setForm((current) => ({ ...current, ...(res.data || {}) }));
    setDirty(false);
    fetchAutoWarmupStatus().then(setWarmupStatus).catch(() => {});
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  function setValue(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function lbMethodFor(provider: string): string {
    return (
      form[`provider_${provider}_lb_method`] ||
      form.load_balancing_method ||
      "round_robin"
    );
  }

  function isOverride(provider: string): boolean {
    return Boolean(form[`provider_${provider}_lb_method`]);
  }

  async function save() {
    setSaving(true);
    try {
      await updateSettings(form);
      setSavedAt(new Date());
      setDirty(false);
      setMessage("Settings saved.");
    } finally {
      setSaving(false);
    }
  }

  const globalMethod = form.load_balancing_method || "round_robin";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Proxy Settings</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Configure load balancing and auto warmup
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && (
            <span className="text-xs text-[var(--warning)] px-2 py-1 rounded bg-[var(--warning)]/10">
              Unsaved
            </span>
          )}
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="w-4 h-4 mr-2" /> Reload
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            <Save className="w-4 h-4 mr-2" /> {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {message && (
        <div className="rounded-md bg-[var(--success)]/10 p-3 text-sm text-[var(--success)]">
          {message}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Load Balancing */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="w-4 h-4 text-[var(--primary)]" />
              Load Balancing
            </CardTitle>
            <CardDescription>
              Control how requests are distributed across accounts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Global Method
              </label>
              <select
                value={form.load_balancing_method || "round_robin"}
                onChange={(e) => setValue("load_balancing_method", e.target.value)}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">
                {globalMethod === "sequential"
                  ? "Uses accounts in order, moves to next only when current is exhausted."
                  : "Distributes requests evenly across all active accounts."}
              </p>
            </div>

            {providers.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-[var(--foreground)]">
                  Per-Provider Override
                </div>
                <div className="space-y-2">
                  {providers.map((provider) => {
                    const key = `provider_${provider}_lb_method`;
                    const effective = lbMethodFor(provider);
                    const overriden = isOverride(provider);
                    return (
                      <div
                        key={provider}
                        className="flex items-center justify-between gap-3 p-3 rounded-lg bg-[var(--secondary)] border border-transparent hover:border-[var(--border)] transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[var(--foreground)] flex items-center gap-2">
                            {labelFor(provider)}
                            {overriden && (
                              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--primary)]/20 text-[var(--primary)]">
                                override
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-[var(--muted-foreground)]">
                            {effective === "sequential" ? "Sequential" : "Round Robin"}
                            {!overriden && (
                              <span className="ml-1 text-[var(--muted-foreground)]/70">
                                (inherits global)
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={form[key] || ""}
                            onChange={(e) => setValue(key, e.target.value)}
                            className="h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
                          >
                            <option value="">Inherit</option>
                            <option value="round_robin">Round Robin</option>
                            <option value="sequential">Sequential</option>
                          </select>
                          {overriden && (
                            <button
                              type="button"
                              onClick={() => setValue(key, "")}
                              className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] px-2 py-1 rounded hover:bg-[var(--secondary)]"
                              title="Clear override"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Auto WarmUp */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Flame className="w-4 h-4 text-[var(--primary)]" />
              Auto WarmUp
            </CardTitle>
            <CardDescription>
              Automatically warm up enabled providers on a schedule
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm text-[var(--foreground)]">Interval (minutes)</label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={form.auto_warmup_interval_minutes || ""}
                onChange={(e) => setValue("auto_warmup_interval_minutes", e.target.value)}
                placeholder="15"
                className="mt-1"
              />
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                Global interval for all providers with Auto WarmUp enabled
              </p>
            </div>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-3 space-y-2">
              <p className="text-xs text-[var(--muted-foreground)]">Status</p>
              <p className="text-sm font-medium text-[var(--foreground)]">
                {warmupStatus && warmupStatus.enabledProviders.length > 0
                  ? `${warmupStatus.enabledProviders.length} provider${warmupStatus.enabledProviders.length === 1 ? "" : "s"} enabled`
                  : "No provider enabled"}
              </p>
              {warmupStatus?.enabledProviders && warmupStatus.enabledProviders.length > 0 && (
                <p className="text-xs text-[var(--muted-foreground)] truncate">
                  {warmupStatus.enabledProviders.map(labelFor).join(", ")}
                </p>
              )}
              {warmupStatus?.nextRunAt && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  Next run: {new Date(warmupStatus.nextRunAt).toLocaleTimeString()}
                </p>
              )}
              {savedAt && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  Last saved: {savedAt.toLocaleTimeString()}
                </p>
              )}
            </div>

            <p className="text-xs text-[var(--muted-foreground)]">
              Auto WarmUp checks accounts with status active, exhausted, or error (skips pending). Enable/disable per provider on the Accounts page.
            </p>
          </CardContent>
        </Card>

        {/* Proxy Pool */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="w-4 h-4 text-[var(--primary)]" />
              Proxy Pool
            </CardTitle>
            <CardDescription>
              Configure how the proxy pool is used for outgoing requests
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Usage Scope
              </label>
              <select
                value={form.proxy_pool_usage || "all"}
                onChange={(e) => setValue("proxy_pool_usage", e.target.value)}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="all">All — Model + Auth</option>
                <option value="model">Model Only — API requests only</option>
                <option value="auth">Auth Only — Login automation only</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">
                {form.proxy_pool_usage === "model"
                  ? "Proxies are only used for upstream model API calls. Auth/login runs without proxy."
                  : form.proxy_pool_usage === "auth"
                    ? "Proxies are only used for login automation. Model API calls go direct."
                    : "Proxies are used for both model API calls and login automation."}
              </p>
            </div>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Rotation Strategy
              </label>
              <select
                value={form.proxy_pool_rotation || "round_robin"}
                onChange={(e) => setValue("proxy_pool_rotation", e.target.value)}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">
                {form.proxy_pool_rotation === "sequential"
                  ? "Uses one proxy until it fails, then moves to the next in the list."
                  : "Distributes requests evenly across all active proxies in rotation."}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
