# BYOK (Bring Your Own Key) Feature Plan

## Overview
Tambahkan fitur BYOK agar user bisa menggunakan custom provider lain (OpenRouter, Together, Groq, DeepSeek, local LLM, dll) melalui Etteum Pool. Support OpenAI dan Anthropic API formats.

## Architecture Decision

### Storage Strategy
**Reuse `accounts` table** dengan field:
- `provider`: `"byok"` (semua BYOK providers pakai provider type ini)
- `email`: label/nama provider (e.g., "openrouter", "myrouter")
- `password`: encrypted API key (XOR cipher seperti existing)
- `tokens`: JSON blob dengan struktur:
  ```json
  {
    "base_url": "https://openrouter.ai/api/v1",
    "api_key": "sk-...",
    "format": "openai" | "anthropic" | "auto",
    "models": ["gpt-4o", "claude-sonnet-4.6"],
    "model_prefix": "openrouter"
  }
  ```
- `metadata`: extra config (headers, timeout, dll)

### Model Routing
**Custom prefix strategy**:
- User define label: `"openrouter"`
- Models: `["gpt-4o", "claude-sonnet-4.6"]`
- Available models: `openrouter-gpt-4o`, `openrouter-claude-sonnet-4.6`
- Request: `POST /v1/chat/completions { model: "openrouter-gpt-4o" }`
- Provider detect prefix → extract actual model → forward ke BYOK base_url

### Format Handling
**Smart format detection**:
1. User pilih format: `openai`, `anthropic`, atau `auto`
2. Jika `auto`:
   - Detect dari base_url pattern (openai.com, anthropic.com, dll)
   - Default ke `openai` jika tidak match
3. Provider transform otomatis:
   - **OpenAI format**: pass-through untuk OpenAI requests, transform Anthropic→OpenAI untuk Anthropic requests
   - **Anthropic format**: pass-through untuk Anthropic requests, transform OpenAI→Anthropic untuk OpenAI requests

## Implementation Plan

### Phase 1: Backend - BYOK Provider Core

#### 1.1 Create `src/proxy/providers/byok.ts`
```typescript
export class ByokProvider extends BaseProvider {
  name = "byok";
  supportedModels = []; // Dynamic, berdasarkan accounts
  
  constructor() {
    super({
      nativeFormat: "openai", // Will be overridden per-request
    });
  }
  
  // Override ownsModel untuk support dynamic prefix
  ownsModel(model: string): boolean {
    // Check if model starts with any BYOK account's prefix
    // e.g., "openrouter-gpt4o" matches account with prefix "openrouter"
  }
  
  // Extract actual model name from prefixed model
  private extractModel(model: string, prefix: string): string {
    return model.substring(prefix.length + 1);
  }
  
  // Detect format from base_url or use explicit
  private detectFormat(account: Account): "openai" | "anthropic" {
    const format = account.tokens.format;
    if (format === "auto") {
      const url = account.tokens.base_url;
      if (url.includes("anthropic.com")) return "anthropic";
      return "openai";
    }
    return format;
  }
  
  async chatCompletion(account, request) {
    const format = this.detectFormat(account);
    const actualModel = this.extractModel(request.model, account.tokens.model_prefix);
    
    if (format === "anthropic") {
      // Transform OpenAI → Anthropic
      // Call Anthropic API
      // Transform response back to OpenAI format
    } else {
      // Pass-through OpenAI
      // Call OpenAI-compatible API
    }
  }
  
  async chatCompletionStream(account, request) {
    // Similar logic with streaming
  }
  
  async refreshToken(account) {
    // BYOK doesn't need refresh, just validate
    return { success: true };
  }
  
  async validateAccount(account) {
    // Test API key dengan simple request
    // Return success/failure
  }
  
  async fetchQuota(account) {
    // Optional: jika BYOK provider expose usage endpoint
    // Default: return unlimited
    return { limit: -1, remaining: -1 };
  }
}
```

#### 1.2 Register di `src/proxy/providers/registry.ts`
```typescript
import { ByokProvider } from "./byok";

const byok = new ByokProvider();

export const PROVIDER_ORDER = [
  canva,
  qoder,
  codex,
  codebuddy,
  kiroPro,
  byok, // ← Tambah sebelum fallback
  kiro, // fallback
];

export const providers = {
  // ... existing
  byok,
};
```

#### 1.3 Update `src/proxy/pool.ts`
```typescript
// Tambah method untuk get BYOK accounts dengan prefix
async getByokAccounts(): Promise<Account[]> {
  // Fetch all accounts where provider = "byok"
  // Return dengan parsed tokens
}

// Update getNextAccount untuk support BYOK
async getNextAccount(provider: string, model: string) {
  if (provider === "byok") {
    // Find BYOK account yang owns this model (by prefix)
    // Return account dengan model match
  }
  // ... existing logic
}
```

