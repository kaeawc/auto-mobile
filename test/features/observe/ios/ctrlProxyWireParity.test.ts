/**
 * Cross-language wire-parity tripwire for the iOS control-proxy TS client ↔ Swift runner.
 *
 * The Swift runner locks its inbound command set with the `RequestType` enum
 * (`ios/control-proxy/Sources/CtrlProxy/Models.swift`), but before #2857 nothing on
 * the TS side asserted that the command `type` strings the iOS client *emits* stay a
 * subset of those rawValues. A new/renamed TS command compiled cleanly and only
 * failed at runtime on-device as an "Unknown command type: <type>" error — the exact
 * `request_voiceover_action` mismatch this test was added to catch (issue #2857).
 *
 * This is the iOS analog of Android's `ctrlProxyProtocol.test.ts` KNOWN_REQUEST_TYPES
 * guard (#2835). Two independent guarantees:
 *   1. `IOS_KNOWN_REQUEST_TYPES` equals the `RequestType` rawValues read live from
 *      `Models.swift` — a case renamed/added/removed on the runner fails here.
 *   2. Every command `type`/`messageType` the iOS client can emit (scanned from
 *      source) is a member of `IOS_KNOWN_REQUEST_TYPES` — adding a TS command without
 *      a matching runner rawValue fails here.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import {
  IOS_KNOWN_REQUEST_TYPES,
  IOS_KNOWN_REQUEST_TYPE_SET,
} from "../../../../src/features/observe/ios/ctrlProxyRequestTypes";
import { IOS_RUNNER_FEATURE_COMMANDS } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { deriveIosSharedEmitFiles, scanFile } from "./ctrlProxyWireScan";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const IOS_OBSERVE_DIR = resolve(REPO_ROOT, "src/features/observe/ios");
const SHARED_OBSERVE_DIR = resolve(REPO_ROOT, "src/features/observe/shared");
const IOS_CLIENT_ENTRY = resolve(IOS_OBSERVE_DIR, "IOSCtrlProxyClient.ts");
const MODELS_SWIFT = resolve(REPO_ROOT, "ios/control-proxy/Sources/CtrlProxy/Models.swift");

/**
 * Swift `RequestType` rawValues, transcribed by hand. The test below reads the real
 * enum out of Models.swift and asserts it equals this list, so the transcription
 * can't rot independently — but it makes the contract legible in one place.
 */
const SWIFT_REQUEST_TYPES = [
  "request_hierarchy",
  "request_hierarchy_if_stale",
  "set_hierarchy_poll_interval",
  "request_screenshot",
  "request_tap_coordinates",
  "request_swipe",
  "request_two_finger_swipe",
  "request_multi_finger_swipe",
  "request_drag",
  "request_pinch",
  "request_set_text",
  "request_append_text",
  "request_clear_text",
  "request_ime_action",
  "request_select_all",
  "request_keyboard",
  "request_press_button",
  "request_press_home",
  "request_press_back",
  "request_shake",
  "request_recent_apps",
  "request_action",
  "request_launch_app",
  "request_rotate",
  "request_clipboard",
  "get_current_focus",
  "get_traversal_order",
  "add_highlight",
  "get_voiceover_state",
  "list_preference_files",
  "get_preferences",
  "get_preference",
  "set_preference",
  "remove_preference",
  "clear_preferences",
  "set_network_mock_rules",
  "set_network_error_simulation",
  "execute_sql",
  "list_databases",
  "storage_capabilities",
  "list_tables",
  "get_table_data",
  "get_table_structure",
  "request_reset_permissions",
];

/**
 * Response-payload discriminators that share the `type:` JSON key with outbound
 * requests but are *inbound* shapes, not wire commands. `CtrlProxyDatabase.executeSQL`
 * classifies its result as `{ type: "mutation" }` / `{ type: "query" }`.
 *
 * The AST scanner scopes emit detection to the `JSON.stringify(...)` / `sendCommand(...)`
 * sinks, so these result-classifier objects are no longer picked up at all — this
 * denylist is now defense-in-depth: if a future refactor DID serialize a `{ type }`
 * result over the wire, the literal would still be excluded here rather than tripping
 * the subset assertion. A genuinely-new non-request literal not listed here will
 * (correctly) fail the subset assertion and force a decision.
 */
