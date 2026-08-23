/**
 * Unit tests for the structural (AST) wire scanner (issue #2955).
 *
 * These prove the scanner catches the two false-negatives the textual regex scan of
 * #2857/#2950 missed — a const-hoisted discriminator and a parameter-forwarded
 * `{ type }` shorthand — and that its emit-site detection is scoped to the outbound
 * sinks so an inbound record carrying a `type` key is NOT counted as a wire command.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  deriveIosSharedEmitFiles,
  extractImportSpecifiers,
  scanFile,
  toPosixPath,
} from "./ctrlProxyWireScan";

const VIRTUAL = "/virtual/File.ts";

function typesOf(source: string): string[] {
  return scanFile(VIRTUAL, source)
    .emitted.map((e) => e.type)
    .sort();
}

describe("ctrlProxyWireScan.scanFile — discriminator resolution", () => {
  test("resolves a direct string-literal messageType in a sendCommand object", () => {
    const src = `sendCommand(ctx, { messageType: "request_tap_coordinates", params });`;
    expect(typesOf(src)).toEqual(["request_tap_coordinates"]);
  });

  test("resolves both branches of a ternary type in a JSON.stringify object", () => {
    const src = `ws.send(JSON.stringify({ type: cond ? "request_hierarchy" : "request_hierarchy_if_stale", requestId }));`;
    expect(typesOf(src)).toEqual(["request_hierarchy", "request_hierarchy_if_stale"]);
  });

  test("resolves a JSON.stringify of a const-bound object literal", () => {
    const src = `
      const message = { type: "list_preference_files", requestId };
      ws.send(JSON.stringify(message));
    `;
    expect(typesOf(src)).toEqual(["list_preference_files"]);
  });

  // ---- #2955 gap 1: const-hoisted discriminator (regex scan missed this) ----
  test("resolves a const-hoisted discriminator identifier (issue #2955 gap 1)", () => {
    const src = `
      const cmd = "request_shake";
      ws.send(JSON.stringify({ type: cmd, requestId }));
    `;
    expect(typesOf(src)).toEqual(["request_shake"]);
  });

  // ---- #2955 gap 1b: parameter-forwarded { type } shorthand (CtrlProxyDatabase) ----
  test("resolves a parameter-forwarded { type } shorthand via its call sites (issue #2955)", () => {
    const src = `
      class C {
        run() { return this.request("execute_sql", "execute_sql_result"); }
        other() { return this.request("list_tables", "list_tables_result"); }
        private request(type: string, responseType: string) {
          ws.send(JSON.stringify({ type, requestId }));
        }
      }
    `;
    expect(typesOf(src)).toEqual(["execute_sql", "list_tables"]);
  });

  test("reports an unresolved template-literal discriminator (does not silently drop it)", () => {
    const src = "ws.send(JSON.stringify({ type: `request_${kind}`, requestId }));";
    const result = scanFile(VIRTUAL, src);
    expect(result.emitted).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].text).toContain("type:");
  });

  test("reports an unresolved opaque-expression discriminator", () => {
    const src = `ws.send(JSON.stringify({ type: resolveKind(), requestId }));`;
    const result = scanFile(VIRTUAL, src);
    expect(result.emitted).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
  });

  // ---- sink-scoping: an inbound record carrying a `type` key is NOT a wire command ----
  test("ignores a non-emit object's type key (not inside a sink)", () => {
    const src = `recordSdkEvent({ type: envelope.eventType, timestamp, payload });`;
    const result = scanFile(VIRTUAL, src);
    expect(result.emitted).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  test("ignores a result classifier's type literal (not inside a sink)", () => {
    const src = `return result.mode === "w" ? { type: "mutation", rows } : { type: "query", rows };`;
    expect(typesOf(src)).toEqual([]);
  });

  test("ignores a non-command-like value (uppercase / non snake_case)", () => {
    const src = `ws.send(JSON.stringify({ type: "NotACommand", requestId }));`;
    const result = scanFile(VIRTUAL, src);
    // Non-command-like literal is dropped from emitted but is a resolvable literal, so
    // it is not flagged as unresolved either.
    expect(result.emitted).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

describe("ctrlProxyWireScan.extractImportSpecifiers", () => {
  test("collects static import and export-from specifiers", () => {
    const src = `
      import { A } from "../shared/SharedTextDelegate";
      import type { B } from "./types";
      export { C } from "../shared/SharedGestureDelegate";
      const x = 1;
    `;
    expect(extractImportSpecifiers(src, VIRTUAL).sort()).toEqual([
      "../shared/SharedGestureDelegate",
      "../shared/SharedTextDelegate",
      "./types",
    ]);
  });
});

describe("ctrlProxyWireScan.toPosixPath — separator-independence guard (issue #2955, Windows CI)", () => {
  // The import-graph derivation prefix-compares resolved fs paths against the shared
  // directory. On Windows `path.resolve` yields backslash separators; comparing those
  // against a forward-slash-joined prefix never matches and silently empties the derived
  // set. This pins that any backslash-containing path is normalized to forward slashes so
  // the comparison is OS-agnostic — Windows cannot regress silently.
  test("normalizes backslash-separated paths to forward slashes", () => {
    expect(toPosixPath("C:\\repo\\src\\shared\\SharedTextDelegate.ts")).toBe(
      "C:/repo/src/shared/SharedTextDelegate.ts",
    );
  });

  test("leaves already-posix paths unchanged", () => {
    expect(toPosixPath("/repo/src/shared/SharedTextDelegate.ts")).toBe(
      "/repo/src/shared/SharedTextDelegate.ts",
    );
  });
});

describe("ctrlProxyWireScan.deriveIosSharedEmitFiles — import-graph derivation (issue #2955 gap 2)", () => {
  test("discovers a shared delegate reachable transitively, skipping types.ts and tests", () => {
    const root = mkdtempSync(join(tmpdir(), "wirescan-"));
    try {
      const iosDir = join(root, "ios");
      const sharedDir = join(root, "shared");
      mkdirSync(iosDir);
      mkdirSync(sharedDir);

      // Entry imports a delegate directly and another indirectly through it.
      writeFileSync(
        join(iosDir, "Client.ts"),
        `import { Text } from "../shared/SharedTextDelegate";\nimport type { T } from "../shared/types";\n`,
      );
      writeFileSync(
        join(sharedDir, "SharedTextDelegate.ts"),
        `import { Nav } from "./SharedNavDelegate";\nexport const Text = 1;\n`,
      );
      // A NEW shared delegate reached only transitively — must be discovered.
      writeFileSync(join(sharedDir, "SharedNavDelegate.ts"), `export const Nav = 1;\n`);
      writeFileSync(join(sharedDir, "types.ts"), `export type T = string;\n`);
      writeFileSync(join(sharedDir, "SharedTextDelegate.test.ts"), `export const t = 1;\n`);

      const derived = deriveIosSharedEmitFiles(join(iosDir, "Client.ts"), sharedDir).map((f) =>
        f.slice(sharedDir.length + 1),
      );

      expect(derived).toEqual(["SharedNavDelegate.ts", "SharedTextDelegate.ts"]);
      // types.ts (type-only) and the .test.ts are excluded.
      expect(derived).not.toContain("types.ts");
      expect(derived).not.toContain("SharedTextDelegate.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns empty when the entry reaches no shared file", () => {
    const root = mkdtempSync(join(tmpdir(), "wirescan-"));
    try {
      const iosDir = join(root, "ios");
      const sharedDir = join(root, "shared");
      mkdirSync(iosDir);
      mkdirSync(sharedDir);
      writeFileSync(join(iosDir, "Client.ts"), `export const x = 1;\n`);
      writeFileSync(join(sharedDir, "SharedTextDelegate.ts"), `export const Text = 1;\n`);
      expect(deriveIosSharedEmitFiles(join(iosDir, "Client.ts"), sharedDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
