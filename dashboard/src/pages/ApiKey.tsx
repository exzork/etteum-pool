import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Copy, Plus, Trash2, RefreshCw, Eye, EyeOff, Pencil } from "lucide-react";
import { fetchAllApiKeys, createApiKey, deleteApiKey, regenerateApiKeySecret, updateApiKeyName, type ApiKeyEntry } from "@/lib/api";

export default function ApiKey() {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [showKeys, setShowKeys] = useState<Record<number, boolean>>({});
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetchAllApiKeys();
      setKeys(res.data || []);
    } catch {
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function flash(msg: string) {
    setMessage(msg);
    setTimeout(() => setMessage(null), 3000);
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await createApiKey(newName.trim(), newKey.trim() || undefined);
      setNewName("");
      setNewKey("");
      flash("API key created");
      load();
    } catch (e: any) {
      flash(e.message || "Failed to create key");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this API key? Any clients using it will lose access.")) return;
    try {
      await deleteApiKey(id);
      flash("API key deleted");
      load();
    } catch (e: any) {
      flash(e.message || "Failed to delete key");
    }
  }

  async function handleRegenerate(id: number) {
    if (!confirm("Regenerate this key? The old key will stop working immediately.")) return;
    try {
      await regenerateApiKeySecret(id);
      flash("Key regenerated");
      load();
    } catch (e: any) {
      flash(e.message || "Failed to regenerate key");
    }
  }

  async function handleRename(id: number) {
    if (!editName.trim()) return;
    try {
      await updateApiKeyName(id, editName.trim());
      setEditingId(null);
      flash("Key renamed");
      load();
    } catch (e: any) {
      flash(e.message || "Failed to rename key");
    }
  }

  function maskKey(key: string) {
    if (key.length <= 12) return "••••••••";
    return key.slice(0, 8) + "••••••••" + key.slice(-4);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">API Keys</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          Manage API keys for proxy access. Each key can be tracked independently in request logs.
        </p>
      </div>

      {message && (
        <div className="rounded-md bg-[var(--primary)]/10 p-3 text-sm text-[var(--primary)]">
          {message}
        </div>
      )}

      {/* Create new key */}
      <Card className="border-[var(--border)]">
        <CardHeader>
          <CardTitle className="text-base">Create New Key</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Key name (e.g. hermes, codex, team-a)"
              className="flex-1"
            />
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="Custom key (optional, auto-generated if empty)"
              className="flex-1 font-mono text-xs"
            />
            <Button onClick={handleCreate} disabled={!newName.trim()}>
              <Plus className="w-4 h-4 mr-2" /> Create
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Key list */}
      <Card className="border-[var(--border)]">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Name</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Key</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Source</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="p-4">
                      {editingId === k.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="h-7 text-sm w-40"
                            onKeyDown={(e) => e.key === "Enter" && handleRename(k.id)}
                          />
                          <Button size="sm" variant="outline" onClick={() => handleRename(k.id)}>Save</Button>
                          <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[var(--foreground)]">{k.name}</span>
                          {k.id !== 0 && (
                            <button onClick={() => { setEditingId(k.id); setEditName(k.name); }} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                              <Pencil className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <code className="text-xs text-[var(--muted-foreground)] font-mono">
                          {showKeys[k.id] ? k.key : maskKey(k.key)}
                        </code>
                        <button onClick={() => setShowKeys((s) => ({ ...s, [k.id]: !s[k.id] }))} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                          {showKeys[k.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                        <button onClick={() => { navigator.clipboard.writeText(k.key); flash("Copied!"); }} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="p-4">
                      <Badge variant={k.source === "env" ? "warning" : "success"} className="text-[10px]">
                        {k.source}
                      </Badge>
                    </td>
                    <td className="p-4">
                      {k.id !== 0 && (
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => handleRegenerate(k.id)}>
                            <RefreshCw className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => handleDelete(k.id)} className="text-[var(--error)] hover:text-[var(--error)]">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      )}
                      {k.id === 0 && (
                        <span className="text-xs text-[var(--muted-foreground)]">Set via DASHBOARD_PASSWORD env</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!loading && keys.length === 0 && (
                  <tr><td colSpan={4} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No API keys</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