const NON_REQUEST_TYPE_LITERALS = new Set(["mutation", "query"]);

/** Outbound-emit source files to scan. Excludes inbound decode + type/registry files. */
const EXCLUDED_IOS_FILES = new Set([
  "decodeCtrlProxyMessage.ts",
  "ctrlProxyRequestTypes.ts",
  "types.ts",
]);

// A wire command discriminator: lowercase snake_case, may contain digits (e.g. a
// hypothetical `request_swipe_v2`). Must match the Swift-side rawValue class so a
// digit-bearing command can't slip past either side of the guard.
const COMMAND_TOKEN = "[a-z][a-z0-9_]*";

/**
 * The iOS emit source files: every non-test `.ts` in the iOS observe dir (minus inbound
 * decode/registry files) plus the shared delegates DERIVED from the iOS client's
 * transitive import graph (issue #2955). A new shared delegate the iOS client routes
 * through is discovered automatically, so it cannot silently go unscanned — no hardcoded
 * `SHARED_EMIT_FILES` allowlist to fall out of date.
 */
function iosEmitSourceFiles(): string[] {
  const iosFiles = readdirSync(IOS_OBSERVE_DIR)
    .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !EXCLUDED_IOS_FILES.has(f))
    .map(f => resolve(IOS_OBSERVE_DIR, f));
  const sharedFiles = deriveIosSharedEmitFiles(IOS_CLIENT_ENTRY, SHARED_OBSERVE_DIR);
  return [...iosFiles, ...sharedFiles];
}

/**
 * Extract every command `type`/`messageType` string a source file can put on the wire,
 * using the TypeScript AST (issue #2955). Unlike the retired textual scan, this follows
 * const-hoisted and parameter-forwarded discriminators to their literal (see
 * `ctrlProxyWireScan.ts`). An emit site whose discriminator is NOT statically decidable
 * (template literal, opaque expression) is returned in `unresolved` so the guard fails
 * loudly rather than dropping coverage — the structural analog of the old template guard.
 */
function extractEmittedTypes(file: string, source: string): { emitted: Set<string>; unresolved: string[] } {
  const result = scanFile(file, source);
  const emitted = new Set(result.emitted.map(e => e.type));
  for (const denied of NON_REQUEST_TYPE_LITERALS) {
    emitted.delete(denied);
  }
  const unresolved = result.unresolved.map(u => `${u.file}:${u.line} ${u.text}`);
  return { emitted, unresolved };
}

function readSwiftRequestTypeRawValues(): string[] {
  const source = readFileSync(MODELS_SWIFT, "utf8");
  const block = source.match(/public enum RequestType: String, CaseIterable \{([\s\S]*?)\n\}/);
  if (!block) {
    throw new Error("Could not locate `enum RequestType` in Models.swift");
  }
  return [...block[1].matchAll(new RegExp(`case\\s+\\w+\\s*=\\s*"(${COMMAND_TOKEN})"`, "g"))].map(m => m[1]);
}

