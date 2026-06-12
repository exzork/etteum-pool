import { describe, expect, test } from "bun:test";
import { applyPudidilFilters } from "../../src/proxy/filters";

describe("pudidil filters", () => {
  test("removes cc_entrypoint patterns (cli, gui, vscode, etc.)", () => {
    expect(applyPudidilFilters("cc_entrypoint=cli")).toBe("");
    expect(applyPudidilFilters("cc_entrypoint=gui")).toBe("");
    expect(applyPudidilFilters("cc_entrypoint=vscode")).toBe("");
    expect(applyPudidilFilters("cc_entrypoint=jetbrains")).toBe("");
  });

  test("removes cc_version patterns (any version)", () => {
    expect(applyPudidilFilters("cc_version=2.114.45a")).toBe("");
    expect(applyPudidilFilters("cc_version=3.0.0")).toBe("");
    expect(applyPudidilFilters("cc_version=99.99.99")).toBe("");
  });

  test("removes cch hash patterns", () => {
    expect(applyPudidilFilters("cch=33c97")).toBe("");
    expect(applyPudidilFilters("cch=8b6e8")).toBe("");
    expect(applyPudidilFilters("cch=abcdef1234")).toBe("");
  });

  test("removes Claude Code identity variations", () => {
    expect(applyPudidilFilters("You are Claude Code, Anthropic's official CLI for Claude.")).toBe("");
    expect(applyPudidilFilters("You are Claude Code, a powerful AI coding assistant.")).toBe("");
    expect(applyPudidilFilters("You are Claude Code.")).toBe("");
  });

  test("removes Anthropic CLI references", () => {
    expect(applyPudidilFilters("Anthropic's official CLI tool.")).toBe("");
    expect(applyPudidilFilters("Anthropic's official agent for coding.")).toBe("");
  });

  test("replaces 'Claude Code' mentions with 'the assistant'", () => {
    expect(applyPudidilFilters("This tool is used by Claude Code to fetch URLs")).toBe(
      "This tool is used by the assistant to fetch URLs"
    );
  });

  test("removes billing header patterns (any version)", () => {
    const header1 = "x-billing-header: cc_version=2.114.45a; cc_entrypoint=cli; ch=33c97;";
    expect(applyPudidilFilters(header1)).toBe("");

    const header2 = "x-anthropic-billing-header: cc_version=5.0.0; cc_entrypoint=gui; cch=abc123";
    expect(applyPudidilFilters(header2)).toBe("");
  });

  test("removes GitHub claude-code links", () => {
    expect(applyPudidilFilters("Report at https://github.com/anthropics/claude-code/issues/123")).toBe("Report at ");
  });

  test("removes Cursor/Windsurf/Cline agent identities", () => {
    expect(applyPudidilFilters("You are a powerful AI assistant made by Cursor.")).toBe("");
    expect(applyPudidilFilters("You are Windsurf, an AI coding assistant.")).toBe("");
    expect(applyPudidilFilters("You are Cline, a coding agent.")).toBe("");
  });

  test("removes 'powered by' patterns", () => {
    expect(applyPudidilFilters("This tool is powered by Claude.")).toBe("This tool is ");
    expect(applyPudidilFilters("powered by Anthropic's API.")).toBe("");
  });

  test("preserves normal content", () => {
    const normal = "Please help me write a function that fetches data from an API.";
    expect(applyPudidilFilters(normal)).toBe(normal);
  });

  test("handles tool result content with mixed patterns", () => {
    const toolResult = `File contents:
# README
This project uses Claude Code for development.
x-billing-header: cc_version=2.5.0; cc_entrypoint=gui; cch=12345
Some normal code here.`;

    const filtered = applyPudidilFilters(toolResult);
    expect(filtered).not.toContain("Claude Code");
    expect(filtered).not.toContain("x-billing-header");
    expect(filtered).not.toContain("cc_version");
    expect(filtered).toContain("Some normal code here.");
  });
});
