import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_REQUEST_TYPES } from "../../../../src/features/observe/android/ctrlProxyProtocol";
import {
  CTRL_PROXY_REQUEST_FIELDS,
  CTRL_PROXY_RESPONSE_FIELDS,
} from "../../../../src/features/observe/android/ctrlProxyWireManifest";

interface WireField {
  name: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
}
interface WireType {
  serialName: string;
  fields: WireField[];
}
// Read once; test bodies compare in-memory declarations only.
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/android-contract/android-wire-contract.json"),
    "utf8",
  ),
) as { requests: WireType[]; responses: WireType[]; nestedTypes: Record<string, WireField[]> };
type RequestField = "required" | "optional" | "required_nullable" | "optional_nullable";
const requests: Record<string, Record<string, RequestField>> = CTRL_PROXY_REQUEST_FIELDS;
const responses: Record<
  string,
  Record<string, "required" | "optional">
> = CTRL_PROXY_RESPONSE_FIELDS;

// Every device frame now has a WebSocketResponse subclass (#11877); a new entry here documents a
// frame a device emitter builds without one.
const HAND_SERIALIZED_RESPONSE_TYPES: Record<string, string> = {};
const KOTLIN_FIELDS_TS_IGNORES: Record<string, string> = {};
// Each key names one concrete exception, never a wildcard. Normal success/push messages inherit
// the host's optional error slot even when only protocol-level failures use it.
const TS_ONLY_RESPONSE_FIELDS: Record<string, string> = {
  "connected.error": "WsMessageBase permits an error; ConnectedResponse has no error slot.",
  "hierarchy_update.error":
    "WsMessageBase permits an error; HierarchyUpdateEvent has no error slot.",
  "screenshot.error": "WsMessageBase permits an error; screenshot failures use screenshot_error.",
  "interaction_event.error": "WsMessageBase permits an error; InteractionEvent has no error slot.",
  "package_event.error": "WsMessageBase permits an error; PackageEvent has no error slot.",
  "navigation_event.error":
    "WsMessageBase permits an error; NavigationEventResponse has no error slot.",
  "handled_exception_event.error":
    "WsMessageBase permits an error; handled exceptions live inside event.",
  "network_event.error": "WsMessageBase permits an error; network failures live inside event.",
  "websocket_frame_event.error":
    "WsMessageBase permits an error; frame failures live inside event.",
  "log_event.error": "WsMessageBase permits an error; LogEventResponse has no error slot.",
  "broadcast_event.error":
    "WsMessageBase permits an error; BroadcastEventResponse has no error slot.",
  "lifecycle_event.error":
    "WsMessageBase permits an error; LifecycleEventResponse has no error slot.",
  "frame_metrics_event.error":
    "WsMessageBase permits an error; FrameMetricsEventResponse has no error slot.",
  "storage_changed.error": "WsMessageBase permits an error; StorageChangedEvent has no error slot.",
  "crash_event.error": "WsMessageBase permits an error; crash details live inside event.",
  "anr_event.error": "WsMessageBase permits an error; ANR details live inside event.",
  "keystore_reset.error": "WsMessageBase permits an error; reset failures live inside state.",
  "keystore_discovery.error":
    "WsMessageBase permits an error; discovery failures live inside state.",
  "sdk_capabilities.error":
    "WsMessageBase permits an error; capability failures live inside state.",
  "display_transition.error":
    "WsMessageBase permits an error; DisplayTransitionEvent has no error slot.",
  "cancel_ime_commit_result.error":
    "WsMessageBase permits an error; CancelImeCommitResult has no error slot.",
  "cancel_ime_commit_result.totalTimeMs":
    "Optional host timing slot; the cancellation reply omits it.",
  "insert_text_state_result.error":
    "WsMessageBase permits an error; InsertTextStateResult has no error slot.",
  "insert_text_state_result.totalTimeMs": "Optional host timing slot; the state reply omits it.",
  "preference_files.totalTimeMs": "Optional host timing slot; storage broadcaster omits it.",
  "preferences.totalTimeMs": "Optional host timing slot; storage broadcaster omits it.",
  "subscribe_storage_result.totalTimeMs":
    "Optional host timing slot; storage broadcaster omits it.",
  "unsubscribe_storage_result.totalTimeMs":
    "Optional host timing slot; storage broadcaster omits it.",
  "get_preference_result.totalTimeMs": "Optional host timing slot; storage broadcaster omits it.",
  "set_preference_result.totalTimeMs": "Optional host timing slot; storage broadcaster omits it.",
  "remove_preference_result.totalTimeMs":
    "Optional host timing slot; storage broadcaster omits it.",
  "clear_preferences_result.totalTimeMs":
    "Optional host timing slot; storage broadcaster omits it.",
  "prototype_result.totalTimeMs": "Optional host timing slot; PrototypeResult replies omit it.",
};