describe("iOS control-proxy — RequestType contract coverage", () => {
  test("IOS_KNOWN_REQUEST_TYPES matches the transcribed Swift rawValue list", () => {
    expect([...IOS_KNOWN_REQUEST_TYPES].sort()).toEqual([...SWIFT_REQUEST_TYPES].sort());
  });

  test("no duplicate discriminators", () => {
    expect(new Set(IOS_KNOWN_REQUEST_TYPES).size).toBe(IOS_KNOWN_REQUEST_TYPES.length);
  });

  // Authoritative cross-language guard: read the real rawValues out of the Swift enum
  // and assert they equal ours. Unlike the hand-transcribed list, this fails when a
  // case is renamed/added/removed on the runner — the drift the module exists to
  // prevent. Skipped only if Models.swift is unreachable (never in CI).
  test.skipIf(!existsSync(MODELS_SWIFT))(
    "IOS_KNOWN_REQUEST_TYPES matches the RequestType rawValues read from Models.swift",
    () => {
      const rawValues = readSwiftRequestTypeRawValues();
      expect(rawValues.length).toBeGreaterThan(0);
      expect([...new Set(rawValues)].sort()).toEqual([...IOS_KNOWN_REQUEST_TYPES].sort());
      // The transcribed list must also match source, so it can't rot independently.
      expect([...new Set(rawValues)].sort()).toEqual([...SWIFT_REQUEST_TYPES].sort());
    }
  );
});

describe("iOS control-proxy — emitted commands are a subset of the runner contract", () => {
  const files = iosEmitSourceFiles();
  const allEmitted = new Set<string>();
  const allUnresolved: string[] = [];
  for (const file of files) {
    const { emitted, unresolved } = extractEmittedTypes(file, readFileSync(file, "utf8"));
    for (const type of emitted) {
      allEmitted.add(type);
    }
    allUnresolved.push(...unresolved);
  }

  test("the shared-delegate scan set is derived from the iOS import graph", () => {
    // Regression guard for #2955 gap 2: the shared files must be discovered via the
    // import graph, not a hardcoded allowlist. The two delegates the client routes
    // through today must both appear; a new one would appear automatically.
    const shared = deriveIosSharedEmitFiles(IOS_CLIENT_ENTRY, SHARED_OBSERVE_DIR).map(f =>
      f.slice(SHARED_OBSERVE_DIR.length + 1)
    );
    expect(shared).toContain("SharedTextDelegate.ts");
    expect(shared).toContain("SharedGestureDelegate.ts");
  });

  test("the scan actually finds emit sites (guards against a broken scanner)", () => {
    // Anchors that must always be present, spanning every resolvable emit shape.
    expect(allEmitted.has("request_tap_coordinates")).toBe(true); // messageType via shared delegate
    expect(allEmitted.has("get_preferences")).toBe(true); // type: object literal
    expect(allEmitted.has("request_hierarchy")).toBe(true); // type: ternary of literals
    expect(allEmitted.has("request_hierarchy_if_stale")).toBe(true); // ternary other branch
    expect(allEmitted.has("execute_sql")).toBe(true); // parameter-forwarded { type } shorthand
    expect(allEmitted.size).toBeGreaterThan(20);
  });

  test("every emitted command type is a known RequestType rawValue", () => {
    const unknown = [...allEmitted].filter(t => !IOS_KNOWN_REQUEST_TYPE_SET.has(t)).sort();
    // A non-empty list here is a drift: a TS command the runner cannot decode. Fix by
    // adding a matching `RequestType` case (and rawValue here), or repairing the sender.
    expect(unknown).toEqual([]);
  });

  test("no scanned emit site has a statically-unresolvable command type", () => {
    // The AST scanner resolves literals, ternaries-of-literals, const-hoisted and
    // parameter-forwarded discriminators. Anything it CANNOT decide (a template literal,
    // an opaque call) would silently drop coverage — fail loudly and force it to be made
    // statically analyzable, the structural successor to the old template-literal guard.
    expect(allUnresolved).toEqual([]);
  });

  test("IOS_RUNNER_FEATURE_COMMANDS is a subset of the known RequestType set", () => {
    const unknown = IOS_RUNNER_FEATURE_COMMANDS.filter(c => !IOS_KNOWN_REQUEST_TYPE_SET.has(c));
    expect(unknown).toEqual([]);
  });

  test("IOS_RUNNER_FEATURE_COMMANDS excludes append until the runner release", () => {
    const baselineCommands: readonly string[] = IOS_RUNNER_FEATURE_COMMANDS;
    expect(baselineCommands).not.toContain("request_append_text");
    expect(baselineCommands).not.toContain("set_network_error_simulation");
  });
});
