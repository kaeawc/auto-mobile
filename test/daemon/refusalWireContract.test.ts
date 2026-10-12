import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as hostBootRegistry from "../../src/features/bootAdmission/HostBootAdmissionRegistry";
import * as downloadsRefusals from "../../src/server/downloadsFixtureService";
import * as adbHealth from "../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import * as deviceLost from "../../src/models/DeviceLostError";
import * as managedSlotConfig from "../../src/models/managedSlotConfig";
import * as discoveryRefusals from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import * as shutdownTimeout from "../../src/models/DeviceShutdownTimeoutError";
import * as iosHomeLaunchTimeout from "../../src/models/IosHomeLaunchTimeoutError";
import * as recoveryAssignment from "../../src/models/SessionRecoveryAssignmentError";
import * as streamPolicy from "../../src/daemon/streamSubscriptionPolicy";
import * as namespaceGuard from "../../src/daemon/sharedNamespaceGuard";
import * as restartAdmission from "../../src/daemon/daemonRestartAdmission";
import * as deviceSessionResolver from "../../src/daemon/deviceSessionResolver";
import * as recordingAdmission from "../../src/daemon/deviceGestureRecordingStartAdmission";
import * as handoffInterruption from "../../src/daemon/daemonHandoffInterruption";
import * as daemonProxy from "../../src/daemon/daemonMcpProxy";
import * as sessionManager from "../../src/daemon/sessionManager";
import * as sessionOwnership from "../../src/daemon/sessionNoLongerOwnsDevice";
import * as daemonCommand from "../../src/daemon/cli/runDaemonCommand";
import * as provisioning from "../../src/devices/exactDeviceProvisioning";
import * as deviceBoot from "../../src/devices/deviceBootService";
import { ActionableError } from "../../src/models/ActionableError";
import * as acquisitionRefusals from "../../src/daemon/deviceAcquisitionRefusals";
import * as inputOwnership from "../../src/daemon/inputDeviceOwnership";
import * as managedSlotRefusals from "../../src/daemon/managedSlots/managedSlotRefusal";
import * as bootCapacity from "../../src/models/BootCapacityExhaustedError";
import * as boundSessionRefusal from "../../src/server/deviceOutsideBoundSessionRefusal";
import * as daemonTypes from "../../src/daemon/types";
import * as daemonConstants from "../../src/daemon/constants";
import * as mcpTimeouts from "../../src/daemon/McpTimeoutError";
import * as sessionReleasedDuringCall from "../../src/daemon/sessionReleasedDuringCall";
import * as appNotRunning from "../../src/models/AppNotRunningError";
import * as daemonClient from "../../src/daemon/client";
import * as controlTransport from "../../src/daemon/deviceControlTransportFailure";
import * as toolUnavailable from "../../src/server/toolUnavailableError";
import * as deviceTools from "../../src/server/deviceTools";
import * as sessionRecovery from "../../src/models/deviceSessionRecovery";
import type { ManagedSlotsResult } from "../../src/models/managedSlotsResult";
import { DEFAULT_PROVISION_DEVICE_RETRYABILITY } from "../../src/devices/exactDeviceProvisioning";
import { planRefusalFields } from "../../src/server/planExecutionOrchestrator";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import {
  DaemonRestartDeferredError,
  DaemonRestartPendingError,
} from "../../src/daemon/daemonRestartAdmission";
import {
  EXTERNALLY_CAPTURED_SURFACE_FIXTURES,
  EXEMPT_REFUSAL_ERROR_CLASSES,
  fixtureDrivenErrorClasses,
  MANAGED_SLOT_FIXTURE_PREFIX,
  recoveryPendingError,
  shapedRefusalResult,
  PROVISION_DEVICE_FIXTURE_PREFIX,
  buildRefusalSurfaceFixtures,
  type RefusalSurfaceFixture,
  type RefusalWireResult,
  expectedWireCodes,
  managedSlotNestedCodes,
  REFUSAL_FIXTURES_DIR,
  REFUSAL_SURFACES_DIR,
  serializeRefusalSurfaceFixture,
  surfaceFixtureStem,
  UNFIXTURED_REFUSAL_CODES,
  LITERAL_CLIENT_REACHABLE_CODES,
  buildRefusalWireFixtures,
  serializeRefusalFixture,
  type RefusalDisposition,
} from "../helpers/refusalWireFixtures";