const responseNames = fixture.responses.map(({ serialName }) => serialName);
const kotlinOnly: string[] = [];
const tsOnly: string[] = [];
for (const { serialName, fields } of fixture.responses) {
  const manifest = responses[serialName] ?? {};
  const names = new Set(fields.map(({ name }) => name));
  for (const { name } of fields) {
    if (!(name in manifest)) {
      kotlinOnly.push(`${serialName}.${name}`);
    }
  }
  for (const name of Object.keys(manifest)) {
    if (name !== "type" && !names.has(name)) {
      tsOnly.push(`${serialName}.${name}`);
    }
  }
}

// No default means the device requires the property. Explicit null is also rejected when
// Kotlin is non-nullable; the host may safely be stricter than a nullable/defaulted field.
function requestFieldViolations({ serialName, fields }: WireType): string[] {
  const manifest = requests[serialName];
  const violations: string[] = [];
  for (const field of fields) {
    if (!field.hasDefault) {
      const marker = manifest[field.name];
      if (marker !== "required" && marker !== "required_nullable") {
        violations.push(`${serialName}.${field.name}: optional`);
      }
      if (!field.nullable && marker.endsWith("_nullable")) {
        violations.push(`${serialName}.${field.name}: nullable`);
      }
    }
  }
  return violations;
}

describe("Kotlin serializer descriptors → Android host declarations", () => {
  test("request type sets agree exactly", () => {
    const names = fixture.requests.map(({ serialName }) => serialName).sort();
    expect(names.length).toBeGreaterThanOrEqual(60);
    expect(names).toEqual([...KNOWN_REQUEST_TYPES].sort());
    expect(names).toEqual(Object.keys(requests).sort());
  });

  for (const { serialName, fields } of fixture.requests) {
    test(`request fields: ${serialName}`, () => {
      const manifest = requests[serialName];
      expect(
        Object.keys(manifest)
          .filter((name) => name !== "type")
          .sort(),
      ).toEqual(fields.map(({ name }) => name).sort());
      expect(requestFieldViolations({ serialName, fields })).toEqual([]);
    });
  }

  test("rejects TS null when a required Kotlin field becomes non-nullable", () => {
    const original = fixture.requests.find(({ serialName }) => serialName === "set_preference");
    expect(original).toBeDefined();
    if (!original) {
      throw new Error("Missing set_preference fixture");
    }
    const mutated = structuredClone(original);
    const value = mutated.fields.find(({ name }) => name === "value");
    expect(value).toBeDefined();
    if (!value) {
      throw new Error("Missing set_preference.value fixture");
    }
    expect(value.nullable).toBe(true);
    expect(value.hasDefault).toBe(false);
    expect(requestFieldViolations(original)).toEqual([]);
    value.nullable = false;
    expect(requestFieldViolations(mutated)).toEqual(["set_preference.value: nullable"]);
    expect(original.fields.find(({ name }) => name === "value")?.nullable).toBe(true);
  });

  test("response types agree, except documented hand-built frames", () => {
    expect(responseNames.length).toBeGreaterThanOrEqual(55);
    expect(new Set(responseNames).size).toBe(responseNames.length);
    expect(
      Object.keys(responses)
        .filter((name) => !responseNames.includes(name))
        .sort(),
    ).toEqual(Object.keys(HAND_SERIALIZED_RESPONSE_TYPES).sort());
    for (const name of responseNames) {
      expect(name in responses).toBe(true);
    }
    for (const [name, reason] of Object.entries(HAND_SERIALIZED_RESPONSE_TYPES)) {
      expect(responseNames).not.toContain(name); // An adopted serializer makes this entry stale.
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  for (const { serialName, fields } of fixture.responses) {
    test(`response fields: ${serialName}`, () => {
      const manifest = responses[serialName];
      expect(manifest).toBeDefined();
      for (const field of fields) {
        const key = `${serialName}.${field.name}`;
        expect(field.name in manifest || key in KOTLIN_FIELDS_TS_IGNORES).toBe(true);
        if (manifest[field.name] === "required") {
          expect(field.nullable).toBe(false);
        }
      }
      const names = new Set(fields.map(({ name }) => name));
      for (const name of Object.keys(manifest)) {
        if (name !== "type" && !names.has(name)) {
          expect(`${serialName}.${name}` in TS_ONLY_RESPONSE_FIELDS).toBe(true);
        }
      }
    });
  }

  test("field exceptions are all still exercised", () => {
    expect(kotlinOnly.sort()).toEqual(Object.keys(KOTLIN_FIELDS_TS_IGNORES).sort());
    expect(tsOnly.sort()).toEqual(Object.keys(TS_ONLY_RESPONSE_FIELDS).sort());
    for (const reason of [
      ...Object.values(KOTLIN_FIELDS_TS_IGNORES),
      ...Object.values(TS_ONLY_RESPONSE_FIELDS),
    ]) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});