### Phase 2: Backend - API Endpoints

#### 2.1 BYOK Management di `src/api/accounts.ts`

```typescript
// POST /api/accounts/byok - Create BYOK provider
accountsRouter.post("/byok", async (c) => {
  const body = await c.req.json();
  const { label, base_url, api_key, format, models } = body;
  
  // Validate
  if (!label || !base_url || !api_key || !models?.length) {
    return c.json({ error: "Missing required fields" }, 400);
  }
  
  // Check uniqueness (provider + email/label)
  const existing = db.select().from(accounts)
    .where(and(eq(accounts.provider, "byok"), eq(accounts.email, label)))
    .get();
  
  if (existing) {
    return c.json({ error: "BYOK provider with this label already exists" }, 409);
  }
  
  // Encrypt API key
  const encryptedKey = encrypt(api_key);
  
  // Create account
  const tokens = {
    base_url,
    api_key, // Will be encrypted separately or use password field
    format: format || "auto",
    models,
    model_prefix: label,
  };
  
  const result = db.insert(accounts).values({
    provider: "byok",
    email: label,
    password: encryptedKey,
    status: "active",
    enabled: true,
    tokens: JSON.stringify(tokens),
    quotaLimit: -1, // Unlimited
    quotaRemaining: -1,
  }).returning().get();
  
  // Broadcast via WebSocket
  broadcast("byok_created", { id: result.id, label });
  
  return c.json({ success: true, account: result });
});

// GET /api/accounts/byok - List all BYOK providers
accountsRouter.get("/byok", async (c) => {
  const byokAccounts = db.select().from(accounts)
    .where(eq(accounts.provider, "byok"))
    .all();
  
  return c.json({
    providers: byokAccounts.map(acc => ({
      id: acc.id,
      label: acc.email,
      base_url: acc.tokens?.base_url,
      format: acc.tokens?.format,
      models: acc.tokens?.models,
      model_prefix: acc.tokens?.model_prefix,
      status: acc.status,
      enabled: acc.enabled,
    })),
  });
});

// PATCH /api/accounts/byok/:id - Update BYOK provider
accountsRouter.patch("/byok/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json();
  
  // Update tokens JSON
  const account = db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }
  
  const tokens = JSON.parse(account.tokens || "{}");
  if (body.base_url) tokens.base_url = body.base_url;
  if (body.format) tokens.format = body.format;
  if (body.models) tokens.models = body.models;
  if (body.api_key) {
    tokens.api_key = body.api_key;
    // Re-encrypt password field
  }
  
  db.update(accounts)
    .set({ tokens: JSON.stringify(tokens), updatedAt: new Date() })
    .where(eq(accounts.id, id))
    .run();
  
  broadcast("byok_updated", { id });
  return c.json({ success: true });
});

// DELETE /api/accounts/byok/:id - Delete BYOK provider
accountsRouter.delete("/byok/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  
  // Same cleanup as regular account deletion
  db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id)).run();
  db.delete(accounts).where(eq(accounts.id, id)).run();
  
  broadcast("byok_deleted", { id });
  return c.json({ success: true });
});

// POST /api/accounts/byok/:id/test - Test BYOK connection
accountsRouter.post("/byok/:id/test", async (c) => {
  const id = parseInt(c.req.param("id"));
  const account = db.select().from(accounts).where(eq(accounts.id, id)).get();
  
  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }
  
  const provider = providers.byok as ByokProvider;
  const result = await provider.validateAccount(account);
  
  return c.json(result);
});
```

#### 2.2 Update `src/proxy/index.ts` - Model Listing

```typescript
proxyRouter.get("/v1/models", (c) => {
  const baseModels = getAllModels();
  
  // Add BYOK models
  const byokAccounts = db.select().from(accounts)
    .where(and(eq(accounts.provider, "byok"), eq(accounts.enabled, 1)))
    .all();
  
  const byokModels = byokAccounts.flatMap(acc => {
    const prefix = acc.tokens?.model_prefix || acc.email;
    const models = acc.tokens?.models || [];
    return models.map(m => `${prefix}-${m}`);
  });
  
  const allModels = [...baseModels, ...byokModels.map(id => ({
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "byok",
  }))];
  
  return c.json({ object: "list", data: allModels });
});
```

### Phase 3: Frontend - Dashboard UI

#### 3.1 Tambah Section di `dashboard/src/pages/Accounts.tsx`