/**
 * Hand-maintained modules declaring exported Error subclasses with a wire code anywhere: own
 * code, failure.code, data.code, details.code, or inherited. Runtime exports extend coverage
 * within these modules; a coded class in an unlisted module is not seen.
 */
const refusalErrorModules: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "features/bootAdmission/HostBootAdmissionRegistry": hostBootRegistry,
  "server/downloadsFixtureService": downloadsRefusals,
  "utils/android-cmdline-tools/AdbDeviceHealth": adbHealth,
  "models/DeviceLostError": deviceLost,
  "models/managedSlotConfig": managedSlotConfig,
  "models/BootedDeviceDiscoveryIncompleteError": discoveryRefusals,
  "models/DeviceShutdownTimeoutError": shutdownTimeout,
  "models/IosHomeLaunchTimeoutError": iosHomeLaunchTimeout,
  "models/SessionRecoveryAssignmentError": recoveryAssignment,
  "daemon/streamSubscriptionPolicy": streamPolicy,
  "daemon/sharedNamespaceGuard": namespaceGuard,
  "daemon/daemonRestartAdmission": restartAdmission,
  "daemon/deviceSessionResolver": deviceSessionResolver,
  "daemon/deviceGestureRecordingStartAdmission": recordingAdmission,
  "daemon/daemonHandoffInterruption": handoffInterruption,
  "daemon/daemonMcpProxy": daemonProxy,
  "daemon/sessionManager": sessionManager,
  "daemon/sessionNoLongerOwnsDevice": sessionOwnership,
  "daemon/cli/runDaemonCommand": daemonCommand,
  "devices/exactDeviceProvisioning": provisioning,
  "devices/deviceBootService": deviceBoot,
  "daemon/deviceAcquisitionRefusals": acquisitionRefusals,
  "daemon/inputDeviceOwnership": inputOwnership,
  "daemon/managedSlots/managedSlotRefusal": managedSlotRefusals,
  "models/BootCapacityExhaustedError": bootCapacity,
  "server/deviceOutsideBoundSessionRefusal": boundSessionRefusal,
  "daemon/McpTimeoutError": mcpTimeouts,
  "daemon/sessionReleasedDuringCall": sessionReleasedDuringCall,
  "models/AppNotRunningError": appNotRunning,
  "daemon/client": daemonClient,
  "daemon/deviceControlTransportFailure": controlTransport,
  "server/toolUnavailableError": toolUnavailable,
  "server/deviceTools": deviceTools,
};

function exportedErrorClasses(modules: typeof refusalErrorModules) {
  return Object.entries(modules).flatMap(([module, exports]) =>
    Object.entries(exports)
      .filter(([, value]) => typeof value === "function" && value.prototype instanceof Error)
      .map(([name, errorClass]) => ({ name, module, errorClass })),
  );
}

/** Pure coverage checker; the mutation test can extend exports without changing production code. */
function missingErrorClasses(
  modules: typeof refusalErrorModules,
  driven: ReadonlySet<unknown>,
  exempt: ReadonlyMap<unknown, string>,
): string[] {
  return exportedErrorClasses(modules)
    .filter(({ errorClass }) => !driven.has(errorClass) && !exempt.get(errorClass)?.trim())
    .map(({ name, module }) => `${name} (${module})`);
}

/**
 * Cross-language contract for typed daemon refusals: the JUnit runner and XCTestRunner decode the
 * same fixtures and classify them per expectations.json. This suite keeps the TypeScript side of
 * that contract honest.
 */
interface Expectations {
  codes: Record<
    string,
    {
      expected: RefusalDisposition;
      knownGaps?: Record<string, RefusalDisposition>;
      fields: RefusalFields;
    }
  >;
}

