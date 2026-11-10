import { describe, expect, test } from "bun:test";
import type { z } from "zod/v4";
import { formatToolParamError } from "../../src/utils/toolParamError";
import { systemTraySchema, tapAnySchema, tapOnSchema } from "../../src/server/interactionTools";
import { identifyInteractionsSchema, observeSchema } from "../../src/server/observeTools";
import { setDeviceStateSchema } from "../../src/server/utilityTools";
import { videoRecordingSchema } from "../../src/server/videoRecordingToolContext";
import { setUIStateSchema } from "../../src/server/formTools";
import { portReverseSchema } from "../../src/server/portReverseTools";
import { postNotificationSchema } from "../../src/server/notificationTools";
import { auditBaselineInput, auditScopeInput } from "../../src/server/auditToolSchemas";

// #17738: an unknown key inside a nested option object was silently stripped.
// Each one is strict now, so the key is rejected and the argument-shape hint
// names that object's allowed keys.

const MAX_HINT_CHARS = 250;

function hintOf(message: string): string {
  const marker = " Hint: ";
  const index = message.indexOf(marker);
  return index < 0 ? "" : message.slice(index + marker.length);
}

function messageFor(toolName: string, schema: z.ZodType, input: unknown): string {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error(`expected ${toolName} to reject ${JSON.stringify(input)}`);
  }
  return formatToolParamError(toolName, result.error, input, schema);
}

interface NestedCase {
  readonly tool: string;
  readonly schema: z.ZodType;
  readonly valid: Record<string, unknown>;
  readonly invalid: Record<string, unknown>;
  readonly keysLine: string;
}

const cases: readonly NestedCase[] = [
  {
    tool: "tapAny",
    schema: tapAnySchema,
    valid: { platform: "android", searchUntil: { duration: 500 } },
    invalid: { platform: "android", searchUntil: { bogus: 1 } },
    keysLine: "Allowed searchUntil keys: duration.",
  },
  {
    tool: "observe",
    schema: observeSchema,
    valid: { platform: "android", scope: { overview: true } },
    invalid: { platform: "android", scope: { overveiw: true } },
    keysLine: "Allowed scope keys: focus, region, overview.",
  },
  {
    tool: "identifyInteractions",
    schema: identifyInteractionsSchema,
    valid: { platform: "android", filter: { limit: 3 }, includeContext: { elementDetails: true } },
    invalid: { platform: "android", filter: { max: 3 } },
    keysLine: "Allowed filter keys: types, minConfidence, limit.",
  },
  {
    tool: "systemTray",
    schema: systemTraySchema,
    valid: { action: "find", notification: { title: "Hi" } },
    invalid: { action: "find", notification: { titel: "Hi" } },
    keysLine: "Allowed notification keys: title, body, appId, tapActionLabel.",
  },
  {
    tool: "setDeviceState",
    schema: setDeviceStateSchema,
    valid: { platform: "android", connectivity: { wifiEnabled: true } },
    invalid: { platform: "android", connectivity: { wifiEnabled: true, wifi: true } },
    keysLine: "Allowed connectivity keys: airplaneMode, wifiEnabled, bluetoothEnabled",
  },
  {
    tool: "videoRecording",
    schema: videoRecordingSchema,
    valid: { action: "start", resolution: { width: 720, height: 1280 } },
    invalid: { action: "start", resolution: { width: 720, height: 1280, depth: 8 } },
    keysLine: "Allowed resolution keys: width, height.",
  },
  {
    tool: "setUIState",
    schema: setUIStateSchema,
    valid: { fields: [{ selector: { text: "Name" }, value: "Ada" }] },
    invalid: { fields: [{ selector: { text: "Name" }, value: "Ada", val: "Ada" }] },
    keysLine: "Allowed fields[] keys: selector, value, selected.",
  },
  {
    tool: "portReverse",
    schema: portReverseSchema,
    valid: { action: "ensure", ports: [{ devicePort: 8080 }] },
    invalid: { action: "ensure", ports: [{ devicePort: 8080, port: 1 }] },
    keysLine: "Allowed ports[] keys: devicePort, hostPort.",
  },
  {
    tool: "postNotification",
    schema: postNotificationSchema,
    valid: { platform: "android", title: "t", body: "b", actions: [{ label: "A", actionId: "a" }] },
    invalid: {
      platform: "android",
      title: "t",
      body: "b",
      actions: [{ label: "A", actionId: "a", id: "a" }],
    },
    keysLine: "Allowed actions[] keys: label, actionId.",
  },
];

describe("unknown keys in nested option objects (#17738)", () => {
  test("tapOn searchUntil rejects an unknown key with the searchUntil keys and an example", () => {
    const input = { platform: "android", selector: { text: "OK" }, searchUntil: { bogus: 1 } };
    const message = messageFor("tapOn", tapOnSchema, input);
    expect(message).toContain('Unrecognized key: "bogus"');
    const hint = hintOf(message);
    expect(hint).toContain("Allowed searchUntil keys: duration.");
    expect(hint).toContain('"searchUntil":{"duration":');
    expect(hint.length).toBeLessThanOrEqual(MAX_HINT_CHARS);
  });

  test("tapOn searchUntil still accepts every documented shape", () => {
    const base = { platform: "android", selector: { text: "OK" } };
    expect(tapOnSchema.safeParse({ ...base, searchUntil: {} }).success).toBe(true);
    expect(tapOnSchema.safeParse({ ...base, searchUntil: { duration: 3000 } }).success).toBe(true);
  });

  for (const { tool, schema, valid, invalid, keysLine } of cases) {
    test(`${tool} accepts its documented nested keys and names them for an unknown one`, () => {
      expect(schema.safeParse(valid).success).toBe(true);
      const message = messageFor(tool, schema, invalid);
      // Valid apart from the unknown key, so only strictness can reject it.
      expect(message).toContain("Unrecognized key");
      const hint = hintOf(message);
      expect(hint).toContain(keysLine);
      expect(hint.length).toBeLessThanOrEqual(MAX_HINT_CHARS);
    });
  }

  test("audit scope and baseline reject unknown keys", () => {
    expect(auditScopeInput.safeParse({ container: { text: "List" } }).success).toBe(true);
    expect(auditScopeInput.safeParse({ container: { text: "List", id: "x" } }).success).toBe(false);
    expect(auditScopeInput.safeParse({ container: { text: "List" }, depth: 1 }).success).toBe(
      false,
    );
    expect(auditBaselineInput.safeParse({ name: "home", mode: "record" }).success).toBe(true);
    expect(auditBaselineInput.safeParse({ name: "home", mode: "record", x: 1 }).success).toBe(
      false,
    );
  });

  test("observe scope.focus keeps ignoring extras on the legacy anchor", () => {
    const input = { platform: "android", scope: { focus: { text: "Inbox", extra: 1 } } };
    expect(observeSchema.safeParse(input).success).toBe(true);
  });
});
