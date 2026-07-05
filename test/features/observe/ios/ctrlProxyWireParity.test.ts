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

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const IOS_OBSERVE_DIR = resolve(REPO_ROOT, "src/features/observe/ios");
const SHARED_OBSERVE_DIR = resolve(REPO_ROOT, "src/features/observe/shared");
const MODELS_SWIFT = resolve(REPO_ROOT, "ios/control-proxy/Sources/CtrlProxy/Models.swift");

/**
 * Swift `RequestType` rawValues, transcribed by hand. The test below reads the real
 * enum out of Models.swift and asserts it equals this list, so the transcription
 * can't rot independently — but it makes the contract legible in one place.
 */
const SWIFT_REQUEST_TYPES = [
  "request_hierarchy",
  "request_hierarchy_if_stale",
  "request_screenshot",
  "request_tap_coordinates",
  "request_swipe",
  "request_two_finger_swipe",
  "request_multi_finger_swipe",
  "request_drag",
  "request_pinch",
  "request_set_text",
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
  "execute_sql",
  "list_databases",
  "list_tables",
  "get_table_data",
  "get_table_structure",
  "request_reset_permissions",
];

/**
 * Response-payload discriminators that share the `type:` JSON key with outbound
 * requests but are *inbound* shapes, not wire commands. `CtrlProxyDatabase.executeSQL`
 * classifies its result as `{ type: "mutation" }` / `{ type: "query" }`. They must be
 * excluded from the emit scan; a new non-request `type:` literal that is not listed
 * here will (correctly) fail the subset assertion and force a decision.
 */
const NON_REQUEST_TYPE_LITERALS = new Set(["mutation", "query"]);

/** Outbound-emit source files to scan. Excludes inbound decode + type/registry files. */
const EXCLUDED_IOS_FILES = new Set([
  "decodeCtrlProxyMessage.ts",
  "ctrlProxyRequestTypes.ts",
  "types.ts",
]);

/**
 * Shared delegates the iOS text + gesture paths route through. These files serve BOTH
 * platforms, so every command they emit must be valid on the iOS runner too — an
 * Android-only command added to a shared delegate would (correctly) fail this guard.
 * The list is hardcoded because iOS routes through exactly these two today; a new
 * shared delegate the iOS client adopts must be added here (tracked follow-up: derive
 * this from the iOS import graph so a missed delegate can't silently go unscanned).
 */
const SHARED_EMIT_FILES = ["SharedTextDelegate.ts", "SharedGestureDelegate.ts"];

function iosEmitSourceFiles(): string[] {
  const iosFiles = readdirSync(IOS_OBSERVE_DIR)
    .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !EXCLUDED_IOS_FILES.has(f))
    .map(f => resolve(IOS_OBSERVE_DIR, f));
  const sharedFiles = SHARED_EMIT_FILES.map(f => resolve(SHARED_OBSERVE_DIR, f));
  return [...iosFiles, ...sharedFiles];
}

// A wire command discriminator: lowercase snake_case, may contain digits (e.g. a
// hypothetical `request_swipe_v2`). Must match the Swift-side rawValue class so a
// digit-bearing command can't slip past either side of the guard.
const COMMAND_TOKEN = "[a-z][a-z0-9_]*";

/**
 * Extract every command `type` string a source file can put on the wire.
 *
 * This is a textual scan, not a full parse, so it recognizes only *literal* command
 * discriminators in three syntactic shapes (below). It deliberately cannot follow a
 * value hoisted into a `const` or built from a template — see `guardAgainstDynamicCommandTypes`,
 * which fails loudly on the template case, and the tracked follow-up for a structural
 * (AST/lint) replacement.
 */