interface RefusalFields {
  code?: string;
  retryable: boolean;
  acquireNewSession: boolean;
  retryAfterMs?: number;
  externalDevices?: string[];
}

interface WirePayload {
  retryAfterMs?: number;
  externalDevices?: string[];
  code?: string;
  retryable?: boolean;
  nextAction?: string;
  error?: {
    retryAfterMs?: number;
    code?: string;
    retryable?: boolean;
    nextAction?: string;
    acquisitionFailure?: { code?: string } | null;
  };
}

/** The codes a payload names on the wire, outermost first. */
function wireCodes(payload: WirePayload): string[] {
  const codes = [typeof payload.error === "object" ? payload.error.code : payload.code];
  const nested =
    typeof payload.error === "object" ? payload.error.acquisitionFailure?.code : undefined;
  return nested ? [...codes, nested] : codes.filter((code): code is string => code !== undefined);
}

const WAIT_CODES: ReadonlySet<string> = new Set([
  "device_owned_by_other_session",
  "device_cleanup_in_progress",
  "device_owned_by_other_daemon",
  "device_shutting_down",
]);
const RETRYABLE_WAIT_CODES: ReadonlySet<string> = new Set([
  "capacity_exhausted",
  "discovery_incomplete",
]);

/** What a runner reads from a payload: the shape `fields` pins for the Kotlin and Swift suites. */
function readFields(payload: WirePayload): RefusalFields {
  const envelope = typeof payload.error === "object" ? payload.error : undefined;
  const retryAfterMs = envelope?.retryAfterMs ?? payload.retryAfterMs;
  return {
    code: envelope?.code ?? payload.code,
    retryable: envelope?.retryable === true || payload.retryable === true,
    acquireNewSession: (envelope?.nextAction ?? payload.nextAction) === "acquire_new_session",
    ...(typeof retryAfterMs === "number" && retryAfterMs > 0 ? { retryAfterMs } : {}),
    ...(payload.externalDevices ? { externalDevices: payload.externalDevices } : {}),
  };
}

/** The precedence documented in expectations.json, applied to the top-level wire fields. */
function deriveDisposition(payload: WirePayload): RefusalDisposition {
  const envelope = typeof payload.error === "object" ? payload.error : undefined;
  return dispositionOf(
    envelope?.code ?? payload.code ?? "",
    (envelope?.retryable ?? payload.retryable) === true,
    envelope?.nextAction ?? payload.nextAction,
  );
}

function dispositionOf(
  code: string,
  retryable: boolean,
  nextAction: string | undefined,
): RefusalDisposition {
  if (WAIT_CODES.has(code) || (retryable && RETRYABLE_WAIT_CODES.has(code))) {
    return "wait";
  }
  if (nextAction === "acquire_new_session") {
    return "acquire-new-session";
  }
  return retryable ? "retry" : "fail";
}

const expectations = JSON.parse(
  readFileSync(join(REFUSAL_FIXTURES_DIR, "expectations.json"), "utf8"),
) as Expectations;
const fixtures = buildRefusalWireFixtures();
const fixtureCodes = fixtures.map((fixture) => fixture.code);

/**
 * Every exported `*_CODE` string constant of the modules that define device, session and daemon
 * lifecycle refusal codes (#11351). Codes written as literals (`no_active_device_session`,
 * `session_recovery_pending`, ...) are listed in `LITERAL_CLIENT_REACHABLE_CODES` instead.
 */
function exportedCodeConstants(): Map<string, string> {
  const found = new Map<string, string>();
  for (const module of [
    acquisitionRefusals,
    inputOwnership,
    bootCapacity,
    managedSlotRefusals,
    boundSessionRefusal,
    daemonTypes,
    daemonConstants,
    mcpTimeouts,
    sessionReleasedDuringCall,
    appNotRunning,
    sessionRecovery,
  ]) {
    for (const [name, value] of Object.entries(module)) {
      if (name.endsWith("_CODE") && typeof value === "string") {
        found.set(value, name);
      }
    }
  }
  return found;
}

