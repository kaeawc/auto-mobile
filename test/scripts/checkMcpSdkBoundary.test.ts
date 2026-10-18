import { describe, expect, test } from "bun:test";
import {
  IMPORT_ROOTS,
  compare,
  countImportViolations,
  countTokenViolations,
  scan,
  type Counts,
} from "../../scripts/check-mcp-sdk-boundary";

const importCounts = (source: string): Counts => {
  const counts: Counts = {};
  countImportViolations("f.ts", source, counts);
  return counts;
};

describe("check-mcp-sdk-boundary", () => {
  test("scans test/ for v1 SDK imports, not only src/ and scripts/", () => {
    expect(IMPORT_ROOTS).toContain("test");
    const counts = scan(
      () => 'import { Client } from "@modelcontextprotocol/sdk/client/index.js";',
      ["test/server/x.test.ts"],
      [],
    );
    expect(compare(counts, {}).excess).toEqual([
      "test/server/x.test.ts: sdk-import x1 (allowed 0)",
    ]);
  });

  test("flags every v1 SDK import form", () => {
    const source = [
      'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
      'import type { X } from "@modelcontextprotocol/sdk";',
      'export * from "@modelcontextprotocol/sdk/types.js";',
      'const m = await import("@modelcontextprotocol/sdk/client");',
      'type T = import("@modelcontextprotocol/sdk/types.js").Tool;',
    ].join("\n");
    expect(importCounts(source)["f.ts"]?.["sdk-import"]).toBe(5);
  });

  test("allows the v2 split packages and unrelated sdk packages", () => {
    const source = [
      'import { McpServer } from "@modelcontextprotocol/server";',
      'import { Client } from "@modelcontextprotocol/client/stdio";',
      'import { s } from "@modelcontextprotocol/sdk-like-but-not";',
    ].join("\n");
    expect(importCounts(source)).toEqual({});
  });

  test("flags require of any @modelcontextprotocol package, and sdk requires twice", () => {
    const source = [
      'const a = require("@modelcontextprotocol/server");',
      'import b = require("@modelcontextprotocol/client");',
      'const c = require("@modelcontextprotocol/sdk/server");',
    ].join("\n");
    expect(importCounts(source)["f.ts"]).toEqual({ "sdk-require": 3, "sdk-import": 1 });
  });

  test("counts stateful-session tokens but not the stateless header", () => {
    const counts: Counts = {};
    countTokenViolations(
      "src/x.ts",
      [
        'req.headers["mcp-session-id"]; "Mcp-Session-Id";',
        "{ sessionIdGenerator: () => id, onsessioninitialized: () => {} }",
        "sessionContext.sessionId = id;",
        'const H = "x-auto-mobile-mcp-session-id";',
      ].join("\n"),
      counts,
    );
    expect(counts["src/x.ts"]).toEqual({
      "mcp-session-id": 2,
      sessionIdGenerator: 1,
      onsessioninitialized: 1,
      "sessionContext.sessionId": 1,
    });
  });

  test("scan applies imports to import files and tokens to token files only", () => {
    const files: Record<string, string> = {
      "scripts/a.ts": 'import x from "@modelcontextprotocol/sdk";\nconst k = "mcp-session-id";',
      "src/b.ts": 'const k = "mcp-session-id";',
    };
    const counts = scan((f) => files[f], ["scripts/a.ts"], ["src/b.ts"]);
    expect(counts).toEqual({
      "scripts/a.ts": { "sdk-import": 1 },
      "src/b.ts": { "mcp-session-id": 1 },
    });
  });

  test("compare fails on growth and reports stale entries without failing", () => {
    const allowed: Counts = {
      "src/a.ts": { "mcp-session-id": 2 },
      "src/gone.ts": { sessionIdGenerator: 1 },
    };
    const actual: Counts = {
      "src/a.ts": { "mcp-session-id": 3 },
      "src/new.ts": { "sdk-import": 1 },
    };
    const { excess, stale } = compare(actual, allowed);
    expect(excess).toEqual([
      "src/a.ts: mcp-session-id x3 (allowed 2)",
      "src/new.ts: sdk-import x1 (allowed 0)",
    ]);
    expect(stale).toEqual(["src/gone.ts: sessionIdGenerator x0 (allowlist says 1)"]);
    expect(compare(allowed, allowed)).toEqual({ excess: [], stale: [] });
  });
});
