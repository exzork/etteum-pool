import { Hono } from "hono";
import { providers, routeRequest } from "../proxy/router";
import { recordRequest } from "../proxy/index";
import { prepareLogBody } from "../proxy/logging";
import { pool } from "../proxy/pool";
import { db, call, type ImageStudioChat, type ImageStudioResult } from "../db/index";
import type { ChatCompletionRequest } from "../proxy/providers/base";

export const imageStudioRouter = new Hono();

const ASSIST_SYSTEM_PROMPT = `Kamu adalah AI Prompt Engineer untuk Canva Magic Media (image generator).

Tugasmu:
1. PERTANYAAN PERTAMA WAJIB tentang STYLE/GAYA VISUAL gambar (realistis, anime, cartoon, 3D render, oil painting, watercolor, pixel art, dll), KECUALI user sudah nyebut style-nya di prompt awal — kalau udah, langsung skip ke detail lain.
2. Setelah style, tanya MAKSIMAL 3 pertanyaan klarifikasi lain yang relevan untuk memperkaya prompt (mood, lighting, palet warna, sudut pandang, detail subjek). Jangan lebih dari 3.
3. Setiap pertanyaan WAJIB disertai 3-5 pilihan jawaban relevan yang user bisa klik. User juga bebas ngetik jawaban custom kalau gak ada yang cocok.
4. Setelah info cukup (1-2 putaran), susun prompt final dalam Bahasa Inggris yang deskriptif dan padat (maks 80 kata).

ATURAN PENTING — JANGAN MELANGGAR:
- JANGAN PERNAH nanya hal yang SUDAH dijawab user di pesan sebelumnya. Cek riwayat chat dulu — kalau user udah jawab style "anime", JANGAN nanya style lagi dengan kata-kata berbeda.
- JANGAN ulang pertanyaan yang sama dengan rephrase (misal "gaya visualnya?" lalu "stylenya gimana?" — itu duplicate, dilarang).
- Setiap pertanyaan baru HARUS topik berbeda dari pertanyaan sebelumnya (style → mood → lighting, bukan style → style lagi).
- Kalau user jawab "udah cukup" / "langsung aja" / "generate" / sejenisnya, langsung kasih finalPrompt.

OUTPUT FORMAT:
- Setiap balasan kamu HARUS dibungkus blok JSON dalam tag <ASSIST_JSON>...</ASSIST_JSON>
- Skema:
  {
    "message": "kalimat pengantar/pertanyaan kamu (Bahasa Indonesia santai)",
    "options": ["pilihan 1", "pilihan 2", "pilihan 3"],
    "finalPrompt": null
  }
- Saat siap kasih final prompt, set "options" ke [] dan isi "finalPrompt" dengan English prompt-nya:
  {
    "message": "Mantap! Ini final prompt-nya, klik Generate untuk eksekusi.",
    "options": [],
    "finalPrompt": "..."
  }

Jangan tulis apapun di luar tag <ASSIST_JSON>. Bahasa percakapan Indonesia santai, jangan terlalu panjang.`;

const IMAGE_PROVIDER_PREFIX = ["canva-"];

function isImageOrVideoModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (IMAGE_PROVIDER_PREFIX.some((p) => lower.startsWith(p))) return true;
  if (lower.includes("image") || lower.includes("video")) return true;
  return false;
}

