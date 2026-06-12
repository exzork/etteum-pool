import { describe, expect, test } from "bun:test";
import { prepareLogBody } from "../../src/proxy/logging";

describe("prepareLogBody", () => {
  test("redacts prompt-bearing keys without mutating the original", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const logged = prepareLogBody(body);

    expect(body.messages[0]?.content).toBe("hello");
    expect(logged).not.toBe(body);
    expect(logged).toEqual({
      messages: [{ role: "user", content: "[redacted 5 chars]" }],
    });
  });

  test("leaves non-prompt keys intact", () => {
    const body = { model: "kp-opus", stream: true, n: 1 };
    expect(prepareLogBody(body)).toEqual({ model: "kp-opus", stream: true, n: 1 });
  });

  test("truncates very large values without mutating the original", () => {
    // `note` is not a redacted key, so it survives redaction and still exercises
    // the byte-size truncation path.
    const body = { note: "x".repeat(70_000) };
    const logged = prepareLogBody(body);

    expect(body.note).toHaveLength(70_000);
    expect(logged).not.toBe(body);
    expect(logged).toMatchObject({ truncated: true, maxBytes: 65_536 });
    expect((logged as { preview: string }).preview.length).toBeGreaterThan(0);
  });
});
