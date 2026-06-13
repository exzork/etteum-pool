import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";

// ============================================================================
// GitLab Duo Provider
//
// Proxies OpenAI-compatible chat completion requests through GitLab's
// code_suggestions API (POST /api/v4/code_suggestions/completions).
//
// Auth: PRIVATE-TOKEN header with a GitLab PAT.
// Model selection: user_selected_model_identifier field in payload.
// Response: SSE stream with event: stream_start/stream_end, data chunks
//           containing {"choices":[{"delta":{"content":"..."}}]}.
// ============================================================================

const GITLAB_API_BASE = "https://gitlab.com/api/v4";
const COMPLETIONS_URL = `${GITLAB_API_BASE}/code_suggestions/completions`;
const USER_URL = `${GITLAB_API_BASE}/user`;

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes

interface GitLabDuoTokens {
  pat: string; // glpat-...
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
  { id: "gd-opus-4.6", gitlabId: "claude_opus_4_6_20260205", contextWindow: 200000, maxOutput: 64000, thinking: true, vision: true },
  { id: "gd-opus-4.7", gitlabId: "claude_opus_4_7", contextWindow: 200000, maxOutput: 64000, thinking: true, vision: true },
  { id: "gd-opus-4.8", gitlabId: "claude_opus_4_8", contextWindow: 200000, maxOutput: 64000, thinking: true, vision: true },
  { id: "gd-fable-5", gitlabId: "claude_fable_5", contextWindow: 200000, maxOutput: 64000, thinking: false, vision: true },
  { id: "gd-gpt-5", gitlabId: "gpt_5", contextWindow: 200000, maxOutput: 32000, thinking: true, vision: true },
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
    // Fallback: try stripping gd- prefix and using as-is
    return proxyModel.replace(/^gd-/i, "").replace(/-/g, "_");
  }

  // ─── Build GitLab payload ───────────────────────────────────────

  private buildPayload(request: ChatCompletionRequest): object {
    const messages = request.messages;
    const lastUserMsg = this.extractLastUserMessage(messages);
    const conversationMarkdown = this.buildConversationMarkdown(messages);
    const gitlabModelId = this.getGitLabModelId(request.model);

    return {
      prompt_version: 1,
      project_path: "",
      project_id: -1,
      current_file: {
        file_name: "conversation.md",
        content_above_cursor: conversationMarkdown,
        content_below_cursor: "",
      },
      intent: "generation",
      stream: true,
      generation_type: "comment",
      user_instruction: lastUserMsg,
      user_selected_model_identifier: gitlabModelId,
    };
  }

  private extractLastUserMessage(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== "user") continue;
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        const text = (msg.content as any[])
          .filter((b) => b?.type === "text")
          .map((b) => b.text)
          .join("\n");
        if (text) return text;
      }
    }
    return "";
  }

  private buildConversationMarkdown(messages: ChatMessage[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      const content = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as any[])
              .filter((b) => b?.type === "text")
              .map((b) => b.text)
              .join("\n")
          : "";

      if (!content) continue;

      switch (msg.role) {
        case "system":
          parts.push(`[System Instructions]\n${content}\n`);
          break;
        case "user":
          parts.push(`[User]\n${content}\n`);
          break;
        case "assistant":
          parts.push(`[Assistant]\n${content}\n`);
          break;
        case "tool":
          parts.push(`[Tool Result]\n${content}\n`);
          break;
      }
    }

    return parts.join("\n");
  }

  // ─── Chat completion (non-streaming) ───────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const result = await this.chatCompletionStream(account, request);
    if (!result.success || !result.stream) return result;

    // Consume the stream and collect content
    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let finishReason: string | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          if (line === "data: [DONE]") continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) fullContent += delta.content;
            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }

    const promptTokens = this.estimateMessagesTokens(request.messages);
    const completionTokens = this.estimateTokens(fullContent);

    const response: ChatCompletionResponse = {
      id: this.generateId(),
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

    return {
      success: true,
      response,
      stream: undefined,
      tokensUsed: promptTokens + completionTokens,
      promptTokens,
      completionTokens,
    };
  }

  // ─── Chat completion (streaming) ───────────────────────────────

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.pat) {
      return { success: false, error: "No GitLab PAT available" };
    }

    const payload = this.buildPayload(request);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": tokens.pat,
          "Accept": "text/event-stream",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (resp.status === 401 || resp.status === 403) {
      clearTimeout(timer);
      const text = await resp.text().catch(() => "");
      return { success: false, error: `GitLab auth error HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }

    if (resp.status === 429) {
      clearTimeout(timer);
      return { success: false, error: "Rate limited", rateLimited: true };
    }

    if (!resp.ok) {
      clearTimeout(timer);
      const text = await resp.text().catch(() => "");
      return { success: false, error: `GitLab Duo HTTP ${resp.status}: ${text.slice(0, 300)}` };
    }

    if (!resp.body) {
      clearTimeout(timer);
      return { success: false, error: "GitLab Duo response missing body" };
    }

    const upstream = resp.body;
    const id = this.generateId();
    const model = request.model;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: async (ctrl) => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sentRole = false;
        let finishEmitted = false;
        let streamActive = true;

        const enqueue = (delta: any, finishReason: string | null = null) => {
          if (!streamActive) return;
          try {
            const chunk = {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            };
            ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } catch {
            streamActive = false;
          }
        };

        try {
          while (streamActive) {
            let result;
            try {
              result = await reader.read();
            } catch (e) {
              console.error(`[GitLab Duo] Stream read error: ${e instanceof Error ? e.message : String(e)}`);
              break;
            }

            if (result.done) break;

            buffer += decoder.decode(result.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const raw of lines) {
              const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
              if (!line) continue;

              // Handle SSE event types
              if (line.startsWith("event:")) {
                const eventType = line.slice(6).trim();
                if (eventType === "stream_end") {
                  // Stream finished
                  if (!finishEmitted && streamActive) {
                    enqueue({}, "stop");
                    finishEmitted = true;
                  }
                }
                continue;
              }

              // Handle data lines
              if (!line.startsWith("data:")) continue;
              const dataStr = line.slice(5).trim();
              if (!dataStr || dataStr === "[DONE]") continue;

              try {
                const parsed = JSON.parse(dataStr);

                // GitLab format: {"choices":[{"delta":{"content":"..."}}]}
                const choice = parsed.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta;
                if (!delta) continue;

                const content = delta.content;
                if (typeof content !== "string" || content === "") continue;

                // Build OpenAI-compatible delta
                const outDelta: any = { content };
                if (!sentRole) {
                  outDelta.role = "assistant";
                  sentRole = true;
                }

                enqueue(outDelta);

                if (choice.finish_reason) {
                  enqueue({}, choice.finish_reason);
                  finishEmitted = true;
                }
              } catch {
                // Skip unparseable data lines
              }
            }
          }

          // Ensure we emit a finish if stream ended without explicit stream_end event
          if (!finishEmitted && streamActive) {
            enqueue({}, "stop");
          }

          if (streamActive) {
            try {
              ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch {
              streamActive = false;
            }
          }
        } catch (error) {
          streamActive = false;
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[GitLab Duo] Stream error: ${msg}`);
          try {
            ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
            ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch {}
        } finally {
          clearTimeout(timer);
          try { reader.releaseLock(); } catch {}
          try { ctrl.close(); } catch {}
        }
      },
    });

    return {
      success: true,
      stream,
    };
  }

  // ─── Token refresh ──────────────────────────────────────────────

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.pat) {
      return { success: false, error: "No PAT available" };
    }

    // Validate the PAT still works by hitting GET /api/v4/user
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const resp = await fetch(USER_URL, {
        method: "GET",
        headers: { "PRIVATE-TOKEN": tokens.pat },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        return { success: true };
      }

      const text = await resp.text().catch(() => "");
      return { success: false, error: `PAT validation failed HTTP ${resp.status}: ${text.slice(0, 100)}` };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
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
    // GitLab Duo has no quota API — unlimited during trial
    const tokens = this.getTokens(account);
    if (!tokens?.pat) {
      return { success: false, error: "No PAT available" };
    }

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