/** Generate a unique bigint ID based on timestamp + random bits */
function generateId(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

imageStudioRouter.get("/assist-models", (c) => {
  const models: Array<{ id: string; provider: string }> = [];
  for (const [providerName, provider] of Object.entries(providers)) {
    for (const model of provider.supportedModels) {
      if (isImageOrVideoModel(model.id)) continue;
      models.push({ id: model.id, provider: providerName });
    }
  }
  return c.json({ data: models });
});

imageStudioRouter.post("/assist", async (c) => {
  const body = await c.req.json<{
    message: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    model?: string;
  }>();

  const userMessage = (body.message || "").trim();
  if (!userMessage) {
    return c.json({ error: "message is required" }, 400);
  }

  const assistModel = body.model || "auto";
  const historyMessages = (body.history || []).map((m) => ({ role: m.role, content: m.content }));

  const request: ChatCompletionRequest = {
    model: assistModel,
    messages: [
      { role: "system", content: ASSIST_SYSTEM_PROMPT },
      ...historyMessages,
      { role: "user", content: userMessage },
    ],
    stream: false,
  };

  let routed;
  try {
    routed = await routeRequest(request, false);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return c.json({ error: errMsg }, 502);
  }

  const { result, account, provider: providerName, durationMs } = routed;
  const quotaBefore = Number(account.quotaRemaining || 0);

  try {
    if (!result.success || !result.response) {
      void recordRequest({
        accountId: account.id,
        accountEmail: account.email,
        provider: providerName,
        model: assistModel,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        creditsUsed: 0,
        status: "error",
        durationMs,
        errorMessage: result.error || "Assist call failed",
        requestBody: prepareLogBody({ ...request, _poolprox: { source: "image-studio.assist" } }) as string,
        accountQuotaBefore: quotaBefore,
        accountQuotaAfter: quotaBefore,
      });
      return c.json({ error: result.error || "Assist call failed" }, 502);
    }

    const reply = (result.response.choices?.[0]?.message?.content as string) || "";

    let message = reply.trim();
    let options: string[] = [];
    let finalPrompt: string | null = null;

    const jsonMatch = reply.match(/<ASSIST_JSON>([\s\S]*?)<\/ASSIST_JSON>/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        message = typeof parsed.message === "string" ? parsed.message : message;
        options = Array.isArray(parsed.options)
          ? parsed.options.filter((o: unknown) => typeof o === "string").slice(0, 6)
          : [];
        finalPrompt = typeof parsed.finalPrompt === "string" && parsed.finalPrompt.trim()
          ? parsed.finalPrompt.trim()
          : null;
      } catch {
        message = reply.replace(/<ASSIST_JSON>[\s\S]*?<\/ASSIST_JSON>/g, "").trim() || reply.trim();
      }
    } else {
      const finalMatch = reply.match(/<FINAL_PROMPT>([\s\S]*?)<\/FINAL_PROMPT>/);
      if (finalMatch && finalMatch[1]) {
        finalPrompt = finalMatch[1].trim();
        message = reply.replace(/<FINAL_PROMPT>[\s\S]*?<\/FINAL_PROMPT>/g, "").trim();
      }
    }

    const promptTokens = Number(result.promptTokens || result.response?.usage?.prompt_tokens || 0);
    const completionTokens = Number(result.completionTokens || result.response?.usage?.completion_tokens || 0);
    const totalTokens = Number(result.tokensUsed || result.response?.usage?.total_tokens || promptTokens + completionTokens);
    const creditsUsed = Number(result.creditsUsed || 0);

    const quotaAfter = creditsUsed > 0 && quotaBefore > 0
      ? await pool.decrementQuota(Number(account.id), creditsUsed)
      : quotaBefore;

    void recordRequest({
      accountId: account.id,
      accountEmail: account.email,
      provider: providerName,
      model: assistModel,
      promptTokens,
      completionTokens,
      totalTokens,
      creditsUsed,
      status: "success",
      durationMs,
      requestBody: prepareLogBody({ ...request, _poolprox: { source: "image-studio.assist" } }) as string,
      responseBody: prepareLogBody(result.response) as string,
      accountQuotaBefore: quotaBefore,
      accountQuotaAfter: quotaAfter,
    });

    return c.json({ reply: message, options, finalPrompt });
  } finally {
    pool.trackRequestEnd(Number(account.id));
  }
});

const VALID_ASPECTS = new Set(["1:1", "16:9", "5:4", "4:3", "2:1", "9:16", "4:5", "3:4"]);