function extractEmittedTypes(source: string): Set<string> {
  const found = new Set<string>();

  // 1. `messageType: "..."` — the shared sendCommand discriminator (never anything else).
  for (const m of source.matchAll(new RegExp(`messageType:\\s*"(${COMMAND_TOKEN})"`, "g"))) {
    found.add(m[1]);
  }
  // 2a. A string literal directly after the `type:` JSON key, tolerating a line break
  //     between key and value (`type:\n  "get_preferences"`). `messageType:`/
  //     `responseType:` (capital T) are not matched by \btype:.
  for (const m of source.matchAll(new RegExp(`\\btype:\\s*"(${COMMAND_TOKEN})"`, "g"))) {
    found.add(m[1]);
  }
  // 2b. Any string literal on a line carrying the `type:` key — catches the hierarchy
  //     ternary (`type: cond ? "request_hierarchy" : "request_hierarchy_if_stale"`).
  for (const line of source.split("\n")) {
    if (!/\btype:/.test(line)) { continue; }
    for (const m of line.matchAll(new RegExp(`"(${COMMAND_TOKEN})"`, "g"))) {
      found.add(m[1]);
    }
  }
  // 3. `CtrlProxyDatabase.request(<T>)("execute_sql", ...)` first-arg sends.
  for (const m of source.matchAll(new RegExp(`\\.request<[^>]*>\\(\\s*"(${COMMAND_TOKEN})"`, "g"))) {
    found.add(m[1]);
  }

  for (const denied of NON_REQUEST_TYPE_LITERALS) {
    found.delete(denied);
  }
  return found;
}

/**
 * The scan only understands *literal* command strings. A template-literal discriminator
 * (`` type: `request_${kind}` ``) would evade it entirely, silently dropping coverage.
 * Rather than parse it, forbid it in the scanned files so the scan's assumption is
 * enforced: a build using a dynamic command `type` must be made statically analyzable
 * (or this guard updated deliberately). Ternaries-of-literals and `{ type }` shorthand
 * (a variable, covered by rule 3) are intentionally allowed.
 */
function findDynamicCommandTypes(source: string): string[] {
  return [...source.matchAll(/\b(?:messageType|type):\s*`/g)].map(m => m[0]);
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
  for (const file of files) {
    for (const type of extractEmittedTypes(readFileSync(file, "utf8"))) {
      allEmitted.add(type);
    }
  }

  test("the scan actually finds emit sites (guards against a broken scanner)", () => {
    // Anchors that must always be present, spanning all three emit patterns.
    expect(allEmitted.has("request_tap_coordinates")).toBe(true); // messageType via shared delegate
    expect(allEmitted.has("get_preferences")).toBe(true); // type: object literal
    expect(allEmitted.has("request_hierarchy")).toBe(true); // type: ternary
    expect(allEmitted.has("execute_sql")).toBe(true); // .request(...) first arg
    expect(allEmitted.size).toBeGreaterThan(20);
  });

  test("every emitted command type is a known RequestType rawValue", () => {
    const unknown = [...allEmitted].filter(t => !IOS_KNOWN_REQUEST_TYPE_SET.has(t)).sort();
    // A non-empty list here is a drift: a TS command the runner cannot decode. Fix by
    // adding a matching `RequestType` case (and rawValue here), or repairing the sender.
    expect(unknown).toEqual([]);
  });

  test("no scanned file builds a command type from a template literal", () => {
    // The literal scan can't follow `` type: `request_${kind}` `` and would silently
    // drop coverage for it. Forbid the pattern so the scan's assumption stays valid.
    const offenders = files.flatMap(file =>
      findDynamicCommandTypes(readFileSync(file, "utf8")).map(hit => `${file}: ${hit}`)
    );
    expect(offenders).toEqual([]);
  });

  test("IOS_RUNNER_FEATURE_COMMANDS is a subset of the known RequestType set", () => {
    const unknown = IOS_RUNNER_FEATURE_COMMANDS.filter(c => !IOS_KNOWN_REQUEST_TYPE_SET.has(c));
    expect(unknown).toEqual([]);
  });
});
