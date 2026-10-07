/**
 * Unit tests for the structural (AST) wire scanner (issue #2955).
 *
 * These prove the scanner catches the two false-negatives the textual regex scan of
 * #2857/#2950 missed — a const-hoisted discriminator and a parameter-forwarded
 * `{ type }` shorthand — and that its emit-site detection is scoped to the outbound
 * sinks so an inbound record carrying a `type` key is NOT counted as a wire command.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
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
  test("Magic Tap delegate emits the additive runner command", () => {
    const file = resolve(
      import.meta.dir,
      "../../../../src/features/observe/ios/CtrlProxyVoiceOver.ts",
    );
    const result = scanFile(file, readFileSync(file, "utf8"));
    expect(result.emitted.map((emit) => emit.type)).toContain("request_magic_tap");
    expect(result.unresolved).toEqual([]);
  });
  test("finds both hierarchy request types in the production source with no unresolved sites", () => {
    const file = resolve(
      import.meta.dir,
      "../../../../src/features/observe/ios/CtrlProxyHierarchy.ts",
    );
    const result = scanFile(file, readFileSync(file, "utf8"));
    expect(result.emitted.map((emit) => emit.type).sort()).toEqual([
      "request_hierarchy",
      "request_hierarchy_if_stale",
    ]);
    expect(result.unresolved).toEqual([]);
  });

  test("the gesture, text and dispatch sources report no unresolved sink argument", () => {
    const files = [
      "../../../../src/features/observe/ios/CtrlProxyGestures.ts",
      "../../../../src/features/observe/ios/CtrlProxyText.ts",
      "../../../../src/features/observe/ios/CtrlProxyDispatch.ts",
      "../../../../src/features/observe/shared/SharedGestureDelegate.ts",
      "../../../../src/features/observe/shared/SharedTextDelegate.ts",
    ].map((relative) => resolve(import.meta.dir, relative));
    for (const file of files) {
      expect(scanFile(file, readFileSync(file, "utf8")).unresolved).toEqual([]);
    }
  });

  test("resolves a direct string-literal messageType in a sendCommand object", () => {
    const src = `sendCommand(ctx, { messageType: "request_tap_coordinates", params });`;
    expect(typesOf(src)).toEqual(["request_tap_coordinates"]);
  });

  test("resolves a messageType in a sendIOSPressCommand object", () => {
    const src = `sendIOSPressCommand(this.context, { messageType: "request_press_home", params });`;
    expect(typesOf(src)).toEqual(["request_press_home"]);
  });

  test("resolves a messageType in an options builder whose result is passed as a call expression", () => {
    const src = `
      class Delegate {
        tapCommandOptions(tap) {
          return { idPrefix: "tap", messageType: "request_tap_coordinates", params: {} };
        }
        send(tap) {
          return sendIOSPressCommand(this.context, this.tapCommandOptions(tap));
        }
      }
    `;
    expect(typesOf(src)).toEqual(["request_tap_coordinates"]);
  });

  test("a returned object without a messageType is not an emit site", () => {
    const src = `function result() { return { type: "mutation", rows: [] }; }`;
    expect(typesOf(src)).toEqual([]);
  });

  test("finds the tap and pinch wire commands emitted by the shared gesture delegate", () => {
    const file = resolve(
      import.meta.dir,
      "../../../../src/features/observe/shared/SharedGestureDelegate.ts",
    );
    const result = scanFile(file, readFileSync(file, "utf8"));
    const emitted = result.emitted.map((emit) => emit.type);
    expect(emitted).toContain("request_tap_coordinates");
    expect(emitted).toContain("request_pinch");
    expect(emitted).toContain("request_swipe");
    expect(result.unresolved).toEqual([]);
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

  // ---- sink arguments the scan cannot decide are reported, never skipped silently ----
  test("reports a call-expression sink argument that is not a known builder", () => {
    const src = `sendCommand(this.context, buildSomething(request));`;
    const result = scanFile(VIRTUAL, src);
    expect(result.emitted).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].text).toBe("buildSomething(request)");
  });

  test("reports an identifier sink argument that is not bound to an object literal", () => {
    const src = `sendIOSPressCommand(this.context, requestOptions);`;
    expect(scanFile(VIRTUAL, src).unresolved).toHaveLength(1);
  });

  test("reports a spread-only literal whose discriminator the scan cannot see", () => {
    const src = `sendIOSPressCommand(this.context, { ...build(request), onDispatch });`;
    const result = scanFile(VIRTUAL, src);
    expect(result.emitted).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
  });

  test("reports a spread-only JSON.stringify literal", () => {
    const src = `ws.send(JSON.stringify({ ...base, requestId }));`;
    expect(scanFile(VIRTUAL, src).unresolved).toHaveLength(1);
  });

  test("reports a delegate seam call whose argument is a call expression", () => {
    const src = `this.sendTextCommand(makeTextOptions(text));`;
    expect(scanFile(VIRTUAL, src).unresolved).toHaveLength(1);
  });

  test("scans the literal passed to a delegate text seam", () => {
    const src = `this.sendTextCommand({ messageType: "request_set_text", params });`;
    const result = scanFile(VIRTUAL, src);
    expect(result.emitted.map((emit) => emit.type)).toEqual(["request_set_text"]);
    expect(result.unresolved).toEqual([]);
  });

  test("does not report a request-options builder call or a spread of one", () => {
    const src = `
      class Delegate {
        a() { return sendIOSPressCommand(this.context, this.tapCommandOptions(tap)); }
        b() { return sendIOSPressCommand(this.context, { ...this.pinchCommandOptions(r), onDispatch }); }
        tapCommandOptions() { return { messageType: "request_tap_coordinates" }; }
        pinchCommandOptions() { return { messageType: "request_pinch" }; }
      }
    `;
    const result = scanFile(VIRTUAL, src);
    expect(result.unresolved).toEqual([]);
    expect(result.emitted.map((emit) => emit.type).sort()).toEqual([
      "request_pinch",
      "request_tap_coordinates",
    ]);
  });

  test("does not report options forwarded from a SendCommandOptions parameter", () => {
    const src = `
      class Delegate {
        protected sendSwipeCommand(options: SendCommandOptions<Result>) {
          return sendCommand<Result>(this.context, options);
        }
        wrap(options: SendCommandOptions<Result>) {
          return sendCommand<Result>(this.context, { ...options, deadlineMs: 1 });
        }
      }
    `;
    expect(scanFile(VIRTUAL, src).unresolved).toEqual([]);
  });

  test("an identifier parameter of another type is not a forwarded request", () => {
    const src = `function send(options: Other) { return sendCommand(this.context, options); }`;
    expect(scanFile(VIRTUAL, src).unresolved).toHaveLength(1);
  });

  test("JSON.stringify of arbitrary data is not reported", () => {
    const src = `const a = JSON.stringify(payload); const b = JSON.stringify(load()); const c = JSON.stringify({ nodeCount, packageName });`;
    expect(scanFile(VIRTUAL, src).unresolved).toEqual([]);
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
