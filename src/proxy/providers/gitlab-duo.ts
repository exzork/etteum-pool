import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/index";

// ============================================================================
// GitLab Duo Provider — WebSocket / Duo Workflow edition
//
// Proxies OpenAI-compatible chat completion requests through the Duo Agentic
// Chat WebSocket endpoint:
//
//   wss://gitlab.com/api/v4/ai/duo_workflows/ws
//      ?root_namespace_id=...
//      &user_selected_model_identifier=...
//      &workflow_definition=chat
//      &workflow_id=...
//      &client_type=browser
//
// Why this endpoint vs. /code_suggestions/completions?
//   - Definitive model selection: the user_selected_model_identifier query
//     param is wired all the way through to the AI Gateway as a model-metadata
//     header on the gRPC stream feeding Duo Workflow Service. Verified by
//     scripts/probe-duo-models.ts: every model returned its true identity
//     (Anthropic / OpenAI / Google) instead of being silently re-routed.
//   - Multi-turn / stateful chat lives here, not on the code-suggestions API.
//
// Auth: PAT with `api` (or `ai_workflows`) scope sent as Authorization: Bearer.
// Wire format: protojson-encoded DuoWorkflow.ClientEvent / Action — see
//   gitlab-org/modelops/applied-ml/code-suggestions/ai-assist/contract/contract.proto
//
// Per-request handshake:
//   1. POST /api/v4/ai/duo_workflows/direct_access  → workflow_metadata blob
//   2. POST /api/v4/ai/duo_workflows/workflows      → workflow_id
//   3. WS connect with the params above
//   4. Send startRequest frame
//   5. Receive a stream of newCheckpoint actions; agent reply lives in
//      checkpoint.channel_values.ui_chat_log[] where message_type === "agent".
//      Server emits cumulative content, so we compute suffix deltas.
//
// Account.tokens shape: { pat: "glpat-...", root_namespace_id?: "1234" }
//   root_namespace_id is discovered (and cached back via refreshToken) on first
//   use — must be a paid-tier namespace the PAT can access. Free namespaces
//   reject Duo with 403.
// ============================================================================

const GITLAB_API_BASE = "https://gitlab.com/api/v4";
const USER_URL = `${GITLAB_API_BASE}/user`;
const NAMESPACES_URL = `${GITLAB_API_BASE}/namespaces`;
const WORKFLOWS_URL = `${GITLAB_API_BASE}/ai/duo_workflows/workflows`;
const DIRECT_ACCESS_URL = `${GITLAB_API_BASE}/ai/duo_workflows/direct_access`;
const WS_URL = "wss://gitlab.com/api/v4/ai/duo_workflows/ws";

const REQUEST_TIMEOUT_MS = 180_000; // 3 minutes — chat workflows can run tool loops
const HTTP_TIMEOUT_MS = 20_000;
const CLIENT_VERSION = "0.0.54"; // matches GitLab's duo_workflow_executor binary version

interface GitLabDuoTokens {
  pat: string; // glpat-...
  root_namespace_id?: string; // resolved + cached on first successful call
}

// Model mapping: proxy-facing gd-* IDs → GitLab user_selected_model_identifier
const MODEL_MAP: Record<string, string> = {
  "gd-haiku-4.5": "claude_haiku_4_5_20251001",
  "gd-sonnet-4.5": "claude_sonnet_4_5_20250929",
  "gd-sonnet-4.6": "claude_sonnet_4_6",
  "gd-opus-4.5": "claude_opus_4_5_20251101",
  "gd-opus-4.6": "claude_opus_4_6_20260205",
  "gd-opus-4.7": "claude_opus_4_7",
  "gd-opus-4.8": "claude_opus_4_8",
  "gd-fable-5": "claude_fable_5",
  "gd-gpt-5": "gpt_5",
  "gd-gpt-5-mini": "gpt_5_mini",
  "gd-gpt-5-codex": "gpt_5_codex",
  "gd-gemini-flash": "gemini_3_5_flash_vertex",
};

interface ModelDef {
  id: string;
  gitlabId: string;
  contextWindow: number;
  maxOutput: number;
  thinking: boolean;
  vision: boolean;
}