interface SurfaceFields extends RefusalFields {
  /** The evidence the refusal carries beside its typed fields. */
  details?: Record<string, unknown>;
  /** A managed slot failure's boot-capacity object. */
  capacity?: Record<string, unknown>;
}

interface SurfaceExpectations {
  fixtures: Record<string, { expected: RefusalDisposition; fields: SurfaceFields }>;
}

interface TypedFields {
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  nextAction?: string;
}

/** The typed fields a surface fixture's payload carries, and where they sit on that surface. */
function surfaceTyped(fixture: RefusalSurfaceFixture): {
  typed: TypedFields;
  details?: Record<string, unknown>;
  capacity?: Record<string, unknown>;
} {
  const payload = fixture.payload as Record<string, unknown>;
  if (fixture.surface === "aux-socket-response") {
    return { typed: payload as TypedFields, details: { deviceId: payload.deviceId } };
  }
  if (fixture.surface === "socket-frame") {
    return { typed: payload as TypedFields, details: payload.details as Record<string, unknown> };
  }
  if (fixture.surface === "overload-frame") {
    const { code, retryable, retryAfterMs, reason, queueWaitMs, remainingTimeoutMs } =
      payload.overloadFailure as TypedFields & {
        reason: string;
        queueWaitMs: number;
        remainingTimeoutMs: number;
      };
    return {
      typed: { code, retryable, retryAfterMs },
      details: { queueWaitMs, remainingTimeoutMs, reason },
    };
  }
  if (fixture.surface === "webrtc-stream-response") {
    // The aux-socket response carries no retryable field; absent on the wire means not retryable.
    expect(Object.hasOwn(payload, "retryable"), fixture.name).toBe(false);
    return { typed: { code: String(payload.errorCode), retryable: false } };
  }
  if (fixture.surface === "delete-device") {
    const text = (payload as unknown as RefusalWireResult).content[0].text;
    const failure = (JSON.parse(text) as { failure: Record<string, unknown> }).failure;
    const { code, phase, message, retryable, retryAfterMs, nextAction, ...evidence } = failure;
    expect([phase, typeof message], fixture.name).toEqual(["precondition", "string"]);
    return {
      typed: { code, retryable, retryAfterMs, nextAction } as TypedFields,
      details: Object.keys(evidence).length > 0 ? evidence : undefined,
    };
  }
  const result = payload as unknown as ManagedSlotsResult;
  const failure = result.slots.find((slot) => slot.failure)?.failure ?? result.failure;
  return { typed: failure as TypedFields, capacity: failure?.capacity };
}

function surfaceFields(fixture: RefusalSurfaceFixture): SurfaceFields {
  const { typed, details, capacity } = surfaceTyped(fixture);
  return {
    code: typed.code,
    retryable: typed.retryable === true,
    acquireNewSession: typed.nextAction === "acquire_new_session",
    ...(typeof typed.retryAfterMs === "number" && typed.retryAfterMs > 0
      ? { retryAfterMs: typed.retryAfterMs }
      : {}),
    ...(details ? { details } : {}),
    ...(capacity ? { capacity } : {}),
  };
}

