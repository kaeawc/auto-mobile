import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import Ajv from "ajv";
import { dump } from "js-yaml";
import path from "path";
import type { FileSystem } from "../../src/utils/filesystem/DefaultFileSystem";
import {
  PlanSchemaValidator,
  resetPlanSchemaCacheForTests,
} from "../../src/utils/plan/PlanSchemaValidator";

describe("PlanSchemaValidator", () => {
  let validator: PlanSchemaValidator;

  beforeAll(async () => {
    validator = new PlanSchemaValidator();
    await validator.loadSchema();
    // `validateYaml` compiles the ajv schema (walking every $ref) on its
    // first call and caches the result. Warm that compile here, in setup,
    // rather than letting it land inside whichever `it()` happens to run
    // first — the 100ms/test CI budget
    // (`scripts/validate-bun-test-timings.sh`) measures per-test time, and a
    // cold compile inside a test body was clocked at 106.32ms in CI (#6244
    // related run).
    validator.validateYaml("name: warmup\nsteps:\n  - tool: observe\n");
  });

  it.each([
    ["valid", { name: "Plan", steps: [{ tool: "observe" }] }],
    ["additional property", { name: "Plan", steps: [{ tool: "observe" }], unknown: true }],
    ["required", { steps: [{ tool: "observe" }] }],
    ["enum", { name: "Plan", platform: "other", steps: [{ tool: "observe" }] }],
    ["type", { name: 42, steps: [{ tool: "observe" }] }],
    ["root type", []],
    ["minimum items", { name: "Plan", steps: [] }],
    ["minimum length", { name: "", steps: [{ tool: "observe" }] }],
    ["default message", { name: "Plan", mcpVersion: "bad", steps: [{ tool: "observe" }] }],
    ["nested location", { name: "Plan", metadata: { version: 42 }, steps: [{ tool: "observe" }] }],
    ["array location", { name: "Plan", secretParameters: [""], steps: [{ tool: "observe" }] }],
  ])("preserves the complete validation result for %s", (_name, plan) => {
    expect(validator.validateYaml(dump(plan))).toMatchSnapshot();
  });

  it.each([
    [
      "plural items",
      { properties: { steps: { type: "array", minItems: 2 } } },
      { steps: [] },
      { field: "steps", message: "Must have at least 2 items", line: 1, column: 1 },
    ],
    [
      "plural characters",
      { properties: { name: { type: "string", minLength: 2 } } },
      { name: "" },
      { field: "name", message: "Must be at least 2 characters long", line: 1, column: 1 },
    ],
    [
      "missing AJV message",
      { properties: { mcpVersion: { type: "string", pattern: "^valid$" } } },
      { mcpVersion: "invalid" },
      { field: "mcpVersion", message: "Validation error", line: 1, column: 1 },
    ],
  ])("preserves the full result for %s", (_name, schema, plan, expectedError) => {
    const original = Reflect.get(validator, "validateFn");
    const ajv = new Ajv({ allErrors: true, verbose: true, messages: false });
    Reflect.set(validator, "validateFn", ajv.compile({ type: "object", ...schema }));
    try {
      expect(validator.validateYaml(dump(plan))).toEqual({ valid: false, errors: [expectedError] });
    } finally {
      Reflect.set(validator, "validateFn", original);
    }
  });

  it.each(["inline", "params"])("enforces the normalized clock instant window (%s)", (form) => {
    for (const [instant, valid] of [
      ["1900-01-01T00:00:00Z", false],
      ["2200-01-01T00:00:00Z", false],
      ["2000-01-01T00:00:00+01:00", false],
      ["1999-12-31T23:00:00-01:00", true],
      ["2000-01-01T00:00:00Z", true],
      ["2100-01-01T00:00:00Z", true],
      ["2100-01-01T00:00:01Z", false],
      ["2099-12-31T23:59:59-01:00", false],
      ["2100-01-01T01:00:00+01:00", true],
    ] as const) {
      const clock = { mode: "set", instant };
      const fields = form === "inline" ? { clock } : { params: { clock } };
      const result = validator.validateYaml(
        JSON.stringify({ name: "clock-window", steps: [{ tool: "setDeviceState", ...fields }] }),
      );
      expect(result.valid).toBe(valid);
      if (!valid) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            field: `steps[0].${form === "params" ? "params." : ""}clock.instant`,
            message: expect.stringContaining("2000-01-01"),
          }),
        );
      }
    }
  });

  it.each(["inline", "params"])(
    "preserves submillisecond instant-window precision (%s)",
    (form) => {
      for (const [instant, valid] of [
        ["2100-01-01T00:00:00.0001Z", false],
        ["2100-01-01T01:00:00.0001+01:00", false],
        ["1999-12-31T23:00:00.0001-01:00", true],
        ["2030-01-01T00:00:00.1234567890Z", true],
        ["2100-01-01T00:00:00.0000000000Z", true],
        ["2100-01-01T00:00:00.0000000000001Z", false],
        ["2000-01-01T00:00:00.0000000000001Z", true],
        ["1999-12-31T23:59:59.9999999999Z", false],
      ] as const) {
        const clock = { mode: "set", instant };
        const fields = form === "inline" ? { clock } : { params: { clock } };
        expect(
          validator.validateYaml(
            JSON.stringify({
              name: "clock-fraction",
              steps: [{ tool: "setDeviceState", ...fields }],
            }),
          ).valid,
        ).toBe(valid);
      }
    },
  );

  it("clock window checks honor params overrides in both directions", () => {
    for (const [inline, params, valid] of [
      ["1900-01-01T00:00:00Z", "2030-01-01T00:00:00Z", true],
      ["2030-01-01T00:00:00Z", "2200-01-01T00:00:00Z", false],
    ] as const) {
      expect(
        validator.validateYaml(
          JSON.stringify({
            name: "clock-override-window",
            steps: [
              {
                tool: "setDeviceState",
                clock: { mode: "set", instant: inline },
                params: { clock: { mode: "set", instant: params } },
              },
            ],
          }),
        ).valid,
      ).toBe(valid);
    }
  });

  describe("Valid YAML", () => {
    it("validates the effective params clock when it overrides an invalid inline clock", () => {
      const result = validator.validateYaml(
        JSON.stringify({
          name: "clock-override",
          steps: [
            {
              tool: "setDeviceState",
              clock: { mode: "invalid" },
              params: { clock: { mode: "reset" } },
            },
          ],
        }),
      );
      expect(result.valid).toBe(true);
    });

    it.each(["inline", "params"])("validates clock-only setDeviceState steps (%s)", (form) => {
      for (const clock of [
        { mode: "set", instant: "2030-01-01T00:00:00Z" },
        { mode: "advance", byMs: 60_000 },
        { mode: "reset" },
      ]) {
        const fields = form === "inline" ? { clock } : { params: { clock } };
        const result = validator.validateYaml(
          JSON.stringify({ name: "clock", steps: [{ tool: "setDeviceState", ...fields }] }),
        );
        expect(result.valid).toBe(true);
      }
    });

    it.each(["inline", "params"])(
      "rejects invalid clock input in setDeviceState steps (%s)",
      (form) => {
        for (const clock of [
          { mode: "set" },
          { mode: "set", instant: "invalid" },
          { mode: "advance", byMs: 999 },
          { mode: "advance", byMs: 1000.5 },
          { mode: "advance", byMs: 315360000001 },
          { mode: "reset", byMs: 1000 },
          { mode: "unknown" },
        ]) {
          const fields = form === "inline" ? { clock } : { params: { clock } };
          const result = validator.validateYaml(
            JSON.stringify({ name: "clock", steps: [{ tool: "setDeviceState", ...fields }] }),
          );
          expect(result.valid).toBe(false);
        }
      },
    );

    it("should validate a minimal valid plan", () => {
      const yaml = `
name: test-plan
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("should validate a complete plan with all fields", () => {
      const yaml = `
name: complete-plan
description: A complete test plan
devices:
  - A
  - B
steps:
  - tool: launchApp
    params:
      appId: com.example.app
    device: A
    label: Launch app on device A
  - tool: observe
    params:
      device: A
metadata:
  createdAt: "2026-01-08T00:00:00Z"
  version: "1.0.0"
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should validate plan with YAML anchors", () => {
      const yaml = `
name: anchors-test
description: Test with YAML anchors
steps:
  - tool: launchApp
    params: &launch-params
      appId: com.example.app
      coldBoot: false
    label: First launch
  - tool: launchApp
    params:
      <<: *launch-params
      coldBoot: true
    label: Second launch with cold boot
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should validate setAppPermissions step with inline appId and permissions", () => {
      const yaml = `
name: grant-plan
steps:
  - tool: setAppPermissions
    appId: com.example.app
    permissions:
      - android.permission.POST_NOTIFICATIONS
    label: Grant notifications
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    // #6090: the plan schema must encode the same offline+override rule as the
    // live Zod refinement, so a plan that PlanSchemaValidator accepts also passes
    // at execution — and never false-rejects a valid cancel-reset.
    it("should accept a valid setDeviceState networkCondition (offline)", () => {
      const yaml = `
name: net-offline
steps:
  - tool: setDeviceState
    networkCondition:
      profile: offline
`;
      expect(validator.validateYaml(yaml).valid).toBe(true);
    });

    it("should accept an offline networkCondition override when cancel/reset is set", () => {
      const cancel = `
name: net-offline-cancel
steps:
  - tool: setDeviceState
    networkCondition:
      profile: offline
      delayMs: 500
      cancel: true
`;
      expect(validator.validateYaml(cancel).valid).toBe(true);
      const reset = `
name: net-offline-reset
steps:
  - tool: setDeviceState
    networkCondition:
      profile: offline
      delayMs: 500
      reset: true
`;
      expect(validator.validateYaml(reset).valid).toBe(true);
    });

    it("should accept `none` with neutral (zero) overrides as a reset", () => {
      const yaml = `
name: net-none-neutral
steps:
  - tool: setDeviceState
    networkCondition:
      profile: none
      delayMs: 0
      downloadKbps: 0
`;
      expect(validator.validateYaml(yaml).valid).toBe(true);
    });

    it("should accept the networkCondition TTL maximum (#6178 item 2)", () => {
      // Mirrors MAX_NETWORK_CONDITION_TTL_SECONDS (src/features/utility/DeviceState.ts).
      const yaml = `
name: net-ttl-max
steps:
  - tool: setDeviceState
    networkCondition:
      profile: veryBad
      expiresInSeconds: 2147483
`;
      expect(validator.validateYaml(yaml).valid).toBe(true);
    });

    it("should accept an inline networkCondition that params.networkCondition overrides (#6090 review)", () => {
      // PlanNormalizer gives params precedence, so at execution this step receives
      // ONLY the valid params reset — the inline `{delayMs:0}` is discarded. Schema
      // validation must not false-reject the discarded inline form.
      const neutral = `
name: net-inline-overridden-neutral
steps:
  - tool: setDeviceState
    networkCondition:
      delayMs: 0
    params:
      networkCondition:
        profile: none
`;
      expect(validator.validateYaml(neutral).valid).toBe(true);
      // Same for an inline offline+override overridden by a valid params reset.
      const offline = `
name: net-inline-overridden-offline
steps:
  - tool: setDeviceState
    networkCondition:
      profile: offline
      delayMs: 500
    params:
      networkCondition:
        cancel: true
`;
      expect(validator.validateYaml(offline).valid).toBe(true);
    });

    it("should accept an inline doNotDisturb that params.doNotDisturb overrides (#6112)", () => {
      // PlanNormalizer gives params precedence, so at execution this step receives
      // ONLY the valid params form — the malformed inline `{}` (neither `enabled`
      // nor `mode`) is discarded. Schema validation must not false-reject it.
      const yaml = `
name: dnd-inline-overridden
steps:
  - tool: setDeviceState
    doNotDisturb: {}
    params:
      doNotDisturb:
        mode: priority
`;
      expect(validator.validateYaml(yaml).valid).toBe(true);
    });

    it("should accept an inline biometrics that params.biometrics overrides (#6112)", () => {
      // Same duality: params.biometrics discards the malformed inline enrollment
      // value at normalization, so schema validation must not false-reject it.
      const yaml = `
name: biometrics-inline-overridden
steps:
  - tool: setDeviceState
    biometrics:
      enrollment: sometimes
    params:
      biometrics:
        enrollment: enrolled
`;
      expect(validator.validateYaml(yaml).valid).toBe(true);
    });

    it("should validate cross-platform permission / appop steps in sequence", () => {
      const yaml = `
name: grant-explicit
steps:
  - tool: setNotificationPolicy
    appId: com.example.app
    policyAccess: false
  - tool: setAppPermissions
    appId: com.example.app
    scheduleExactAlarm: deny
  - tool: setAppPermissions
    appId: com.example.app
    permissions:
      - android.permission.POST_NOTIFICATIONS
  - tool: setNotificationPolicy
    appId: com.example.app
    policyAccess: true
  - tool: setAppPermissions
    appId: com.example.app
    scheduleExactAlarm: allow
  - tool: setAppPermissions
    appId: com.example.app
    notificationsEnabled: false
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should validate reusable app permission set/query steps", () => {
      const yaml = `
name: reusable-permissions
steps:
  - tool: setAppPermissions
    appId: com.example.app
    permissions:
      - android.permission.POST_NOTIFICATIONS
    notificationPolicyAccess: true
    scheduleExactAlarm: allow
  - tool: getAppPermissions
    appId: com.example.app
    permissions:
      - android.permission.POST_NOTIFICATIONS
  - tool: setAppPermissions
    params:
      appId: com.example.app
      action: revoke
      permissions:
        - camera
  - tool: getAppPermissions
    params:
      appId: com.example.app
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should validate device state and notification policy steps", () => {
      const yaml = `
name: state-and-policy
steps:
  - tool: getDeviceState
    include:
      - doNotDisturb
  - tool: setDeviceState
    doNotDisturb:
      mode: priority
  - tool: getNotificationPolicy
    appId: com.example.app
  - tool: setNotificationPolicy
    appId: com.example.app
    policyAccess: true
  - tool: setDeviceState
    params:
      doNotDisturb:
        enabled: false
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should validate biometric device state steps", () => {
      const yaml = `
name: biometric-state
steps:
  - tool: getDeviceState
    include:
      - biometrics
  - tool: getDeviceState
    include:
      - doNotDisturb
      - biometrics
  - tool: setDeviceState
    biometrics:
      enrollment: enrolled
  - tool: setDeviceState
    params:
      biometrics:
        enrollment: not_enrolled
  - tool: setDeviceState
    params:
      doNotDisturb:
        enabled: true
      biometrics:
        enrollment: enrolled
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should validate networkCondition device state steps (#6012)", () => {
      const yaml = `
name: network-condition-state
steps:
  - tool: getDeviceState
    include:
      - networkCondition
  - tool: setDeviceState
    networkCondition:
      profile: "3g"
  - tool: setDeviceState
    networkCondition:
      cancel: true
  - tool: setDeviceState
    params:
      networkCondition:
        profile: offline
  - tool: setDeviceState
    networkCondition:
      delayMs: 400
      downloadKbps: 500
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a networkCondition step with falsey-only cancel/reset (#6012 review)", () => {
      const yaml = `
name: network-condition-false-cancel
steps:
  - tool: setDeviceState
    networkCondition:
      cancel: false
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject offline + a shaping override with no cancel/reset (#6090)", () => {
      const yaml = `
name: network-condition-offline-override
steps:
  - tool: setDeviceState
    networkCondition:
      profile: offline
      delayMs: 500
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should still reject a standalone inline neutral-only networkCondition (no params override) (#6090)", () => {
      // Guards against weakening the standalone-inline validation: with no
      // overriding params.networkCondition, a bare zero override is a no-op the
      // schema must still reject (matching the runtime `empty`).
      const yaml = `
name: network-condition-inline-neutral
steps:
  - tool: setDeviceState
    networkCondition:
      delayMs: 0
`;
      expect(validator.validateYaml(yaml).valid).toBe(false);
    });

    it("should reject a networkCondition TTL above the maximum (#6178 item 2)", () => {
      // Mirrors MAX_NETWORK_CONDITION_TTL_SECONDS (src/features/utility/DeviceState.ts):
      // out-of-range values must be rejected at plan validation, not only at
      // execution (issue #6178, from the #6113 review).
      const yaml = `
name: net-ttl-above-max
steps:
  - tool: setDeviceState
    networkCondition:
      profile: veryBad
      expiresInSeconds: 2147484
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should validate iOS simulator permissions through cross-platform permission tools", () => {
      const yaml = `
name: ios-permissions
steps:
  - tool: setAppPermissions
    appId: com.example.app
    action: grant
    permissions:
      - camera
  - tool: setAppPermissions
    appId: com.example.app
    action: revoke
    permissions:
      - microphone
  - tool: getAppPermissions
    appId: com.example.app
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should validate plan with merge keys", () => {
      const yaml = `
name: merge-keys-test
devices:
  - A
  - B
steps:
  - tool: observe
    params: &observe-base
      includeScreenshot: true
      includeHierarchy: true
      device: A
  - tool: observe
    params:
      <<: *observe-base
      device: B
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should validate dragAndDrop with top-level selectors and param overrides", () => {
      const yaml = `
name: drag-and-drop
steps:
  - tool: dragAndDrop
    source:
      text: Source
    target:
      text: Target
    params:
      dragDurationMs: 800
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("validates a dragAndDrop endpoint with a nested container and selectionStrategy (#10124)", () => {
      const yaml = `
name: drag-container
steps:
  - tool: dragAndDrop
    source:
      text: "Item 1"
      selectionStrategy: unique
      container:
        elementId: "com.example:id/list_a"
        container:
          text: "Lists"
          index: 1
    target:
      text: "Item 2"
    dragDurationMs: 2000
`;
      expect(validator.validateYaml(yaml).valid).toBe(true);
    });

    it("rejects an unknown dragAndDrop endpoint key and a malformed container (#10124)", () => {
      for (const endpoint of [
        "{ text: a, bogus: 1 }",
        "{ text: a, container: { index: 1 } }",
        "{ text: a, container: { elementId: x, text: y } }",
        "{ text: a, selectionStrategy: sometimes }",
      ]) {
        const yaml = `
name: drag-bad
steps:
  - tool: dragAndDrop
    source: ${endpoint}
    target: { text: b }
`;
        expect(validator.validateYaml(yaml).valid).toBe(false);
      }
    });

    it.each(["inline", "params"])(
      "validates a highlight step selected by elementId (%s) (#10124)",
      (form) => {
        const yaml =
          form === "inline"
            ? `
name: highlight-login
steps:
  - tool: highlight
    elementId: com.example:id/btn_login
`
            : `
name: highlight-login
steps:
  - tool: highlight
    params:
      elementId: com.example:id/btn_login
      description: Login button
`;
        expect(validator.validateYaml(yaml).valid).toBe(true);
      },
    );

    it.each(["inline", "params"])(
      "rejects a highlight shape the live tool would reject (%s) (#10124)",
      (form) => {
        const shape = "{ type: box, bounds: { x: 1, y: 2, width: 3, height: 4 } }";
        const yaml =
          form === "inline"
            ? `
name: highlight-box
steps:
  - tool: highlight
    shape: ${shape}
`
            : `
name: highlight-box
steps:
  - tool: highlight
    params:
      shape: ${shape}
`;
        expect(validator.validateYaml(yaml).valid).toBe(false);
      },
    );

    it("validates a circle highlight and rejects a style property the tool does not have (#10124)", () => {
      const circle = "{ type: circle, bounds: { x: 1, y: 2, width: 3, height: 4 } }";
      const valid = `
name: highlight-circle
steps:
  - tool: highlight
    shape: ${circle}
`;
      expect(validator.validateYaml(valid).valid).toBe(true);
      const styled = `
name: highlight-circle
steps:
  - tool: highlight
    shape: { type: circle, bounds: { x: 1, y: 2, width: 3, height: 4 }, style: { strokeWidth: 2 } }
`;
      expect(validator.validateYaml(styled).valid).toBe(false);
    });

    it("validates setDeviceState with only connectivity, inline and under params (#10125)", () => {
      const inline = `
name: airplane-inline
steps:
  - tool: setDeviceState
    connectivity:
      airplaneMode: true
`;
      const viaParams = `
name: airplane-params
steps:
  - tool: setDeviceState
    params:
      connectivity:
        airplaneMode: true
`;
      expect(validator.validateYaml(inline).valid).toBe(true);
      expect(validator.validateYaml(viaParams).valid).toBe(true);
    });

    it("validates setDeviceState with only location, inline and under params (#10125)", () => {
      const inline = `
name: location-inline
steps:
  - tool: setDeviceState
    location:
      mode: static
      latitude: 37.77
      longitude: -122.42
`;
      const viaParams = `
name: location-params
steps:
  - tool: setDeviceState
    params:
      location:
        mode: stop
`;
      expect(validator.validateYaml(inline).valid).toBe(true);
      expect(validator.validateYaml(viaParams).valid).toBe(true);
    });

    it.each(["inline", "params"])(
      "rejects malformed connectivity and location (%s) (#10125)",
      (form) => {
        for (const field of [
          "connectivity: { airplaneMode: maybe }",
          "connectivity: {}",
          "location: { mode: static, latitude: 91, longitude: 0 }",
          "location: { mode: teleport }",
        ]) {
          const yaml =
            form === "inline"
              ? `
name: bad-device-state
steps:
  - tool: setDeviceState
    ${field}
`
              : `
name: bad-device-state
steps:
  - tool: setDeviceState
    params:
      ${field}
`;
          expect(validator.validateYaml(yaml).valid).toBe(false);
        }
      },
    );

    it("still requires at least one device state field (#10125)", () => {
      const yaml = `
name: empty-device-state
steps:
  - tool: setDeviceState
    params: {}
`;
      expect(validator.validateYaml(yaml).valid).toBe(false);
    });
  });

  describe("Invalid YAML syntax", () => {
    it("should report YAML parse errors with line/column", () => {
      const yaml = `
name: test
steps: [invalid
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.errors![0].field).toBe("root");
      expect(result.errors![0].message).toContain("YAML parsing failed");
      expect(result.errors![0].line).toBeDefined();
      expect(result.errors![0].column).toBeDefined();
    });

    it("should handle malformed YAML with colons", () => {
      const yaml = `
name test plan
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors![0].message).toContain("YAML parsing failed");
    });
  });

  describe("Schema validation errors", () => {
    it("should report missing required 'name' field", () => {
      const yaml = `
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      const nameError = result.errors!.find((e) => e.message.includes("name"));
      expect(nameError).toBeDefined();
      expect(nameError!.message).toContain("Missing required property 'name'");
    });

    it("should report missing required 'steps' field", () => {
      const yaml = `
name: test-plan
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      const stepsError = result.errors!.find((e) => e.message.includes("steps"));
      expect(stepsError).toBeDefined();
      expect(stepsError!.message).toContain("Missing required property 'steps'");
    });

    it("should report empty name", () => {
      const yaml = `
name: ""
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field.includes("name"))).toBe(true);
    });

    it("should report empty steps array", () => {
      const yaml = `
name: test-plan
steps: []
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.message.includes("at least 1"))).toBe(true);
    });

    it("should report missing tool in step", () => {
      const yaml = `
name: test-plan
steps:
  - params:
      foo: bar
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      const toolError = result.errors!.find((e) => e.message.includes("tool"));
      expect(toolError).toBeDefined();
      expect(toolError!.message).toContain("Missing required property 'tool'");
    });

    it("should report empty tool name", () => {
      const yaml = `
name: test-plan
steps:
  - tool: ""
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field.includes("tool"))).toBe(true);
    });

    it("should report wrong type for steps", () => {
      const yaml = `
name: test-plan
steps: "not an array"
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(
        result.errors!.some((e) => e.field.includes("steps") && e.message.includes("type")),
      ).toBe(true);
    });

    it("should report invalid mcpVersion format", () => {
      const yaml = `
name: test-plan
mcpVersion: invalid-version
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field.includes("mcpVersion"))).toBe(true);
    });

    it("should report duplicate devices", () => {
      const yaml = `
name: test-plan
devices:
  - A
  - A
steps:
  - tool: observe
    params:
      device: A
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field.includes("devices"))).toBe(true);
    });

    it("should report empty device label", () => {
      const yaml = `
name: test-plan
devices:
  - ""
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field.includes("devices"))).toBe(true);
    });

    it("should reject a whitespace-only device label", () => {
      // A whitespace-only label like " " satisfies minLength:1 but is not a
      // real device label -- the pattern requiring a non-whitespace
      // character catches it at the schema level too (#6215 review).
      const yaml = `
name: test-plan
devices:
  - " "
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject a non-coordination step's params.device when it is not a string", () => {
      // For a tool with no tool-specific params schema (e.g. tapOn), an
      // invalid inline device is skipped once params declares device (params
      // wins at normalization), but nothing previously validated params.device
      // itself -- a plan with params.device: 456 would normalize to an
      // invalid device and only fail at the daemon (#6215 review).
      const yaml = `
name: tapon-invalid-params-device-number
devices:
  - A
steps:
  - tool: tapOn
    device: 123
    params:
      device: 456
      text: hi
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject a non-coordination step's params.device when it is whitespace-only", () => {
      const yaml = `
name: tapon-blank-params-device
devices:
  - A
steps:
  - tool: tapOn
    params:
      device: " "
      text: hi
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a valid params.device overriding an invalid inline device", () => {
      const yaml = `
name: tapon-valid-params-device
devices:
  - A
steps:
  - tool: tapOn
    device: 123
    params:
      device: A
      text: hi
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a barrier step's params.device when it is whitespace-only", () => {
      // Dovetails with fp0eM: params.device: " " passed the
      // criticalSectionParams/barrierParams schema (just type: string)
      // before the generic non-blank constraint was added; it becomes
      // step.device = " " after normalization, which validateDeviceLabelsPresent
      // rejects at runtime (#6215 review).
      const yaml = `
name: barrier-blank-params-device
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: " "
      lock: sync1
      deviceCount: 2
  - tool: barrier
    params:
      device: B
      lock: sync1
      deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject an authored '__lockNamespace' on a barrier step's params", () => {
      // __lockNamespace is a reserved field injected internally by
      // PlanExecutor at runtime to scope a plan's lock state. If two
      // participants authored different truthy values for the same lock,
      // every per-lock feasibility check would pass yet they'd wait in
      // separate namespaced barriers at runtime until timeout (#6215
      // review).
      const yaml = `
name: barrier-authored-lock-namespace
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: A
      lock: sync1
      deviceCount: 2
      __lockNamespace: one
  - tool: barrier
    params:
      device: B
      lock: sync1
      deviceCount: 2
      __lockNamespace: two
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject an authored inline '__lockNamespace' on a barrier step", () => {
      const yaml = `
name: barrier-authored-lock-namespace-inline
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync1
    deviceCount: 2
    __lockNamespace: one
  - tool: barrier
    device: B
    lock: sync1
    deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject an authored '__lockNamespace' on a criticalSection step's params", () => {
      const yaml = `
name: critical-section-authored-lock-namespace
devices:
  - A
steps:
  - tool: criticalSection
    params:
      device: A
      lock: sync1
      deviceCount: 1
      __lockNamespace: one
      steps:
        - tool: observe
          params:
            device: A
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a normal barrier plan that does not author '__lockNamespace'", () => {
      const yaml = `
name: barrier-normal-no-lock-namespace
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: A
      lock: sync1
      deviceCount: 2
  - tool: barrier
    params:
      device: B
      lock: sync1
      deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a barrier timeout exceeding setTimeout's usable range", () => {
      // barrierTools.ts declares timeout as z.number().int().positive(), and
      // CriticalSectionCoordinator.waitAtBarrier passes it straight to
      // production setTimeout -- Node/Bun clamp any delay >= 2^31
      // (2147483648) to 1ms instead of honoring it, so a value at or beyond
      // that range passes this schema's simple exclusiveMinimum check yet
      // times out almost instantly at runtime (#6215 review).
      const yaml = `
name: barrier-timeout-over-cap
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: A
      lock: sync1
      deviceCount: 2
      timeout: 2147483648
  - tool: barrier
    params:
      device: B
      lock: sync1
      deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a barrier timeout at exactly setTimeout's usable range", () => {
      const yaml = `
name: barrier-timeout-at-cap
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: A
      lock: sync1
      deviceCount: 2
      timeout: 2147483647
  - tool: barrier
    params:
      device: B
      lock: sync1
      deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a criticalSection timeout exceeding setTimeout's usable range", () => {
      // criticalSectionTools.ts has the identical z.number().int().positive()
      // contract as barrier, so the same cap applies.
      const yaml = `
name: critical-section-timeout-over-cap
devices:
  - A
steps:
  - tool: criticalSection
    params:
      device: A
      lock: sync1
      deviceCount: 1
      timeout: 2147483648
      steps:
        - tool: observe
          params:
            device: A
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a criticalSection timeout at exactly setTimeout's usable range", () => {
      const yaml = `
name: critical-section-timeout-at-cap
devices:
  - A
steps:
  - tool: criticalSection
    params:
      device: A
      lock: sync1
      deviceCount: 1
      timeout: 2147483647
      steps:
        - tool: observe
          params:
            device: A
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should provide line numbers for field errors when possible", () => {
      const yaml = `
name: test-plan
steps:
  - tool: observe
invalidField: value
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      const error = result.errors!.find(
        (e) => e.message.includes("invalidField") || e.message.includes("Unknown property"),
      );
      if (error) {
        // Line number may or may not be available depending on the error type
        // Just verify the error structure is correct
        expect(error.field).toBeDefined();
        expect(error.message).toBeDefined();
      }
    });

    it("should reject setAppPermissions with empty permissions array", () => {
      const yaml = `
name: bad-grant
steps:
  - tool: setAppPermissions
    appId: com.example.app
    permissions: []
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject setAppPermissions with no operation", () => {
      const yaml = `
name: bad-set-permissions
steps:
  - tool: setAppPermissions
    appId: com.example.app
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject inline Android reset with a userId", () => {
      const yaml = `
name: invalid-inline-reset-user
steps:
  - tool: setAppPermissions
    appId: com.example.app
    action: reset
    permissions:
      - all
    userId: 10
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject nested Android reset with a userId", () => {
      const yaml = `
name: invalid-nested-reset-user
steps:
  - tool: setAppPermissions
    params:
      appId: com.example.app
      action: reset
      permissions:
        - all
      userId: 10
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject inline reset without permissions", () => {
      const yaml = `
name: invalid-inline-reset-without-permissions
steps:
  - tool: setAppPermissions
    appId: com.example.app
    action: reset
    notificationsEnabled: false
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject nested reset without permissions", () => {
      const yaml = `
name: invalid-nested-reset-without-permissions
steps:
  - tool: setAppPermissions
    params:
      appId: com.example.app
      action: reset
      notificationsEnabled: false
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject inline Android reset without permissions=['all']", () => {
      const yaml = `
name: invalid-inline-android-reset-scope
steps:
  - tool: setAppPermissions
    appId: com.example.app
    action: reset
    platform: android
    permissions:
      - camera
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject nested Android reset without permissions=['all']", () => {
      const yaml = `
name: invalid-nested-android-reset-scope
steps:
  - tool: setAppPermissions
    params:
      appId: com.example.app
      action: reset
      platform: android
      permissions:
        - camera
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject an unknown biometric enrollment value", () => {
      const yaml = `
name: bad-biometric-enrollment
steps:
  - tool: setDeviceState
    biometrics:
      enrollment: sometimes
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should still reject a standalone inline biometrics with no params override (#6112)", () => {
      // Guards against weakening the standalone-inline validation: with no
      // overriding params.biometrics, a malformed inline enrollment value must
      // still be rejected.
      const yaml = `
name: bad-biometric-enrollment-standalone
steps:
  - tool: setDeviceState
    biometrics:
      enrollment: sometimes
    params:
      networkCondition:
        cancel: true
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject a standalone inline doNotDisturb with neither enabled nor mode (#6112)", () => {
      const yaml = `
name: bad-dnd-standalone
steps:
  - tool: setDeviceState
    doNotDisturb: {}
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should still reject a standalone inline doNotDisturb when an unrelated params field is set (#6112)", () => {
      // A present `params` without `params.doNotDisturb` must not gate off the
      // inline doNotDisturb validation.
      const yaml = `
name: bad-dnd-standalone-unrelated-params
steps:
  - tool: setDeviceState
    doNotDisturb: {}
    params:
      biometrics:
        enrollment: enrolled
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject an unknown getDeviceState include field", () => {
      const yaml = `
name: bad-include
steps:
  - tool: getDeviceState
    include:
      - notAThing
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject setDeviceState with no state", () => {
      const yaml = `
name: bad-set-device-state
steps:
  - tool: setDeviceState
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });
  });

  describe("Complex nested validation", () => {
    it("should validate critical section parameters", () => {
      const yaml = `
name: critical-section-test
devices:
  - A
  - B
steps:
  - tool: criticalSection
    params:
      lock: sync-point
      deviceCount: 2
      steps:
        - tool: tapOn
          params:
            device: A
            text: Button
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should accept steps with tool-specific parameters", () => {
      // Note: most tool-specific parameter validation happens at runtime by the
      // tool handler, not by the JSON Schema. The schema only validates the
      // basic step structure for the general case.
      const yaml = `
name: generic-tool-test
steps:
  - tool: tapOn
    params:
      text: Login
      customField: anything
`;
      const result = validator.validateYaml(yaml);
      // This is valid from a schema perspective - tapOn params are validated at runtime
      expect(result.valid).toBe(true);
    });

    it("should reject a criticalSection step missing required params (schema-level parity with barrier)", () => {
      // Unlike most tools, criticalSection/barrier ARE validated at the schema
      // level (parity fix #6175): missing 'deviceCount'/'steps' surfaces here
      // instead of only at a runtime coordination timeout.
      const yaml = `
name: critical-section-test
steps:
  - tool: criticalSection
    params:
      lock: sync-point
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should validate barrier parameters", () => {
      const yaml = `
name: barrier-test
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: A
      lock: sync-point
      deviceCount: 2
  - tool: barrier
    params:
      device: B
      lock: sync-point
      deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a barrier step missing required params", () => {
      const yaml = `
name: barrier-missing-devicecount
steps:
  - tool: barrier
    params:
      lock: sync-point
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a barrier step with INLINE coordination params (no nested params object)", () => {
      // Plans may place lock/deviceCount/device directly on the step, the
      // same inline-vs-params shape criticalSection (and most other tools)
      // accept -- PlanNormalizer merges inline fields into params before
      // execution (#6215 review).
      const yaml = `
name: barrier-inline-test
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync-point
    deviceCount: 2
  - tool: barrier
    device: B
    lock: sync-point
    deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should accept a barrier step with coordination fields SPLIT across inline and params", () => {
      // PlanNormalizer merges inline fields and params together before
      // execution, so a field counts as present wherever it appears -- lock
      // inline + deviceCount in params must validate (#6215 review).
      const yaml = `
name: barrier-split-fields-test
devices:
  - A
steps:
  - tool: barrier
    lock: sync-point
    params:
      device: A
      deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a barrier step missing deviceCount from BOTH inline and params", () => {
      const yaml = `
name: barrier-split-fields-missing-devicecount
devices:
  - A
steps:
  - tool: barrier
    lock: sync-point
    params:
      device: A
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a criticalSection step with INLINE coordination params", () => {
      const yaml = `
name: critical-section-inline-test
devices:
  - A
steps:
  - tool: criticalSection
    lock: sync-point
    deviceCount: 1
    steps:
      - tool: tapOn
        params:
          device: A
          text: Button
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a barrier step with a zero timeout", () => {
      const yaml = `
name: barrier-zero-timeout
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: A
      lock: sync-point
      deviceCount: 2
      timeout: 0
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject a barrier step with a malformed platform value", () => {
      // addDeviceTargetingToSchema restricts platform to android/ios at
      // execution; the authoring schema must reject an invalid value too,
      // instead of only failing at execution (#6215 review).
      const yaml = `
name: barrier-malformed-platform
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: A
      lock: sync-point
      deviceCount: 2
      platform: windows
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a barrier step with a valid platform value", () => {
      const yaml = `
name: barrier-valid-platform
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: A
      lock: sync-point
      deviceCount: 2
      platform: android
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a criticalSection step with a malformed platform value", () => {
      const yaml = `
name: critical-section-malformed-platform
devices:
  - A
steps:
  - tool: criticalSection
    params:
      device: A
      lock: sync-point
      deviceCount: 1
      platform: windows
      steps:
        - tool: tapOn
          params:
            device: A
            text: Button
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a criticalSection sub-step with a discarded invalid inline device overridden by a valid params.device", () => {
      // PlanNormalizer.normalizeSteps merges params over inline fields for
      // EVERY step, not just the outer criticalSection/barrier step -- a
      // nested sub-step is itself validated as a planStep (via the
      // criticalSectionParams.steps $ref), so this precedence must be
      // honored there too, or a discarded, invalid inline device would
      // false-reject an otherwise-valid plan (#6215 review).
      const yaml = `
name: critical-section-substep-device-override
devices:
  - A
steps:
  - tool: criticalSection
    params:
      device: A
      lock: sync-point
      deviceCount: 1
      steps:
        - tool: tapOn
          device: 123
          params:
            device: A
            text: Button
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a criticalSection sub-step with an invalid inline device when params does not override it", () => {
      const yaml = `
name: critical-section-substep-invalid-device
devices:
  - A
steps:
  - tool: criticalSection
    params:
      device: A
      lock: sync-point
      deviceCount: 1
      steps:
        - tool: tapOn
          device: 123
          params:
            text: Button
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject an invalid inline device when params is null (not an object)", () => {
      // JSON Schema's "required" keyword vacuously passes against a
      // non-object value, so a naive "params has device" guard would treat
      // params: null as if it declared 'device', wrongly skipping the
      // inline check. The guard must require params to be an object before
      // trusting its presence (#6215 review).
      const yaml = `
name: tapon-null-params-invalid-device
devices:
  - A
steps:
  - tool: tapOn
    device: 123
    params: null
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a valid inline device when params is null (not an object)", () => {
      const yaml = `
name: tapon-null-params-valid-device
devices:
  - A
steps:
  - tool: tapOn
    device: A
    params: null
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should accept an inline barrier with params: null and valid inline lock/deviceCount/device", () => {
      // PlanNormalizer.isRecord treats a non-object params (e.g. null) as
      // absent ({}), so an inline-form barrier step with params: null is a
      // previously-supported normalized form -- the unconditional
      // barrierParams $ref (which requires an object) must not reject it;
      // only the inline fields should be validated (#6215 review).
      const yaml = `
name: barrier-inline-null-params
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync1
    deviceCount: 2
    params: null
  - tool: barrier
    device: B
    lock: sync1
    deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject an inline barrier with params: null and an invalid inline field", () => {
      const yaml = `
name: barrier-inline-null-params-invalid
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync1
    deviceCount: not-a-number
    params: null
  - tool: barrier
    device: B
    lock: sync1
    deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should reject a barrier step with an inline malformed platform value", () => {
      // The inline form must be constrained the same as the nested-params
      // form, or PlanNormalizer moving it into params later would make the
      // runtime addDeviceTargetingToSchema reject a plan this authoring
      // schema accepted (#6215 review).
      const yaml = `
name: barrier-inline-malformed-platform
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync-point
    deviceCount: 2
    platform: windows
  - tool: barrier
    device: B
    lock: sync-point
    deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a barrier step with an inline valid platform value", () => {
      const yaml = `
name: barrier-inline-valid-platform
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync-point
    deviceCount: 2
    platform: android
  - tool: barrier
    device: B
    lock: sync-point
    deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should accept a barrier step with an inline malformed platform overridden by a valid params.platform", () => {
      const yaml = `
name: barrier-inline-platform-override
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync-point
    deviceCount: 2
    platform: windows
    params:
      platform: android
  - tool: barrier
    device: B
    lock: sync-point
    deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should accept a barrier step with a positive timeout", () => {
      const yaml = `
name: barrier-positive-timeout
devices:
  - A
  - B
steps:
  - tool: barrier
    params:
      device: A
      lock: sync-point
      deviceCount: 2
      timeout: 5000
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a criticalSection step with a zero timeout", () => {
      const yaml = `
name: critical-section-zero-timeout
devices:
  - A
steps:
  - tool: criticalSection
    params:
      lock: sync-point
      deviceCount: 1
      timeout: 0
      steps:
        - tool: tapOn
          params:
            device: A
            text: Button
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should accept a barrier whose inline deviceCount is invalid but params.deviceCount (the effective, params-wins value) is valid", () => {
      // PlanNormalizer's { ...inlineParams, ...paramsFromStep } merge means
      // params.deviceCount overrides the inline sibling at normalization, so
      // the discarded inline value must NOT be schema-validated (#6215
      // review, mirroring the #6090/#6107 networkCondition/doNotDisturb
      // override precedence).
      const yaml = `
name: barrier-inline-invalid-params-valid
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync-point
    deviceCount: not-a-number
    params:
      deviceCount: 2
  - tool: barrier
    device: B
    lock: sync-point
    params:
      deviceCount: 2
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should reject a barrier whose inline deviceCount is valid but params.deviceCount (the effective, params-wins value) is invalid", () => {
      const yaml = `
name: barrier-inline-valid-params-invalid
devices:
  - A
steps:
  - tool: barrier
    device: A
    lock: sync-point
    deviceCount: 2
    params:
      deviceCount: 0
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
    });

    it("should validate expectations array", () => {
      const yaml = `
name: expectations-test
steps:
  - tool: observe
    expectations:
      - type: elementExists
        selector:
          text: "Hello"
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should validate metadata fields", () => {
      const yaml = `
name: metadata-test
steps:
  - tool: observe
metadata:
  createdAt: "2026-01-08T00:00:00Z"
  version: "1.0.0"
  appId: com.example.app
  sessionId: "session-123"
  toolCallCount: 10
  duration: 1500.5
  generatedFromToolCalls: true
  experiments: ["exp-1", "exp-2"]
  treatments:
    exp-1: "variant-a"
  featureFlags:
    darkMode: true
    beta: false
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });
  });

  describe("Legacy field handling", () => {
    it("should allow deprecated 'generated' field", () => {
      const yaml = `
name: legacy-plan
generated: "2026-01-08T00:00:00Z"
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should allow deprecated 'appId' field", () => {
      const yaml = `
name: legacy-plan
appId: com.example.app
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should allow deprecated 'parameters' field", () => {
      const yaml = `
name: legacy-plan
parameters:
  key1: value1
  key2: value2
steps:
  - tool: observe
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });

    it("should allow deprecated 'description' in steps", () => {
      const yaml = `
name: legacy-plan
steps:
  - tool: observe
    description: Old-style description
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(true);
    });
  });

  describe("Error message quality", () => {
    it("validates metadata keys with punctuation literally", () => {
      const longValue = `${"a".repeat(40)}!`;
      const yaml = `name: metadata-keys
steps:
  - tool: observe
metadata:
  treatments:
    "(a+)+$": 1
  note: "${longValue}"
  ${longValue}: decoy
`;

      const result = validator.validateYaml(yaml);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "metadata.treatments.(a+)+$",
        message: "Must be of type 'string', but got number",
        line: 5,
        column: 1,
      });
    });

    it("returns a validation error for a metadata key with unmatched punctuation", () => {
      const yaml = `name: metadata-keys
steps:
  - tool: observe
metadata:
  treatments:
    a(: 1
`;

      const result = validator.validateYaml(yaml);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "metadata.treatments.a(",
        message: "Must be of type 'string', but got number",
        line: 6,
        column: 1,
      });
    });

    it("retains line numbers for ordinary metadata keys", () => {
      const yaml = `name: metadata-keys
steps:
  - tool: observe
metadata:
  treatments:
    exp_1: 1
    dotted.key: 2
`;

      const result = validator.validateYaml(yaml);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: "metadata.treatments.exp_1",
        message: "Must be of type 'string', but got number",
        line: 6,
        column: 1,
      });
      expect(result.errors).toContainEqual({
        field: "metadata.treatments.dotted.key",
        message: "Must be of type 'string', but got number",
        line: 5,
        column: 1,
      });
    });

    it("should provide helpful error for additionalProperties", () => {
      const yaml = `
name: test-plan
steps:
  - tool: observe
unknownTopLevelField: value
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      const error = result.errors!.find((e) => e.message.includes("Unknown property"));
      expect(error).toBeDefined();
      expect(error!.message).toContain("legacy field");
    });

    it("should format field paths nicely", () => {
      const yaml = `
name: test-plan
steps:
  - tool: observe
  - {}
`;
      const result = validator.validateYaml(yaml);
      expect(result.valid).toBe(false);
      // Should have error for steps[1] missing tool
      const error = result.errors!.find((e) => e.field.includes("steps[1]"));
      expect(error).toBeDefined();
    });
  });
});

describe("PlanSchemaValidator.validateFile", () => {
  it("returns the schema-loading error before attempting to read a missing file", async () => {
    const validator = new PlanSchemaValidator();

    const result = await validator.validateFile("/definitely-missing-plan.yaml");

    expect(result).toEqual({
      valid: false,
      errors: [{ field: "schema", message: "Schema not loaded. Call loadSchema() first." }],
    });
  });
});

describe("PlanSchemaValidator process cache", () => {
  const plan = "name: cached plan\nsteps:\n  - tool: observe\n";
  const schemaContent = JSON.stringify({
    type: "object",
    required: ["name", "steps"],
    properties: { name: { type: "string" }, steps: { type: "array" } },
  });

  class FakeSchemaFileSystem implements Pick<FileSystem, "readFile"> {
    readonly attempts: string[] = [];
    content = schemaContent;
    missing = false;

    async readFile(filePath: string): Promise<string> {
      this.attempts.push(filePath);
      if (this.missing) {
        throw Object.assign(new Error("missing schema"), { code: "ENOENT" });
      }
      return this.content;
    }
  }

  let restoreCache: () => void;

  beforeAll(async () => {
    const populated = new PlanSchemaValidator();
    await populated.loadSchema();
    populated.validateYaml(plan);
  });

  beforeEach(() => {
    restoreCache = resetPlanSchemaCacheForTests();
  });

  afterEach(() => {
    restoreCache();
  });

  for (const concurrent of [false, true]) {
    describe(concurrent ? "concurrent first loads" : "sequential loads", () => {
      let fileSystem: FakeSchemaFileSystem;
      let validators: PlanSchemaValidator[];

      beforeEach(async () => {
        fileSystem = new FakeSchemaFileSystem();
        validators = Array.from({ length: 5 }, () => new PlanSchemaValidator(fileSystem));
        if (concurrent) {
          await Promise.all(validators.map((candidate) => candidate.loadSchema()));
        } else {
          for (const candidate of validators) {
            await candidate.loadSchema();
          }
        }
        // Warm compilation in setup, outside the per-test timing budget.
        validators[0].validateYaml(plan);
      });

      it("reads once and shares Ajv/schema while keeping instance validation lazy", async () => {
        expect(fileSystem.attempts).toHaveLength(1);
        const first = validators[0];
        for (const candidate of validators.slice(1)) {
          expect(candidate.isSchemaLoaded()).toBe(true);
          expect(Reflect.get(candidate, "ajv")).toBe(Reflect.get(first, "ajv"));
          expect(Reflect.get(candidate, "schema")).toBe(Reflect.get(first, "schema"));
          expect(Reflect.get(candidate, "validateFn")).toBeUndefined();
          expect(candidate.validateYaml(plan)).toEqual({ valid: true });
        }
        expect(first.validateYaml(plan)).toEqual({ valid: true });
        await first.loadSchema();
        const unusedFileSystem = new FakeSchemaFileSystem();
        await new PlanSchemaValidator(unusedFileSystem).loadSchema();
        expect(unusedFileSystem.attempts).toHaveLength(0);
        expect(fileSystem.attempts).toHaveLength(1);
      });
    });
  }

  it("does not cache missing-schema failures and reports only distinct attempted paths", async () => {
    const fileSystem = new FakeSchemaFileSystem();
    fileSystem.missing = true;
    const failed = new PlanSchemaValidator(fileSystem);
    const results = await Promise.allSettled([
      failed.loadSchema(),
      new PlanSchemaValidator(fileSystem).loadSchema(),
    ]);
    const result = results[0];
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("Expected missing-schema rejection");
    }
    const message = String(result.reason.message);
    expect(message).toStartWith(
      "Could not find test-plan.schema.json.\nCurrent working directory:",
    );
    expect(message).toContain("\nModule directory:");
    expect(message).toContain("\nGITHUB_WORKSPACE:");
    const attemptedPaths = message
      .split("Tried paths:\n")[1]
      .split("\n")
      .map((line) => line.slice(4));
    expect(attemptedPaths).toEqual(fileSystem.attempts);
    expect(attemptedPaths.length).toBeGreaterThan(0);
    expect(new Set(attemptedPaths.map((candidate) => path.resolve(candidate))).size).toBe(
      attemptedPaths.length,
    );
    expect(failed.isSchemaLoaded()).toBe(false);
    expect(results[1]).toEqual(result);

    fileSystem.missing = false;
    const recovered = new PlanSchemaValidator(fileSystem);
    await recovered.loadSchema();
    expect(recovered.isSchemaLoaded()).toBe(true);
    expect(fileSystem.attempts).toHaveLength(attemptedPaths.length + 1);
    await failed.loadSchema();
    expect(failed.isSchemaLoaded()).toBe(true);
    expect(fileSystem.attempts).toHaveLength(attemptedPaths.length + 1);
  });

  it("does not cache JSON parse failures", async () => {
    const fileSystem = new FakeSchemaFileSystem();
    fileSystem.content = "{";
    const failed = new PlanSchemaValidator(fileSystem);
    await expect(failed.loadSchema()).rejects.toBeInstanceOf(SyntaxError);
    expect(failed.isSchemaLoaded()).toBe(false);
    fileSystem.content = schemaContent;
    await failed.loadSchema();
    expect(failed.isSchemaLoaded()).toBe(true);
    expect(fileSystem.attempts).toHaveLength(2);
  });

  it("requires each instance to load even when the process cache is populated", async () => {
    await new PlanSchemaValidator(new FakeSchemaFileSystem()).loadSchema();
    const unloaded = new PlanSchemaValidator();
    expect(unloaded.isSchemaLoaded()).toBe(false);
    expect(() => unloaded.validateYaml(plan)).toThrow(
      "Schema not loaded. Call loadSchema() first.",
    );
  });
});