const MODEL_DEFS: ModelDef[] = [
  { id: "gd-haiku-4.5", gitlabId: "claude_haiku_4_5_20251001", contextWindow: 200000, maxOutput: 8192, thinking: false, vision: true },
  { id: "gd-sonnet-4.5", gitlabId: "claude_sonnet_4_5_20250929", contextWindow: 200000, maxOutput: 64000, thinking: true, vision: true },
  { id: "gd-sonnet-4.6", gitlabId: "claude_sonnet_4_6", contextWindow: 200000, maxOutput: 64000, thinking: true, vision: true },
  { id: "gd-opus-4.5", gitlabId: "claude_opus_4_5_20251101", contextWindow: 200000, maxOutput: 32000, thinking: true, vision: true },
  { id: "gd-opus-4.6", gitlabId: "claude_opus_4_6_20260205", contextWindow: 200000, maxOutput: 32000, thinking: true, vision: true },
  { id: "gd-opus-4.7", gitlabId: "claude_opus_4_7", contextWindow: 200000, maxOutput: 32000, thinking: true, vision: true },
  { id: "gd-opus-4.8", gitlabId: "claude_opus_4_8", contextWindow: 200000, maxOutput: 32000, thinking: true, vision: true },
  { id: "gd-fable-5", gitlabId: "claude_fable_5", contextWindow: 200000, maxOutput: 32000, thinking: true, vision: true },
  { id: "gd-gpt-5", gitlabId: "gpt_5", contextWindow: 400000, maxOutput: 32000, thinking: true, vision: true },
  { id: "gd-gpt-5-mini", gitlabId: "gpt_5_mini", contextWindow: 128000, maxOutput: 16384, thinking: false, vision: true },
  { id: "gd-gpt-5-codex", gitlabId: "gpt_5_codex", contextWindow: 200000, maxOutput: 32000, thinking: true, vision: false },
  { id: "gd-gemini-flash", gitlabId: "gemini_3_5_flash_vertex", contextWindow: 1000000, maxOutput: 65536, thinking: false, vision: true },
];