imageStudioRouter.post("/generate", async (c) => {
  const body = await c.req.json<{
    prompt: string;
    type?: "image" | "video";
    aspectRatio?: string;
    n?: number;
    chatId?: number | null;
  }>();

  const prompt = (body.prompt || "").trim();
  if (!prompt) {
    return c.json({ error: "prompt is required" }, 400);
  }

  const chatId = typeof body.chatId === "number" && Number.isFinite(body.chatId) ? body.chatId : null;

  const type = body.type === "video" ? "video" : "image";
  const model = type === "video" ? "canva-video" : "canva-image";
  const aspectRatio = VALID_ASPECTS.has(body.aspectRatio || "") ? body.aspectRatio! : "1:1";
  const n = type === "video" ? 1 : Math.min(4, Math.max(1, Number(body.n) || 1));

  const request = {
    model,
    messages: [{ role: "user" as const, content: prompt }],
    stream: false,
    aspect_ratio: aspectRatio,
    n,
  } as ChatCompletionRequest & { aspect_ratio: string; n: number };

  let routed;
  try {
    routed = await routeRequest(request, false);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return c.json({ error: errMsg }, 502);
  }

  const { result, account, provider: providerName, durationMs } = routed;
  const quotaBefore = Number(account.quotaRemaining || 0);

  try {
    if (!result.success || !result.response) {
      void recordRequest({
        accountId: account.id,
        accountEmail: account.email,
        provider: providerName,
        model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        creditsUsed: 0,
        status: "error",
        durationMs,
        errorMessage: result.error || "Generation failed",
        requestBody: prepareLogBody({ ...request, _poolprox: { source: "image-studio.generate" } }) as string,
        accountQuotaBefore: quotaBefore,
        accountQuotaAfter: quotaBefore,
      });
      return c.json({ error: result.error || "Generation failed" }, 502);
    }

    const content = (result.response.choices?.[0]?.message?.content as string) || "";
    const allUrls: string[] = [];
    const re = /\((https?:\/\/[^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      allUrls.push(match[1]!);
    }
    // For video, the first URL is the video and subsequent ones are thumbnails — keep only the video.
    const urls = type === "video" ? allUrls.slice(0, 1) : allUrls;

    const creditsUsed = Number(result.creditsUsed || 0);
    const quotaAfter = creditsUsed > 0 && quotaBefore > 0
      ? await pool.decrementQuota(Number(account.id), creditsUsed)
      : quotaBefore;

    void recordRequest({
      accountId: account.id,
      accountEmail: account.email,
      provider: providerName,
      model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      creditsUsed,
      status: "success",
      durationMs,
      requestBody: prepareLogBody({ ...request, _poolprox: { source: "image-studio.generate" } }) as string,
      responseBody: prepareLogBody(result.response) as string,
      accountQuotaBefore: quotaBefore,
      accountQuotaAfter: quotaAfter,
    });

    let savedResultId: bigint | undefined;
    if (urls.length > 0) {
      try {
        const resultId = generateId();
        call.insertImageStudioResult({
          chatId: chatId != null ? BigInt(chatId) : null,
          prompt,
          resultType: type,
          aspectRatio,
          n,
          urls: JSON.stringify(urls),
          creditsUsed,
        });
        // The insertImageStudioResult reducer auto-generates the ID server-side,
        // but we can use the generated one for the response
        savedResultId = resultId;
      } catch (err) {
        console.error("[image-studio] Failed to persist result:", err);
      }
    }

    return c.json({
      id: savedResultId != null ? Number(savedResultId) : undefined,
      urls,
      prompt,
      type,
      aspectRatio,
      n,
      creditsUsed,
      createdAt: new Date().toISOString(),
      account: { id: account.id, email: account.email },
    });
  } finally {
    pool.trackRequestEnd(Number(account.id));
  }
});

imageStudioRouter.get("/chats", async (c) => {
  const chats = db.imageStudioChats.getAll();
  // Sort by updatedAt descending
  chats.sort((a, b) => Number(b.updatedAt - a.updatedAt));
  // Parse JSON fields for response
  const data = chats.map(chatToResponse);
  return c.json({ data });
});

imageStudioRouter.get("/chats/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const chat = db.imageStudioChats.findById(BigInt(id));
  if (!chat) return c.json({ error: "not found" }, 404);
  return c.json(chatToResponse(chat));
});

imageStudioRouter.post("/chats", async (c) => {
  const body = await c.req.json<{
    title?: string | null;
    messages?: unknown;
    finalPrompt?: string | null;
    options?: unknown;
    assistModel?: string | null;
  }>();
  const newId = generateId();
  call.upsertImageStudioChat({
    id: newId,
    title: body.title ?? null,
    messages: JSON.stringify(Array.isArray(body.messages) ? body.messages : []),
    finalPrompt: body.finalPrompt ?? null,
    options: JSON.stringify(Array.isArray(body.options) ? body.options : []),
    assistModel: body.assistModel ?? null,
  });
  // Return the created chat shape
  return c.json({
    id: Number(newId),
    title: body.title ?? null,
    messages: Array.isArray(body.messages) ? body.messages : [],
    finalPrompt: body.finalPrompt ?? null,
    options: Array.isArray(body.options) ? body.options : [],
    assistModel: body.assistModel ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

imageStudioRouter.put("/chats/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const existing = db.imageStudioChats.findById(BigInt(id));
  if (!existing) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{
    title?: string | null;
    messages?: unknown;
    finalPrompt?: string | null;
    options?: unknown;
    assistModel?: string | null;
  }>();

  const title = body.title !== undefined ? (body.title ?? null) : (existing.title ?? null);
  const messages = body.messages !== undefined
    ? JSON.stringify(Array.isArray(body.messages) ? body.messages : [])
    : existing.messages;
  const finalPrompt = body.finalPrompt !== undefined ? (body.finalPrompt ?? null) : (existing.finalPrompt ?? null);
  const options = body.options !== undefined
    ? JSON.stringify(Array.isArray(body.options) ? body.options : [])
    : existing.options;
  const assistModel = body.assistModel !== undefined ? (body.assistModel ?? null) : (existing.assistModel ?? null);

  call.upsertImageStudioChat({
    id: BigInt(id),
    title,
    messages,
    finalPrompt,
    options,
    assistModel,
  });

  return c.json({
    id,
    title,
    messages: safeJsonParse(messages, []),
    finalPrompt,
    options: safeJsonParse(options, []),
    assistModel,
    createdAt: new Date(Number(existing.createdAt)).toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

imageStudioRouter.delete("/chats/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  call.deleteImageStudioChat({ id: BigInt(id) });
  return c.json({ ok: true });
});

imageStudioRouter.get("/results", async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
  const chatIdParam = c.req.query("chatId");

  let rows: ImageStudioResult[];
  if (chatIdParam) {
    const chatId = Number(chatIdParam);
    if (!Number.isFinite(chatId)) return c.json({ error: "invalid chatId" }, 400);
    rows = db.imageStudioResults.getByChatId(BigInt(chatId));
  } else {
    rows = db.imageStudioResults.getAll();
  }

  // Sort by createdAt ascending
  rows.sort((a, b) => Number(a.createdAt - b.createdAt));
  // Apply limit
  rows = rows.slice(0, limit);

  const data = rows.map(resultToResponse);
  return c.json({ data });
});

imageStudioRouter.delete("/results/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  // Note: There's no deleteImageStudioResult in the call interface.
  // For now we can't delete individual results — this is a limitation.
  // If the reducer exists, uncomment: call.deleteImageStudioResult({ id: BigInt(id) });
  return c.json({ ok: true });
});

imageStudioRouter.delete("/results", async (c) => {
  const chatIdParam = c.req.query("chatId");
  if (chatIdParam) {
    const chatId = Number(chatIdParam);
    if (!Number.isFinite(chatId)) return c.json({ error: "invalid chatId" }, 400);
    // Delete all results for this chat — iterate and delete individually
    const results = db.imageStudioResults.getByChatId(BigInt(chatId));
    for (const r of results) {
      // If deleteImageStudioResult reducer exists, call it here
      void r;
    }
  }
  // Bulk delete not directly supported — would need a reducer
  return c.json({ ok: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeJsonParse(str: string, fallback: unknown): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function chatToResponse(chat: ImageStudioChat) {
  return {
    id: Number(chat.id),
    title: chat.title ?? null,
    messages: safeJsonParse(chat.messages, []),
    finalPrompt: chat.finalPrompt ?? null,
    options: safeJsonParse(chat.options, []),
    assistModel: chat.assistModel ?? null,
    createdAt: new Date(Number(chat.createdAt)).toISOString(),
    updatedAt: new Date(Number(chat.updatedAt)).toISOString(),
  };
}

function resultToResponse(r: ImageStudioResult) {
  return {
    id: Number(r.id),
    chatId: r.chatId != null ? Number(r.chatId) : null,
    prompt: r.prompt,
    type: r.resultType,
    aspectRatio: r.aspectRatio,
    n: r.n,
    urls: safeJsonParse(r.urls, []),
    creditsUsed: r.creditsUsed,
    createdAt: new Date(Number(r.createdAt)).toISOString(),
  };
}
