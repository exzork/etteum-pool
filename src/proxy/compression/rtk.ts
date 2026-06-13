/**
 * RTK — Tool Result Compression.
 *
 * Truncates large `tool_result` content blocks (and OpenAI-style `tool` role
 * messages) in OLDER turns. The last N turns are left fully intact so the
 * model still has fresh context for whatever it just did.
 *
 * Smart truncation recognises common command shapes:
 *   - git diff       → keep hunk headers + first/last 5 lines per hunk
 *   - tree / ls -R   → keep depth ≤ 2, count and summarise the tail
 *   - cat / Read     → keep head 100 + tail 50 lines
 * Otherwise, falls back to a head + truncation footer.
 */

import type { ChatCompletionRequest, ChatMessage } from "../providers/base";
import type { RTKConfig } from "./types";

const HUNK_HEAD_RE = /^@@ .+ @@/;
const TREE_LINE_RE = /^[│├└─\s]*[├└]──\s/;
const GIT_DIFF_HEAD_RE = /^(diff --git |index [0-9a-f]+|---|\+\+\+) /m;

/** Truncate a string in a structurally-aware way. */
export function smartTruncateText(
  text: string,
  maxChars: number,
  smart: boolean
): { text: string; saved: number } {
  if (text.length <= maxChars) return { text, saved: 0 };

  const before = text.length;

  if (smart && GIT_DIFF_HEAD_RE.test(text)) {
    const truncated = truncateGitDiff(text, maxChars);
    return { text: truncated, saved: before - truncated.length };
  }
  if (smart && looksLikeTree(text)) {
    const truncated = truncateTree(text, maxChars);
    return { text: truncated, saved: before - truncated.length };
  }

  // Generic: head + tail with banner.
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.max(0, maxChars - headSize - 80); // 80 chars for banner
  const head = text.slice(0, headSize);
  const tail = tailSize > 0 ? text.slice(-tailSize) : "";
  const droppedChars = before - head.length - tail.length;
  const droppedLines = (text.slice(headSize, before - tail.length).match(/\n/g) || []).length;
  const banner = `\n\n…[truncated ${droppedChars} chars / ~${droppedLines} lines]…\n\n`;
  const out = head + banner + tail;
  return { text: out, saved: before - out.length };
}

function looksLikeTree(text: string): boolean {
  const lines = text.split("\n").slice(0, 30);
  let hits = 0;
  for (const l of lines) if (TREE_LINE_RE.test(l)) hits++;
  return hits >= 5;
}

function truncateTree(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let depth0 = 0,
    depth1 = 0,
    deeperDropped = 0;
  for (const line of lines) {
    // Depth ~ count of leading │/space-pairs before connector.
    const m = line.match(/^([│ ]*)([├└]──)?/);
    const indent = (m?.[1]?.length ?? 0) / 2;
    if (indent <= 1) {
      kept.push(line);
      if (indent === 0) depth0++;
      else depth1++;
    } else {
      deeperDropped++;
    }
    if (kept.join("\n").length > maxChars - 100) break;
  }
  const summary = deeperDropped > 0 ? `\n…[${deeperDropped} deeper entries collapsed]\n` : "";
  return kept.join("\n") + summary;
}

function truncateGitDiff(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  const HUNK_KEEP_EDGE = 5;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (HUNK_HEAD_RE.test(line)) {
      // Collect hunk body until the next @@ or diff/--- marker.
      const hunkStart = i;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? "";
        if (HUNK_HEAD_RE.test(next) || /^diff --git /.test(next)) break;
        j++;
      }
      const hunkLines = lines.slice(hunkStart, j);
      if (hunkLines.length <= 1 + HUNK_KEEP_EDGE * 2) {
        out.push(...hunkLines);
      } else {
        out.push(hunkLines[0]!); // hunk header
        out.push(...hunkLines.slice(1, 1 + HUNK_KEEP_EDGE));
        const dropped = hunkLines.length - 1 - HUNK_KEEP_EDGE * 2;
        out.push(`…[${dropped} hunk lines elided]…`);
        out.push(...hunkLines.slice(-HUNK_KEEP_EDGE));
      }
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  let joined = out.join("\n");
  if (joined.length > maxChars) {
    joined =
      joined.slice(0, Math.floor(maxChars * 0.8)) +
      `\n…[truncated remainder of diff: ${joined.length - Math.floor(maxChars * 0.8)} chars]…`;
  }
  return joined;
}

/**
 * Identify which messages are "older" (eligible for compression).
 * Strategy: count messages from the end; the last `keepN * 2` messages
 * (~2 user/assistant pairs) are spared.
 */
function indicesToCompress(messages: ChatMessage[], keepN: number): Set<number> {
  const out = new Set<number>();
  const protectedFrom = Math.max(0, messages.length - keepN * 2);
  for (let i = 0; i < protectedFrom; i++) out.add(i);
  return out;
}

function compressBlock(block: any, cfg: RTKConfig, savedRef: { v: number }): any {
  if (!block || typeof block !== "object") return block;

  if (block.type === "tool_result") {
    if (typeof block.content === "string") {
      const { text, saved } = smartTruncateText(
        block.content,
        cfg.maxToolChars,
        cfg.smartTruncate
      );
      savedRef.v += saved;
      return { ...block, content: text };
    }
    if (Array.isArray(block.content)) {
      const newContent = block.content.map((inner: any) => {
        if (inner?.type === "text" && typeof inner.text === "string") {
          const { text, saved } = smartTruncateText(
            inner.text,
            cfg.maxToolChars,
            cfg.smartTruncate
          );
          savedRef.v += saved;
          return { ...inner, text };
        }
        return inner;
      });
      return { ...block, content: newContent };
    }
  }
  return block;
}

export function applyRTK(
  request: ChatCompletionRequest,
  cfg: RTKConfig
): { request: ChatCompletionRequest; saved: number } {
  if (!cfg.enabled) return { request, saved: 0 };
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return { request, saved: 0 };
  }

  const eligible = indicesToCompress(request.messages, cfg.keepLastNTurnsFull);
  if (eligible.size === 0) return { request, saved: 0 };

  const savedRef = { v: 0 };
  const newMessages = request.messages.map((msg, i) => {
    if (!eligible.has(i)) return msg;

    // OpenAI-shape: role:"tool" with string content.
    if (msg.role === "tool" && typeof msg.content === "string") {
      const { text, saved } = smartTruncateText(
        msg.content,
        cfg.maxToolChars,
        cfg.smartTruncate
      );
      savedRef.v += saved;
      return { ...msg, content: text };
    }

    if (Array.isArray(msg.content)) {
      const newContent = (msg.content as any[]).map((b) => compressBlock(b, cfg, savedRef));
      return { ...msg, content: newContent };
    }
    return msg;
  });

  return {
    request: { ...request, messages: newMessages },
    saved: savedRef.v,
  };
}