```tsx
// Import icons
import { Key, Plus, Trash2, TestTube } from "lucide-react";

// Add BYOK section after existing provider cards
<div className="mt-8">
  <div className="flex items-center justify-between mb-4">
    <h2 className="text-xl font-semibold flex items-center gap-2">
      <Key className="w-5 h-5" />
      Custom Providers (BYOK)
    </h2>
    <Button onClick={() => setShowByokDialog(true)}>
      <Plus className="w-4 h-4 mr-2" />
      Add Provider
    </Button>
  </div>
  
  <div className="grid gap-4">
    {byokProviders.map(provider => (
      <Card key={provider.id}>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>{provider.label}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => testByok(provider.id)}>
                <TestTube className="w-4 h-4" />
              </Button>
              <Button size="sm" variant="destructive" onClick={() => deleteByok(provider.id)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm space-y-1">
            <div><strong>Base URL:</strong> {provider.base_url}</div>
            <div><strong>Format:</strong> {provider.format}</div>
            <div><strong>Models:</strong> {provider.models.join(", ")}</div>
            <div><strong>Model Prefix:</strong> {provider.model_prefix}-*</div>
            <div><strong>Status:</strong> <Badge>{provider.status}</Badge></div>
          </div>
        </CardContent>
      </Card>
    ))}
  </div>
</div>

// BYOK Dialog/Modal
<Dialog open={showByokDialog} onOpenChange={setShowByokDialog}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Add Custom Provider</DialogTitle>
    </DialogHeader>
    <form onSubmit={handleByokSubmit}>
      <div className="space-y-4">
        <div>
          <Label>Provider Name / Label</Label>
          <Input 
            name="label" 
            placeholder="openrouter" 
            required 
            pattern="[a-z0-9-]+"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Lowercase letters, numbers, and hyphens only. Used as model prefix.
          </p>
        </div>
        
        <div>
          <Label>Base URL</Label>
          <Input 
            name="base_url" 
            placeholder="https://openrouter.ai/api/v1" 
            required 
          />
        </div>
        
        <div>
          <Label>API Key</Label>
          <Input 
            name="api_key" 
            type="password" 
            placeholder="sk-..." 
            required 
          />
        </div>
        
        <div>
          <Label>API Format</Label>
          <Select name="format" defaultValue="auto">
            <SelectItem value="auto">Auto-detect</SelectItem>
            <SelectItem value="openai">OpenAI</SelectItem>
            <SelectItem value="anthropic">Anthropic</SelectItem>
          </Select>
        </div>
        
        <div>
          <Label>Models (comma-separated)</Label>
          <Input 
            name="models" 
            placeholder="gpt-4o, claude-sonnet-4.6, llama-3.1-70b" 
            required 
          />
        </div>
      </div>
      
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => setShowByokDialog(false)}>
          Cancel
        </Button>
        <Button type="submit">Add Provider</Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
```

#### 3.2 API Client di `dashboard/src/lib/api.ts`

```typescript
// BYOK API functions
export async function fetchByokProviders() {
  return fetchApi<{ providers: ByokProvider[] }>("/api/accounts/byok");
}

export async function createByokProvider(data: {
  label: string;
  base_url: string;
  api_key: string;
  format: "auto" | "openai" | "anthropic";
  models: string[];
}) {
  return fetchApi("/api/accounts/byok", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateByokProvider(id: number, data: Partial<ByokProvider>) {
  return fetchApi(`/api/accounts/byok/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteByokProvider(id: number) {
  return fetchApi(`/api/accounts/byok/${id}`, { method: "DELETE" });
}

export async function testByokProvider(id: number) {
  return fetchApi(`/api/accounts/byok/${id}/test`, { method: "POST" });
}

// Type definition
export interface ByokProvider {
  id: number;
  label: string;
  base_url: string;
  format: "auto" | "openai" | "anthropic";
  models: string[];
  model_prefix: string;
  status: string;
  enabled: boolean;
}
```

#### 3.3 WebSocket Events

Add event handlers for real-time updates:
```typescript
useWsEvent("byok_created", (data) => {
  // Refresh BYOK list
  fetchByokProviders();
  toast.success(`BYOK provider "${data.label}" created`);
});

useWsEvent("byok_updated", (data) => {
  fetchByokProviders();
});

useWsEvent("byok_deleted", (data) => {
  fetchByokProviders();
  toast.success("BYOK provider deleted");
});
```

### Phase 4: Testing & Documentation

#### 4.1 Test File: `test/proxy/byok-provider.test.ts`

```typescript
import { describe, expect, it } from "bun:test";
import { ByokProvider } from "../../src/proxy/providers/byok";