const surfaceFixtures = buildRefusalSurfaceFixtures();
const capturedSurfaceFixtures = EXTERNALLY_CAPTURED_SURFACE_FIXTURES.map(
  (fixture) =>
    JSON.parse(
      readFileSync(join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`), "utf8"),
    ) as RefusalSurfaceFixture,
);
const allSurfaceFixtures = [...surfaceFixtures, ...capturedSurfaceFixtures];
const coveredWireCodes = new Set([
  ...fixtureCodes.map((code) => expectedWireCodes(code)[0]),
  ...allSurfaceFixtures.flatMap((fixture) => expectedWireCodes(fixture.name)),
]);
const drivenErrorClasses = fixtureDrivenErrorClasses();
const surfaceExpectations = JSON.parse(
  readFileSync(join(REFUSAL_SURFACES_DIR, "expectations.json"), "utf8"),
) as SurfaceExpectations;

describe("refusal wire contract", () => {
  test("platform ambiguity names the held sessions without retry or recovery guidance", () => {
    const fixture = fixtures.find((fixture) => fixture.code === "ambiguous_session_selector")!;
    expect(fixture.result.isError).toBe(true);
    expect(fixture.result.content).toHaveLength(1);
    const payload = JSON.parse(fixture.result.content[0].text);
    expect(payload.error).toEqual({
      code: "ambiguous_session_selector",
      message: expect.stringContaining("Name one with sessionUuid or deviceId."),
      platform: "android",
      candidates: [
        { sessionUuid: "11111111-2222-4333-8444-555555555555", deviceId: "emulator-5554" },
        { sessionUuid: "second-android-session", deviceId: "emulator-5556" },
      ],
      retryable: false,
    });
    expect(deriveDisposition(payload)).toBe("fail");
  });

  test("committed fixtures equal what the real TypeScript builders emit", () => {
    for (const fixture of fixtures) {
      const path = join(REFUSAL_FIXTURES_DIR, `${fixture.code}.json`);
      expect(readFileSync(path, "utf8")).toBe(serializeRefusalFixture(fixture));
    }
  });

  test("no stray fixture file exists without a builder", () => {
    const files = readdirSync(REFUSAL_FIXTURES_DIR)
      .filter((name) => name.endsWith(".json") && name !== "expectations.json")
      .map((name) => name.replace(/\.json$/, ""));
    expect(files.sort()).toEqual([...fixtureCodes].sort());
  });

  test("every fixture carries the code it is named for on the wire", () => {
    for (const fixture of fixtures) {
      const payload = JSON.parse(fixture.result.content[0].text) as WirePayload;
      expect(wireCodes(payload), fixture.code).toEqual(expectedWireCodes(fixture.code));
    }
  });

  test("every provisionDevice failure code has a fixture, bare or prefixed", () => {
    for (const code of Object.keys(DEFAULT_PROVISION_DEVICE_RETRYABILITY)) {
      const present =
        fixtureCodes.includes(code) ||
        fixtureCodes.includes(`${PROVISION_DEVICE_FIXTURE_PREFIX}${code}`);
      expect(present, code).toBe(true);
    }
  });

  test("every managed slot acquisition failure code has a fixture", () => {
    for (const code of managedSlotNestedCodes()) {
      expect(fixtureCodes, code).toContain(`${MANAGED_SLOT_FIXTURE_PREFIX}${code}`);
    }
  });

  test("the expectations agree with the disposition the wire fields imply", () => {
    for (const fixture of fixtures) {
      const payload = JSON.parse(fixture.result.content[0].text) as WirePayload;
      expect(expectations.codes[fixture.code].expected, fixture.code).toBe(
        deriveDisposition(payload),
      );
    }
  });

  test("the expectations pin the fields each fixture carries on the wire", () => {
    for (const fixture of fixtures) {
      const payload = JSON.parse(fixture.result.content[0].text) as WirePayload;
      expect(expectations.codes[fixture.code].fields, fixture.code).toEqual(readFields(payload));
    }
    const rows = Object.values(expectations.codes).map((row) => row.fields);
    expect(rows.some((fields) => fields.retryAfterMs !== undefined)).toBe(true);
    expect(rows.some((fields) => fields.externalDevices !== undefined)).toBe(true);
    expect(rows.some((fields) => fields.acquireNewSession)).toBe(true);
  });

  test("every exported error class is driven by a fixture or exempted with a reason", () => {
    expect(
      missingErrorClasses(refusalErrorModules, drivenErrorClasses, EXEMPT_REFUSAL_ERROR_CLASSES),
      "Drive each missing class through a serializer in refusalWireFixtures.ts, capture its fixture, or record a written exemption.",
    ).toEqual([]);
  });

  test("an exemption never outlives its gap or names a class no longer exported", () => {
    const exported = new Set(
      exportedErrorClasses(refusalErrorModules).map(({ errorClass }) => errorClass),
    );
    for (const [errorClass, reason] of EXEMPT_REFUSAL_ERROR_CLASSES) {
      expect(reason.trim().length, errorClass.name).toBeGreaterThan(0);
      expect(exported.has(errorClass), errorClass.name).toBe(true);
      expect(drivenErrorClasses.has(errorClass), errorClass.name).toBe(false);
    }
    expect(fixtureDrivenErrorClasses()).toEqual(drivenErrorClasses);
    expect(drivenErrorClasses.has(acquisitionRefusals.RetryableDeviceAcquisitionError)).toBe(false);
  });

  test("the class coverage checker detects a new coded refusal", () => {
    class NewCodedRefusal extends ActionableError {
      readonly code = "x";
    }
    const modules = {
      mutation: {
        NewCodedRefusal,
        AppNotRunningError: appNotRunning.AppNotRunningError,
        nonError: () => "x",
      },
    };
    expect(
      missingErrorClasses(modules, new Set([appNotRunning.AppNotRunningError]), new Map()),
    ).toEqual(["NewCodedRefusal (mutation)"]);
  });

  test("every refusal code constant has a fixture or a recorded reason it has none", () => {
    const missing: string[] = [];
    for (const [code, constant] of exportedCodeConstants()) {
      if (!coveredWireCodes.has(code) && !(code in UNFIXTURED_REFUSAL_CODES)) {
        missing.push(`${constant} = "${code}"`);
      }
    }
    // Add a builder to test/helpers/refusalWireFixtures.ts, run
    // `bun scripts/generate-refusal-wire-fixtures.ts`, and add a row to expectations.json.
    expect(missing).toEqual([]);
  });

  test("every client-reachable code defined as a literal has a fixture or a recorded reason", () => {
    const missing = LITERAL_CLIENT_REACHABLE_CODES.filter(
      (code) => !coveredWireCodes.has(code) && !(code in UNFIXTURED_REFUSAL_CODES),
    );
    expect(missing).toEqual([]);
    // A recorded reason never outlives its gap: a code with a fixture must not stay excused.
    expect(
      Object.keys(UNFIXTURED_REFUSAL_CODES).filter((code) => coveredWireCodes.has(code)),
    ).toEqual([]);
  });

  test("every retryable acquisition code has a fixture", () => {
    for (const code of acquisitionRefusals.RETRYABLE_DEVICE_ACQUISITION_CODES) {
      expect(fixtureCodes).toContain(code);
    }
  });

  test("the expectations table covers exactly the fixtures", () => {
    expect(Object.keys(expectations.codes).sort()).toEqual([...fixtureCodes].sort());
  });

  test("a known gap never repeats the expectation", () => {
    for (const [code, row] of Object.entries(expectations.codes)) {
      for (const actual of Object.values(row.knownGaps ?? {})) {
        expect(actual, code).not.toBe(row.expected);
      }
    }
  });

  describe("one class, three wires", () => {
    // The MCP result, the socket failure frame and the executePlan result of a thrown error must
    // agree on the class's `code` and `retryable` (#11544); the owner contracts pin the values.
    const SESSION = "11111111-2222-4333-8444-555555555555";
    const classes: readonly (readonly [
      string,
      () => Error,
      string,
      boolean,
      string | undefined,
    ])[] = [
      [
        "idle release cut a call",
        () => new SessionReleasedDuringCallError(SESSION, "cli-idle-timeout"),
        "session_ownership_lost",
        false,
        "acquire_new_session",
      ],
      [
        "heartbeat release cut a call",
        () => new SessionReleasedDuringCallError(SESSION, "heartbeat-timeout"),
        "session_ownership_lost",
        false,
        "acquire_new_session",
      ],
      [
        "restart deferred",
        () => new DaemonRestartDeferredError("a device operation is active"),
        "daemon_restart_deferred",
        true,
        undefined,
      ],
      [
        "restart pending",
        () => new DaemonRestartPendingError(),
        "daemon_restart_pending",
        true,
        undefined,
      ],
      [
        "session recovery pending",
        recoveryPendingError,
        "session_recovery_pending",
        true,
        undefined,
      ],
    ];

    test.each(classes)("%s", (_name, build, code, retryable, nextAction) => {
      const error = build();
      const mcp = readFields(JSON.parse(shapedRefusalResult(error).content[0].text) as WirePayload);
      const frame = mcpRequestFailureDetails(error, undefined);
      const plan = planRefusalFields(error);
      expect([mcp.code, mcp.retryable]).toEqual([code, retryable]);
      expect(mcp.acquireNewSession).toBe(nextAction === "acquire_new_session");
      expect([frame.code, frame.retryable, frame.nextAction]).toEqual([
        code,
        retryable,
        nextAction,
      ]);
      expect([plan.code, plan.retryable, plan.nextAction]).toEqual([code, retryable, nextAction]);
    });

    test("session_recovery_pending keeps its nested details for current readers", () => {
      const error = recoveryPendingError();
      expect(mcpRequestFailureDetails(error, undefined).details).toMatchObject({
        code: "session_recovery_pending",
        retryable: true,
        sessionUuid: SESSION,
        recoveryWindowRemainingMs: 120_000,
      });
      expect(planRefusalFields(error).details).toMatchObject({ code: "session_recovery_pending" });
    });
  });

  describe("surfaces that carry a refusal but are not a tool result", () => {
    test("committed surface fixtures equal what the real serializers emit", () => {
      if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
        mkdirSync(REFUSAL_SURFACES_DIR, { recursive: true });
        for (const fixture of surfaceFixtures) {
          writeFileSync(
            join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`),
            serializeRefusalSurfaceFixture(fixture),
          );
        }
      }
      for (const fixture of surfaceFixtures) {
        const path = join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`);
        expect(existsSync(path), `${path}; regenerate with UPDATE_CAPTURED_FIXTURES=1`).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(serializeRefusalSurfaceFixture(fixture));
      }
    });

    test("no stray surface fixture exists without a builder", () => {
      const files = readdirSync(REFUSAL_SURFACES_DIR)
        .filter((name) => name.endsWith(".json") && name !== "expectations.json")
        .map((name) => name.replace(/\.json$/, ""));
      expect(files.sort()).toEqual(allSurfaceFixtures.map(surfaceFixtureStem).sort());
      expect(Object.keys(surfaceExpectations.fixtures).sort()).toEqual(files.sort());
    });

    test("the expectations pin the fields and disposition each surface carries", () => {
      for (const fixture of allSurfaceFixtures) {
        const stem = surfaceFixtureStem(fixture);
        const row = surfaceExpectations.fixtures[stem];
        const fields = surfaceFields(fixture);
        expect(row.fields, stem).toEqual(fields);
        expect(row.expected, stem).toBe(
          dispositionOf(
            fields.code ?? "",
            fields.retryable,
            fields.acquireNewSession ? "acquire_new_session" : undefined,
          ),
        );
      }
    });

    test("every socket frame carries the code it is named for and its retry intent", () => {
      for (const fixture of surfaceFixtures.filter((f) => f.surface === "socket-frame")) {
        const frame = fixture.payload as { success: boolean; code?: string; retryable?: boolean };
        expect(frame.success, fixture.name).toBe(false);
        expect([frame.code], fixture.name).toEqual(expectedWireCodes(fixture.name));
        expect(typeof frame.retryable, fixture.name).toBe("boolean");
      }
    });

    test("the surfaces cover the shapes the wire gained on 2026-10-10", () => {
      const names = (surface: string) =>
        surfaceFixtures.filter((f) => f.surface === surface).map((f) => f.name);
      expect(names("socket-frame")).toEqual(
        expect.arrayContaining([
          "device_owned_by_other_session",
          "device_outside_bound_session",
          "device_outside_managed_slots",
          "device_assigned_to_managed_slot",
        ]),
      );
      expect(names("delete-device")).toEqual(
        expect.arrayContaining(["device_owned_by_other_daemon", "discovery_incomplete"]),
      );
      expect(names("managed-slots-result")).toContain("capacity_exhausted.capacity_external");
    });
  });
});