export class GitLabDuoProvider extends BaseProvider {
  name = "gitlab-duo";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("gd-");
  }

  supportedModels: ModelInfo[] = MODEL_DEFS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "gitlab-duo",
    context_window: m.contextWindow,
    max_output: m.maxOutput,
    thinking: m.thinking,
    vision: m.vision,
    creditUnit: "token" as const,
    creditRate: 1 / 1000,
    creditSource: "estimated" as const,
  }));

  // ─── Token helpers ───────────────────────────────────────────────

  private getTokens(account: Account): GitLabDuoTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      if (!t || typeof t !== "object" || !t.pat) return null;
      return t as GitLabDuoTokens;
    } catch {
      return null;
    }
  }

  private getGitLabModelId(proxyModel: string): string {
    const mapped = MODEL_MAP[proxyModel.toLowerCase()];
    if (mapped) return mapped;
    return proxyModel.replace(/^gd-/i, "").replace(/-/g, "_");
  }

  // ─── Conversation flattening ─────────────────────────────────────
  // Duo Chat takes a single `goal` string. We collapse the chat history into a
  // markdown transcript so the model sees prior turns. The LAST user message
  // is appended last so the model treats it as the active question.

  private extractText(content: ChatMessage["content"]): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return (content as any[])
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
    return "";
  }

  private buildGoal(messages: ChatMessage[]): string {
    if (messages.length === 0) return "";
    if (messages.length === 1) return this.extractText(messages[0]!.content);

    const parts: string[] = [];
    for (const msg of messages) {
      const text = this.extractText(msg.content).trim();
      if (!text) continue;
      switch (msg.role) {
        case "system":    parts.push(`[System Instructions]\n${text}\n`); break;
        case "user":      parts.push(`[User]\n${text}\n`); break;
        case "assistant": parts.push(`[Assistant]\n${text}\n`); break;
        case "tool":      parts.push(`[Tool Result]\n${text}\n`); break;
      }
    }
    return parts.join("\n");
  }

  // ─── Namespace discovery ────────────────────────────────────────
  // Duo Workflow needs a paid-tier namespace (Premium/Ultimate, including
  // trial). We pick the first non-free namespace the PAT can access. Result is
  // cached back into account.tokens via refreshToken so subsequent calls are
  // a single GET on cache hit.

  private async resolveRootNamespaceId(pat: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const resp = await fetch(`${NAMESPACES_URL}?per_page=100`, {
        headers: { "PRIVATE-TOKEN": pat, "Accept": "application/json" },
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        return { ok: false, error: `namespaces ${resp.status}` };
      }
      const list = (await resp.json()) as Array<{ id: number; plan?: string; kind?: string }>;
      if (!Array.isArray(list)) return { ok: false, error: "namespaces: bad shape" };
      // Prefer non-free, non-user namespaces (groups with paid plans). Fall
      // back to any non-free namespace.
      const paidGroup = list.find((n) => n.kind === "group" && n.plan && n.plan !== "free");
      const anyPaid = list.find((n) => n.plan && n.plan !== "free");
      const pick = paidGroup || anyPaid;
      if (!pick) return { ok: false, error: "no paid namespace (Duo requires Premium/Ultimate)" };
      return { ok: true, id: String(pick.id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureRootNamespaceId(account: Account, tokens: GitLabDuoTokens): Promise<{ ok: true; id: string; updated: boolean } | { ok: false; error: string }> {
    if (tokens.root_namespace_id) return { ok: true, id: tokens.root_namespace_id, updated: false };
    const r = await this.resolveRootNamespaceId(tokens.pat);
    if (!r.ok) return r;
    return { ok: true, id: r.id, updated: true };
  }

  // ─── Pre-flight: workflow_metadata + workflow_id ─────────────────

  private async fetchWorkflowMetadata(pat: string, rootNamespaceId: string): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const resp = await fetch(DIRECT_ACCESS_URL, {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": pat,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({ workflow_definition: "chat", root_namespace_id: rootNamespaceId }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        throw new Error(`direct_access ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
      }
      const j: any = await resp.json();
      return j?.workflow_metadata || {};
    } finally {
      clearTimeout(timer);
    }
  }

  private async createWorkflow(pat: string, rootNamespaceId: string, goal: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const resp = await fetch(WORKFLOWS_URL, {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": pat,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          namespace_id: rootNamespaceId,
          workflow_definition: "chat",
          goal,
          agent_privileges: [],
          pre_approved_agent_privileges: [],
          start_workflow: false,
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        throw new Error(`create workflow ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
      }
      const j: any = await resp.json();
      if (!j?.id) throw new Error("create workflow: missing id");
      return String(j.id);
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Streaming chat completion ────────────────────────────────────

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.pat) return { success: false, error: "Missing PAT (account.tokens.pat)" };

    const ns = await this.ensureRootNamespaceId(account, tokens);
    if (!ns.ok) return { success: false, error: `namespace: ${ns.error}` };
    const rootNamespaceId = ns.id;

    const goal = this.buildGoal(request.messages);
    if (!goal) return { success: false, error: "No content to send (empty messages)" };

    const gitlabModelId = this.getGitLabModelId(request.model);

    // Pre-flight HTTP calls in parallel.
    let workflowMetadata: any;
    let workflowId: string;
    try {
      [workflowMetadata, workflowId] = await Promise.all([
        this.fetchWorkflowMetadata(tokens.pat, rootNamespaceId),
        this.createWorkflow(tokens.pat, rootNamespaceId, goal),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `gitlab-duo preflight: ${msg}` };
    }

    // Build WS URL
    const params = new URLSearchParams({
      root_namespace_id: rootNamespaceId,
      user_selected_model_identifier: gitlabModelId,
      workflow_definition: "chat",
      workflow_id: workflowId,
      client_type: "browser",
    });
    const wsUrl = `${WS_URL}?${params}`;

    // Tokens captured for closures below.
    const pat = tokens.pat;

    // Updated tokens to persist if we resolved namespace this call.
    const updatedTokens = ns.updated
      ? JSON.stringify({ ...tokens, root_namespace_id: rootNamespaceId })
      : undefined;

    const requestModelId = request.model;

    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const encoder = new TextEncoder();
        const id = `chatcmpl-gd-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let streamActive = true;
        let sentRole = false;
        let lastAgentContent = "";
        let finishEmitted = false;
        let ws: WebSocket | null = null;
        let hardTimer: ReturnType<typeof setTimeout> | null = null;

        const enqueue = (delta: any, finishReason: string | null = null) => {
          if (!streamActive) return;
          const chunk = {
            id,
            object: "chat.completion.chunk" as const,
            created,
            model: requestModelId,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          };
          try {
            ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } catch {
            streamActive = false;
          }
        };

        const closeStream = () => {
          if (!streamActive) return;
          if (!finishEmitted) {
            enqueue({}, "stop");
            finishEmitted = true;
          }
          try { ctrl.enqueue(encoder.encode("data: [DONE]\n\n")); } catch {}
          try { ctrl.close(); } catch {}
          streamActive = false;
          if (hardTimer) clearTimeout(hardTimer);
          try { ws?.close(); } catch {}
        };

        const failStream = (msg: string) => {
          if (!streamActive) return;
          try {
            ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
            ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch {}
          try { ctrl.close(); } catch {}
          streamActive = false;
          if (hardTimer) clearTimeout(hardTimer);
          try { ws?.close(); } catch {}
        };

        try {
          ws = new WebSocket(wsUrl, {
            // @ts-ignore Bun extension: pass headers on WS handshake
            headers: {
              "Authorization": `Bearer ${pat}`,
              "User-Agent": `etteum-pool/gitlab-duo (gitlab-language-server-compat/${CLIENT_VERSION})`,
            },
          });
          (ws as any).binaryType = "arraybuffer";
        } catch (err) {
          failStream(`ws construct: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }

        hardTimer = setTimeout(() => {
          failStream(`gitlab-duo: timeout after ${REQUEST_TIMEOUT_MS}ms`);
        }, REQUEST_TIMEOUT_MS);

        ws.addEventListener("open", () => {
          const startEvent = {
            startRequest: {
              clientVersion: CLIENT_VERSION,
              workflowID: workflowId,
              workflowDefinition: "chat",
              goal,
              workflowMetadata: JSON.stringify(workflowMetadata || {}),
              clientCapabilities: ["resume_workflow", "tool_call_approval", "tool_call_pattern_approval"],
              mcpTools: [],
              additional_context: [],
              preapproved_tools: [],
              approval: {},
            },
          };
          try {
            ws!.send(JSON.stringify(startEvent));
          } catch (err) {
            failStream(`ws send startRequest: ${err instanceof Error ? err.message : String(err)}`);
          }
        });

        ws.addEventListener("message", (ev: MessageEvent) => {
          if (!streamActive) return;
          let text: string;
          if (typeof ev.data === "string") {
            text = ev.data;
          } else if (ev.data instanceof ArrayBuffer) {
            text = new TextDecoder().decode(ev.data);
          } else {
            return;
          }

          let parsed: any;
          try { parsed = JSON.parse(text); } catch { return; }

          // We only care about newCheckpoint actions — that's where chat
          // content lives. (The endpoint can also emit runHTTPRequest /
          // runMCPTool actions but those are server-side tool calls; in pure
          // chat mode for this account we don't see them, and ignoring them
          // matches what the workflow_definition=chat surface expects.)
          const cp = parsed?.newCheckpoint;
          if (!cp) return;

          let checkpoint: any;
          try { checkpoint = JSON.parse(cp.checkpoint); } catch { return; }
          const log: any[] = checkpoint?.channel_values?.ui_chat_log;
          if (!Array.isArray(log)) return;

          // Extract latest agent message content (cumulative).
          let latest = "";
          for (const m of log) {
            if (m?.message_type === "agent" && typeof m?.content === "string") {
              latest = m.content; // last agent message wins
            }
          }

          if (latest && latest !== lastAgentContent) {
            // Compute suffix delta — server sends cumulative content; emit only
            // the new portion as an OpenAI delta. If the new content does NOT
            // start with the old one (model rewrote, e.g. from a partial
            // refusal to a longer one), emit the full latest content instead.
            const delta = latest.startsWith(lastAgentContent)
              ? latest.slice(lastAgentContent.length)
              : latest;
            lastAgentContent = latest;

            if (delta) {
              const out: any = { content: delta };
              if (!sentRole) {
                out.role = "assistant";
                sentRole = true;
              }
              enqueue(out);
            }
          }

          // Terminal statuses for chat workflow.
          const status = cp.status as string | undefined;
          if (status === "INPUT_REQUIRED" || status === "FINISHED" || status === "ERROR" || status === "STOPPED") {
            if (status === "ERROR") {
              const errs: string[] = Array.isArray(cp.errors) ? cp.errors : [];
              if (errs.length > 0 && !lastAgentContent) {
                failStream(`gitlab-duo workflow error: ${errs.join("; ").slice(0, 500)}`);
                return;
              }
            }
            closeStream();
          }
        });

        ws.addEventListener("error", () => {
          // The WebSocket "error" event carries no payload in browsers/Bun.
          // The follow-up "close" event has the diagnostic info.
        });

        ws.addEventListener("close", (ev: CloseEvent) => {
          if (!streamActive) return;
          // Map close codes to errors.
          if (ev.code === 1008) {
            failStream(`gitlab-duo quota exceeded: ${ev.reason || "policy violation"}`);
          } else if (ev.code === 1013) {
            failStream(`gitlab-duo locked: ${ev.reason || "try again later"}`);
          } else if (ev.code !== 1000 && ev.code !== 1001) {
            failStream(`gitlab-duo ws closed unexpectedly: code=${ev.code} reason=${ev.reason}`);
          } else if (lastAgentContent) {
            // Normal close after we got content but before status flagged terminal.
            closeStream();
          } else {
            failStream(`gitlab-duo: ws closed without response (code=${ev.code})`);
          }
        });
      },
    });

    return {
      success: true,
      stream,
      ...(updatedTokens ? { tokens: updatedTokens } : {}),
    };
  }

  // ─── Non-streaming chat completion ──────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const result = await this.chatCompletionStream(account, request);
    if (!result.success || !result.stream) return result;

    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let finishReason: string | null = null;
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const ev of events) {
          for (const line of ev.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.error) {
                return { success: false, error: String(parsed.error) };
              }
              const choice = parsed.choices?.[0];
              if (!choice) continue;
              const c = choice.delta?.content;
              if (typeof c === "string") fullContent += c;
              if (choice.finish_reason) finishReason = choice.finish_reason;
            } catch { /* ignore */ }
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }

    const promptTokens = this.estimateMessagesTokens(request.messages);
    const completionTokens = this.estimateTokens(fullContent);

    const response: ChatCompletionResponse = {
      id: `chatcmpl-gd-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: fullContent },
        finish_reason: finishReason || "stop",
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };

    // Forward tokens (if the streaming layer cached a namespace).
    return {
      success: true,
      response,
      ...(result.tokens ? { tokens: result.tokens } : {}),
    };
  }

  // ─── Token refresh / health check ───────────────────────────────

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.pat) return { success: false, error: "No PAT available" };

    // 1. Validate PAT still works.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const resp = await fetch(USER_URL, {
        method: "GET",
        headers: { "PRIVATE-TOKEN": tokens.pat },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `PAT validation failed: ${resp.status} ${text.slice(0, 200)}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    // 2. If we don't have a namespace cached yet, try to discover one. This
    //    is a soft-fail: a PAT can be valid but lack any paid namespace.
    if (!tokens.root_namespace_id) {
      const ns = await this.resolveRootNamespaceId(tokens.pat);
      if (ns.ok) {
        return { success: true, tokens: JSON.stringify({ ...tokens, root_namespace_id: ns.id }) };
      }
    }

    return { success: true };
  }

  // ─── Account validation ─────────────────────────────────────────

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!tokens?.pat && tokens.pat.length > 0;
  }

  // ─── Quota ──────────────────────────────────────────────────────

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.pat) {
      return { success: false, error: "No PAT available" };
    }

    // GitLab Duo has no public quota API for chat. Trial namespaces have soft
    // limits surfaced only via 1008 close codes mid-stream, which the proxy
    // handles in the runtime path.
    return {
      success: true,
      quota: {
        limit: 999999,
        remaining: 999999,
        used: 0,
        resetAt: null,
      },
    };
  }
}