describe("ByokProvider", () => {
  it("should detect OpenAI format from base_url", () => {
    const account = {
      tokens: {
        base_url: "https://api.openai.com/v1",
        format: "auto",
      },
    };
    const provider = new ByokProvider();
    expect(provider.detectFormat(account)).toBe("openai");
  });
  
  it("should detect Anthropic format from base_url", () => {
    const account = {
      tokens: {
        base_url: "https://api.anthropic.com",
        format: "auto",
      },
    };
    expect(provider.detectFormat(account)).toBe("anthropic");
  });
  
  it("should extract model name from prefix", () => {
    const provider = new ByokProvider();
    expect(provider.extractModel("openrouter-gpt4o", "openrouter")).toBe("gpt4o");
  });
  
  it("should own model with matching prefix", () => {
    // Mock BYOK account with prefix "myrouter"
    // Test ownsModel("myrouter-gpt4o") returns true
  });
});
```

#### 4.2 Update README.md

Add section:
```markdown
## BYOK (Bring Your Own Key)

Use custom AI providers through Etteum Pool:

### Setup

1. Open Dashboard → **Accounts** page
2. Scroll to **Custom Providers (BYOK)** section
3. Click **Add Provider**
4. Fill in:
   - **Provider Name**: `openrouter` (lowercase, used as prefix)
   - **Base URL**: `https://openrouter.ai/api/v1`
   - **API Key**: Your provider's API key
   - **Format**: Auto-detect / OpenAI / Anthropic
   - **Models**: `gpt-4o, claude-sonnet-4.6, llama-3.1-70b`

### Usage

Once added, models are available with your prefix:

```bash
# OpenRouter example
curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter-gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Anthropic format provider
curl http://localhost:1930/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "myanthropic-claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Supported Formats

- **OpenAI-compatible**: OpenRouter, Together AI, Groq, DeepSeek, local Ollama
- **Anthropic**: Custom Anthropic API endpoints
- **Auto-detect**: Automatically detects format from base URL
```

## Files to Create/Modify

### New Files
- `src/proxy/providers/byok.ts` - BYOK provider implementation
- `test/proxy/byok-provider.test.ts` - Tests

### Modified Files
- `src/proxy/providers/registry.ts` - Register BYOK provider
- `src/proxy/pool.ts` - Support BYOK account selection
- `src/proxy/index.ts` - Include BYOK models in /v1/models
- `src/api/accounts.ts` - BYOK CRUD endpoints
- `dashboard/src/pages/Accounts.tsx` - BYOK UI section
- `dashboard/src/lib/api.ts` - BYOK API client functions
- `README.md` - Documentation

## Implementation Order

1. ✅ **Phase 1**: Backend - BYOK Provider Core (byok.ts + registry + pool)
2. ✅ **Phase 2**: Backend - API Endpoints (accounts.ts + index.ts)
3. ✅ **Phase 3**: Frontend - Dashboard UI (Accounts.tsx + api.ts)
4. ✅ **Phase 4**: Testing & Documentation

## Security Considerations

1. **API Key Storage**: API keys encrypted with XOR cipher (same as existing)
   - Future improvement: migrate to AES-256-GCM
2. **Input Validation**: 
   - Label: alphanumeric + hyphens only (prevent injection)
   - Base URL: must be valid HTTPS URL (no HTTP in production)
   - Models: sanitized (no special chars except `-`, `.`, `_`)
3. **Rate Limiting**: BYOK requests count toward global rate limit
4. **Logging**: API keys redacted in logs (existing redaction logic)

## Testing Strategy

1. **Unit Tests**: ByokProvider format detection, model extraction, routing
2. **Integration Tests**: Full request flow with mock BYOK server
3. **Manual Tests**: 
   - Add OpenRouter account → test with real API
   - Add Anthropic account → test with real API
   - Test error handling (invalid key, rate limit, quota)

## Future Enhancements (Out of Scope for v1)

- [ ] Multiple API keys per BYOK provider (load balancing)
- [ ] Usage tracking and cost estimation for BYOK
- [ ] Custom headers support (for providers that require it)
- [ ] Proxy support for BYOK requests (use proxy pool)
- [ ] Health monitoring dashboard for BYOK providers
- [ ] Automatic model discovery from BYOK provider

## Success Criteria

- [ ] User can add BYOK provider via dashboard
- [ ] BYOK models appear in /v1/models endpoint
- [ ] Requests to BYOK models are routed correctly
- [ ] Both OpenAI and Anthropic formats work
- [ ] Error handling matches existing providers
- [ ] API keys are encrypted at rest
- [ ] Tests pass with >80% coverage
