import * as prototypeHidden from "../../src/features/prototype/prototypeHidden";
import * as prototypeSuspended from "../../src/features/prototype/prototypeSuspended";
import { isTypedToolRefusal } from "../../src/server/shapeToolCallError";
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { parseSync, Visitor, type ClassDeclaration, type ClassExpression } from "oxc-parser";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
import * as hostBootRegistry from "../../src/features/bootAdmission/HostBootAdmissionRegistry";
import * as downloadsRefusals from "../../src/server/downloadsFixtureService";
import * as adbHealth from "../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import * as deviceLost from "../../src/models/DeviceLostError";
import * as bindingConfig from "../../src/daemon/sessionBroker/provisioning/provisionRequest";
import * as bindingRefusals from "../../src/daemon/sessionBroker/provisioning/refusal";
import * as sessionConfig from "../../src/devices/sessionConfig";
import * as discoveryRefusals from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import * as shutdownTimeout from "../../src/models/DeviceShutdownTimeoutError";
import * as iosHomeLaunchTimeout from "../../src/models/IosHomeLaunchTimeoutError";
import * as recoveryAssignment from "../../src/models/SessionRecoveryAssignmentError";
import * as streamPolicy from "../../src/daemon/streamSubscriptionPolicy";
import * as namespaceGuard from "../../src/daemon/sharedNamespaceGuard";
import * as restartAdmission from "../../src/daemon/daemonRestartAdmission";
import * as deviceSessionResolver from "../../src/daemon/deviceSessionResolver";
import * as orphanRecorderRefusal from "../../src/server/orphanRecorderRefusal";
import * as recordingAdmission from "../../src/daemon/deviceGestureRecordingStartAdmission";
import * as handoffInterruption from "../../src/daemon/daemonHandoffInterruption";
import * as daemonProxy from "../../src/daemon/daemonMcpProxy";
import * as daemonErrors from "../../src/daemon/proxy/daemonErrors";
import * as sessionManager from "../../src/daemon/sessionManager";
import * as sessionOwnership from "../../src/daemon/sessionNoLongerOwnsDevice";
import * as daemonCommand from "../../src/daemon/cli/runDaemonCommand";
import * as provisioning from "../../src/devices/exactDeviceProvisioning";
import * as deviceBoot from "../../src/devices/deviceBootService";
import { ActionableError } from "../../src/models/ActionableError";
import * as acquisitionRefusals from "../../src/daemon/deviceAcquisitionRefusals";
import * as inputOwnership from "../../src/daemon/inputDeviceOwnership";
import * as brokerConnectionRefusals from "../../src/daemon/sessionBroker/connectionRefusal";
import * as bootCapacity from "../../src/models/BootCapacityExhaustedError";
import * as boundSessionRefusal from "../../src/server/deviceOutsideBoundSessionRefusal";
import * as planLockRefusal from "../../src/server/planExecutionInProgressRefusal";
import * as ambiguousTargetRefusal from "../../src/server/ambiguousDeviceTargetRefusal";
import * as daemonTypes from "../../src/daemon/types";
import * as daemonConstants from "../../src/daemon/constants";
import * as mcpTimeouts from "../../src/daemon/McpTimeoutError";
import * as sessionReleasedDuringCall from "../../src/daemon/sessionReleasedDuringCall";
import * as sdkTooOld from "../../src/models/SdkTooOldError";
import * as appNotRunning from "../../src/models/AppNotRunningError";
import * as daemonClient from "../../src/daemon/client";
import * as controlTransport from "../../src/daemon/deviceControlTransportFailure";
import * as toolUnavailable from "../../src/server/toolUnavailableError";
import * as deviceTools from "../../src/server/deviceTools";
import * as sessionRecovery from "../../src/models/deviceSessionRecovery";
import type { BindingsResult } from "../../src/daemon/sessionBroker/provisioning/acquisitionResult";
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
  recoveryPendingError,
  shapedRefusalResult,
  PROVISION_DEVICE_FIXTURE_PREFIX,
  buildRefusalSurfaceFixtures,
  type RefusalSurfaceFixture,
  type RefusalWireResult,
  expectedWireCodes,
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
 * within these modules; the AST inventory below guards newly introduced modules.
 */
const refusalErrorModules: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "features/bootAdmission/HostBootAdmissionRegistry": hostBootRegistry,
  "server/downloadsFixtureService": downloadsRefusals,
  "utils/android-cmdline-tools/AdbDeviceHealth": adbHealth,
  "models/DeviceLostError": deviceLost,
  "daemon/sessionBroker/provisioning/provisionRequest": bindingConfig,
  "daemon/sessionBroker/provisioning/refusal": bindingRefusals,
  "devices/sessionConfig": sessionConfig,
  "models/BootedDeviceDiscoveryIncompleteError": discoveryRefusals,
  "models/DeviceShutdownTimeoutError": shutdownTimeout,
  "models/IosHomeLaunchTimeoutError": iosHomeLaunchTimeout,
  "models/SessionRecoveryAssignmentError": recoveryAssignment,
  "daemon/streamSubscriptionPolicy": streamPolicy,
  "daemon/sharedNamespaceGuard": namespaceGuard,
  "daemon/daemonRestartAdmission": restartAdmission,
  "daemon/deviceSessionResolver": deviceSessionResolver,
  "daemon/deviceGestureRecordingStartAdmission": recordingAdmission,
  "server/orphanRecorderRefusal": orphanRecorderRefusal,
  "daemon/daemonHandoffInterruption": handoffInterruption,
  "daemon/daemonMcpProxy": daemonProxy,
  "daemon/proxy/daemonErrors": daemonErrors,
  "daemon/sessionManager": sessionManager,
  "daemon/sessionNoLongerOwnsDevice": sessionOwnership,
  "daemon/cli/runDaemonCommand": daemonCommand,
  "devices/exactDeviceProvisioning": provisioning,
  "devices/deviceBootService": deviceBoot,
  "daemon/deviceAcquisitionRefusals": acquisitionRefusals,
  "daemon/inputDeviceOwnership": inputOwnership,
  "daemon/sessionBroker/connectionRefusal": brokerConnectionRefusals,
  "models/BootCapacityExhaustedError": bootCapacity,
  "server/deviceOutsideBoundSessionRefusal": boundSessionRefusal,
  "server/planExecutionInProgressRefusal": planLockRefusal,
  "server/ambiguousDeviceTargetRefusal": ambiguousTargetRefusal,
  "daemon/McpTimeoutError": mcpTimeouts,
  "daemon/sessionReleasedDuringCall": sessionReleasedDuringCall,
  "models/AppNotRunningError": appNotRunning,
  "models/SdkTooOldError": sdkTooOld,
  "features/prototype/prototypeHidden": prototypeHidden,
  "features/prototype/prototypeSuspended": prototypeSuspended,
  "daemon/client": daemonClient,
  "daemon/deviceControlTransportFailure": controlTransport,
  "server/toolUnavailableError": toolUnavailable,
  "server/deviceTools": deviceTools,
};

/** Only non-wire codes may bypass the module map; the inventory rejects stale exemptions. */
const EXEMPT_CODED_ERROR_MODULES: Readonly<Record<string, string>> = {
  "features/prototype/ios/iosPrototypeInstallerErrors":
    "Host installer library errors; no MCP/tool boundary until #12257 wires the installer.",
};

interface CodedErrorModule {
  module: string;
  classes: string[];
}

interface ScannedClass {
  module: string;
  name: string;
  parentName: string | undefined;
  declaresCode: boolean;
  exported: boolean;
}

type ScannedClassNode = ClassDeclaration | ClassExpression;

function declaresCode(node: ScannedClassNode): boolean {
  return node.body.body.some((member) => {
    if (member.type === "PropertyDefinition") {
      return (
        !member.computed &&
        ((member.key.type === "Identifier" && member.key.name === "code") ||
          (member.key.type === "Literal" && member.key.value === "code"))
      );
    }
    return (
      member.type === "MethodDefinition" &&
      member.kind === "constructor" &&
      member.value.params.some((parameter) => {
        if (parameter.type !== "TSParameterProperty") {
          return false;
        }
        const property =
          parameter.parameter.type === "AssignmentPattern"
            ? parameter.parameter.left
            : parameter.parameter;
        return property.type === "Identifier" && property.name === "code";
      })
    );
  });
}

/** Pure parser: collect local bases too, including variable-bound class expressions. */
function scanClasses(module: string, source: string): ScannedClass[] {
  const { program, errors } = parseSync(`${module}.ts`, source);
  if (errors.length > 0) {
    throw new Error(`${module}: ${errors[0].message}`);
  }
  const exported = new Set<ScannedClassNode>();
  const exportedNames = new Set<string>();
  const classes: { node: ScannedClassNode; name: string }[] = [];
  new Visitor({
    ExportNamedDeclaration(node) {
      if (node.declaration?.type === "ClassDeclaration") {
        exported.add(node.declaration);
      }
      if (node.declaration?.type === "VariableDeclaration") {
        for (const declaration of node.declaration.declarations) {
          if (declaration.id.type === "Identifier") {
            exportedNames.add(declaration.id.name);
          }
        }
      }
      if (!node.source && node.exportKind !== "type") {
        for (const specifier of node.specifiers) {
          exportedNames.add(specifier.local.name);
        }
      }
    },
    ExportDefaultDeclaration(node) {
      if (node.declaration.type === "ClassDeclaration") {
        exported.add(node.declaration);
      }
      if (node.declaration.type === "Identifier") {
        exportedNames.add(node.declaration.name);
      }
    },
    ClassDeclaration(node) {
      classes.push({ node, name: node.id?.name ?? "default" });
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init?.type === "ClassExpression") {
        classes.push({ node: node.init, name: node.id.name });
      }
    },
  }).visit(program);
  return classes.map(({ node, name }) => {
    const parent = node.superClass;
    const parentName =
      parent?.type === "Identifier"
        ? parent.name
        : parent?.type === "MemberExpression" &&
            !parent.computed &&
            parent.property.type === "Identifier"
          ? parent.property.name
          : undefined;
    return {
      module,
      name,
      parentName,
      declaresCode: declaresCode(node),
      exported: exported.has(node) || exportedNames.has(name),
    };
  });
}

/**
 * Resolve both Error ancestry and inherited codes across the whole scan by class name.
 * Name collisions across modules and codes assigned via Object.assign are not resolved.
 */
function codedErrorModules(
  sources: readonly { module: string; source: string }[],
): CodedErrorModule[] {
  const classes = sources.flatMap(({ module, source }) => scanClasses(module, source));
  const errors = new Set(["Error", "ActionableError"]);
  const coded = new Set(classes.filter((entry) => entry.declaresCode).map((entry) => entry.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of classes) {
      if (!entry.parentName) {
        continue;
      }
      for (const names of [errors, coded]) {
        if (names.has(entry.parentName) && !names.has(entry.name)) {
          names.add(entry.name);
          changed = true;
        }
      }
    }
  }
  const modules = new Map<string, string[]>();
  for (const entry of classes) {
    if (entry.exported && errors.has(entry.name) && coded.has(entry.name)) {
      const names = modules.get(entry.module) ?? [];
      names.push(entry.name);
      modules.set(entry.module, names);
    }
  }
  return [...modules].map(([module, names]) => ({ module, classes: names }));
}

function codedErrorModule(module: string, source: string): CodedErrorModule[] {
  return codedErrorModules([{ module, source }]);
}

function unlistedCodedErrorModules(
  inventory: readonly CodedErrorModule[],
  listed: ReadonlySet<string>,
  exempt: Readonly<Record<string, string>>,
): string[] {
  return inventory
    .filter(({ module }) => !listed.has(module) && !exempt[module]?.trim())
    .map(({ module, classes }) => `${module}: ${classes.join(", ")}`);
}

function staleCodedErrorModuleExemptions(
  inventory: readonly CodedErrorModule[],
  exempt: Readonly<Record<string, string>>,
): string[] {
  const found = new Set(inventory.map(({ module }) => module));
  return Object.keys(exempt).filter((module) => !found.has(module));
}

let codedErrorInventory: readonly CodedErrorModule[] = [];
beforeAll(() => {
  const root = join(import.meta.dir, "..", "..", "src");
  codedErrorInventory = Object.freeze(
    codedErrorModules(
      readdirSync(root, { recursive: true })
        .filter((file) => file.endsWith(".ts"))
        .map((file) => ({
          module: file.split(sep).join("/").slice(0, -3),
          source: readFileSync(join(root, file), "utf8"),
        }))
        // Inherited codes need no local code token. Declarations are parsed structurally.
        .filter(({ source }) => source.includes("extends")),
    ),
  );
});

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
  recovering?: boolean;
  externalDevices?: string[];
}

interface WirePayload {
  details?: { recovering?: boolean };
  retryAfterMs?: number;
  recovering?: boolean;
  externalDevices?: string[];
  code?: string;
  retryable?: boolean;
  nextAction?: string;
  error?: {
    retryAfterMs?: number;
    recovering?: boolean;
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
  "session_held_by_recovery",
]);

/** What a runner reads from a payload: the shape `fields` pins for the Kotlin and Swift suites. */
function readFields(payload: WirePayload): RefusalFields {
  const envelope = typeof payload.error === "object" ? payload.error : undefined;
  const retryAfterMs = envelope?.retryAfterMs ?? payload.retryAfterMs;
  const recovering = envelope?.recovering ?? payload.recovering ?? payload.details?.recovering;
  return {
    code: envelope?.code ?? payload.code,
    retryable: envelope?.retryable === true || payload.retryable === true,
    acquireNewSession: (envelope?.nextAction ?? payload.nextAction) === "acquire_new_session",
    ...(typeof retryAfterMs === "number" && retryAfterMs > 0 ? { retryAfterMs } : {}),
    ...(typeof recovering === "boolean" ? { recovering } : {}),
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
    (envelope?.recovering ?? payload.recovering ?? payload.details?.recovering) === true,
  );
}

function dispositionOf(
  code: string,
  retryable: boolean,
  nextAction: string | undefined,
  recovering = false,
): RefusalDisposition {
  if (
    WAIT_CODES.has(code) ||
    (retryable && (RETRYABLE_WAIT_CODES.has(code) || (code === "device_unhealthy" && recovering)))
  ) {
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
    brokerConnectionRefusals,
    bindingRefusals,
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

interface SurfaceFields extends Omit<RefusalFields, "retryable"> {
  retryable?: boolean;
  /** The evidence the refusal carries beside its typed fields. */
  details?: Record<string, unknown>;
  /** A broker provisioning failure's boot-capacity object. */
  capacity?: Record<string, unknown>;
  budget?: Record<string, unknown>;
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
  budget?: Record<string, unknown>;
} {
  const payload = fixture.payload as Record<string, unknown>;
  if (
    ["device-loss-outcome", "device-session-error-fields", "request-failure-fields"].includes(
      fixture.surface,
    )
  ) {
    return { typed: payload as TypedFields };
  }
  if (fixture.surface === "recording-start-result") {
    const result = fixture.payload as RefusalWireResult;
    return { typed: JSON.parse(result.content[0].text) as TypedFields };
  }
  if (fixture.surface === "proxy-tool-result") {
    const result = fixture.payload as RefusalWireResult;
    const body = JSON.parse(result.content[0].text) as { error: TypedFields };
    return { typed: body.error };
  }
  if (fixture.surface === "provision-envelope") {
    return { typed: payload.error as TypedFields };
  }
  if (fixture.surface === "liveness-handover") {
    return { typed: payload.error as TypedFields };
  }
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
    // Preserve absence of retry intent rather than inventing a boolean on this wire.
    expect(Object.hasOwn(payload, "retryable"), fixture.name).toBe(false);
    return { typed: { code: String(payload.errorCode) } };
  }
  if (fixture.surface === "press-button-result") {
    return { typed: payload as TypedFields };
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
  const result = payload as unknown as BindingsResult;
  const failure = result.bindings.find((binding) => binding.failure)?.failure ?? result.failure;
  return { typed: failure as TypedFields, capacity: failure?.capacity, budget: failure?.budget };
}

function surfaceFields(fixture: RefusalSurfaceFixture): SurfaceFields {
  const { typed, details, capacity, budget } = surfaceTyped(fixture);
  return {
    code: typed.code,
    ...(typeof typed.retryable === "boolean" ? { retryable: typed.retryable } : {}),
    acquireNewSession: typed.nextAction === "acquire_new_session",
    ...(typeof typed.retryAfterMs === "number" && typed.retryAfterMs > 0
      ? { retryAfterMs: typed.retryAfterMs }
      : {}),
    ...(details ? { details } : {}),
    ...(capacity ? { capacity } : {}),
    ...(budget ? { budget } : {}),
  };
}

const surfaceFixtures = buildRefusalSurfaceFixtures();
const capturedSurfaceFixtures = EXTERNALLY_CAPTURED_SURFACE_FIXTURES.filter(
  (fixture) => fixture.testFile !== "test/daemon/refusalWireContract.test.ts",
).map(
  (fixture) =>
    JSON.parse(
      readFileSync(join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`), "utf8"),
    ) as RefusalSurfaceFixture,
);
const allSurfaceFixtures = [...surfaceFixtures, ...capturedSurfaceFixtures];
const coveredWireCodes = new Set([
  ...fixtureCodes.map((code) => expectedWireCodes(code)[0]),
  ...surfaceFixtures.flatMap((fixture) => expectedWireCodes(fixture.name)),
  ...EXTERNALLY_CAPTURED_SURFACE_FIXTURES.flatMap((fixture) => expectedWireCodes(fixture.name)),
]);
const drivenErrorClasses = fixtureDrivenErrorClasses();
const surfaceExpectations = JSON.parse(
  readFileSync(join(REFUSAL_SURFACES_DIR, "expectations.json"), "utf8"),
) as SurfaceExpectations;

// Capture private production builders through their registered public handlers, using only fakes.
const ownedSurfaceFixtures: RefusalSurfaceFixture[] = [];
beforeAll(async () => {
  const registration = spyOn(Server.prototype, "setRequestHandler");
  let harness: ReturnType<typeof createProxyMcpServer>;
  let registrations: typeof registration.mock.calls;
  try {
    harness = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        clientFactory: () => new FakeDaemonClient(),
        daemonManager: new FakeDaemonManager(),
        daemonAvailabilityProbe: async () => true,
        autoStartDaemon: false,
      },
    });
    registrations = [...registration.mock.calls];
  } finally {
    registration.mockRestore();
  }
  const handler = registrations.find(([schema]) => schema === CallToolRequestSchema)?.[1];
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    if (!handler) {
      throw new Error("Missing tools/call handler");
    }
    const cases = [
      [
        "session_ownership_lost.expired",
        new daemonProxy.DaemonBoundSessionExpiredError(
          "11111111-2222-4333-8444-555555555555",
          "explicit-release",
        ),
      ],
      ["daemon_shutting_down", new daemonClient.DaemonShuttingDownError()],
    ] as const;
    for (const [name, error] of cases) {
      const call = spyOn(harness.proxy, "callTool").mockRejectedValue(error);
      try {
        ownedSurfaceFixtures.push({
          surface: "proxy-tool-result",
          name,
          builder: "createProxyMcpServer tools/call via resolveCallToolErrorResult",
          payload: await handler(
            { method: "tools/call", params: { name: "tapOn" } },
            {
              signal: new AbortController().signal,
              requestId: 1,
              sendNotification: async () => {},
              sendRequest: async () => {
                throw new Error("Unexpected request");
              },
            },
          ),
        });
      } finally {
        call.mockRestore();
      }
    }
    const sessionUuid = "11111111-2222-4333-8444-555555555555";
    const loss = new daemonClient.DaemonBoundSessionLostError({
      code: "bound_session_lost",
      sessionUuid,
      reason: "daemon-shutdown",
    });
    const lossClient = new FakeDaemonClient({
      onCallTool: () => {
        throw loss;
      },
    });
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: daemonConstants.DAEMON_VERSION };
    const lossHarness = createProxyMcpServer({
      proxyConfig: {
        initialSessionUuid: sessionUuid,
        timer: new FakeTimer(),
        clientFactory: () => lossClient,
        daemonManager: manager,
        daemonAvailabilityProbe: async () => true,
        autoStartDaemon: false,
        buildIdentity: { entryScript: "", buildId: "fixture-build" },
      },
    });
    // Reuse the same registered server boundary while the real proxy fences the bound loss.
    const forward = spyOn(harness.proxy, "callTool").mockImplementation((name, args, options) =>
      lossHarness.proxy.callTool(name, args, options),
    );
    try {
      const payload = await handler(
        {
          method: "tools/call",
          params: { name: "observe", arguments: { deviceId: "emulator-5554" } },
        },
        {
          signal: new AbortController().signal,
          requestId: 1,
          sendNotification: async () => {},
          sendRequest: async () => {
            throw new Error("Unexpected request");
          },
        },
      );
      expect(lossClient.callToolCalls).toHaveLength(1);
      ownedSurfaceFixtures.push({
        surface: "proxy-tool-result",
        name: "session_ownership_lost.bound_loss",
        builder: "DaemonMcpProxy bound loss via createProxyMcpServer tools/call",
        payload,
      });
    } finally {
      forward.mockRestore();
      await lossHarness.server.close();
      await lossHarness.proxy.close();
    }
  } finally {
    warn.mockRestore();
    await harness.server.close();
    await harness.proxy.close();
  }
  for (const fixture of ownedSurfaceFixtures) {
    if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
      writeFileSync(
        join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`),
        serializeRefusalSurfaceFixture(fixture),
      );
    }
    allSurfaceFixtures.push(fixture);
  }
});

describe("refusal wire contract", () => {
  test("#12112 all health refusal variants have typed payloads without a new-session remedy", () => {
    for (const stem of [
      "device_unhealthy",
      "device_unhealthy.recovering_unbounded",
      "device_unhealthy.permanent",
      "device_unhealthy.all_candidates",
    ]) {
      const fixture = fixtures.find((fixture) => fixture.code === stem)!;
      const payload = JSON.parse(fixture.result.content[0].text);
      expect(payload).toMatchObject({
        success: false,
        error: expect.any(String),
        code: "device_unhealthy",
        recovering: stem !== "device_unhealthy.permanent",
        retryable: stem !== "device_unhealthy.permanent",
      });
      expect(Array.isArray(payload.devices)).toBe(true);
      expect(payload).not.toHaveProperty("nextAction");
      expect(acquisitionRefusals.RETRYABLE_DEVICE_ACQUISITION_CODES.has(payload.code)).toBe(false);
      if (stem.endsWith("all_candidates")) {
        expect(payload).not.toHaveProperty("deviceId");
        expect(payload).not.toHaveProperty("reason");
        expect(payload.devices).toEqual([
          {
            deviceId: "emulator-5554",
            reason: "network-condition",
            recovering: true,
            retryAfterMs: 12863,
          },
          { deviceId: "emulator-5556", reason: "app-cleanup", recovering: false },
        ]);
      } else {
        expect(payload.deviceId).toBe("emulator-5554");
        expect(payload.reason).toBe("network-condition");
        expect(payload.devices).toHaveLength(1);
      }
      if (stem === "device_unhealthy" || stem.endsWith("all_candidates")) {
        expect(payload.retryAfterMs).toBe(12863);
      } else {
        expect(payload).not.toHaveProperty("retryAfterMs");
      }
    }
    expect(drivenErrorClasses.has(acquisitionRefusals.DeviceUnhealthyError)).toBe(true);
    expect(
      isTypedToolRefusal(
        new acquisitionRefusals.DeviceUnhealthyError(
          [{ deviceId: "device", reason: "future-reason", recovering: false }],
          "unhealthy",
        ),
      ),
    ).toBe(true);
  });

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

  test("unhealthy corpus waits exactly while recovering and retryable", () => {
    const outcomes = new Set<string>();
    for (const fixture of fixtures) {
      const payload = JSON.parse(fixture.result.content[0].text) as WirePayload;
      const fields = readFields(payload);
      if (fields.code !== "device_unhealthy") {
        continue;
      }
      const disposition = deriveDisposition(payload);
      expect(disposition === "wait").toBe(fields.recovering === true && fields.retryable === true);
      outcomes.add(disposition);
    }
    expect(outcomes).toEqual(new Set(["wait", "fail"]));
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

  test("every source module declaring an exported coded Error class is classified", () => {
    expect(
      unlistedCodedErrorModules(
        codedErrorInventory,
        new Set(Object.keys(refusalErrorModules)),
        EXEMPT_CODED_ERROR_MODULES,
      ),
    ).toEqual([]);
  });

  test("coded module exemptions have reasons and never outlive their declarations", () => {
    expect(
      staleCodedErrorModuleExemptions(codedErrorInventory, EXEMPT_CODED_ERROR_MODULES),
    ).toEqual([]);
    expect(
      Object.entries(EXEMPT_CODED_ERROR_MODULES).filter(
        ([module, reason]) => !reason.trim() || Object.hasOwn(refusalErrorModules, module),
      ),
    ).toEqual([]);
  });

  test("the module checker detects a new coded refusal and a stale exemption", () => {
    const inventory = codedErrorModule(
      "new/refusal",
      `export class NewRefusal extends ActionableError {
      constructor(public readonly code: string = "new_refusal") { super(code); }
    }`,
    );
    expect(
      unlistedCodedErrorModules(inventory, new Set(Object.keys(refusalErrorModules)), {}),
    ).toEqual(["new/refusal: NewRefusal"]);
    expect(unlistedCodedErrorModules(inventory, new Set(["new/refusal"]), {})).toEqual([]);
    expect(unlistedCodedErrorModules(inventory, new Set(), { "new/refusal": "" })).toEqual([
      "new/refusal: NewRefusal",
    ]);
    expect(
      unlistedCodedErrorModules(inventory, new Set(), { "new/refusal": "non-wire code" }),
    ).toEqual([]);
    expect(staleCodedErrorModuleExemptions(inventory, { removed: "process exit code" })).toEqual([
      "removed",
    ]);
    expect(
      staleCodedErrorModuleExemptions(
        codedErrorModule("new/refusal", "export class NewRefusal extends Error {}"),
        { "new/refusal": "process exit code" },
      ),
    ).toEqual(["new/refusal"]);
  });

  test.each([
    {
      name: "a coded superclass in another module",
      source: "export class MutInherited extends InputDeviceOwnedError {}",
      className: "MutInherited",
    },
    {
      name: "a transitive local superclass without an Error suffix",
      source:
        "class LocalBase extends InputDeviceOwnedError {} export class MutLocal extends LocalBase {}",
      className: "MutLocal",
    },
    {
      name: "an exported class expression",
      source: 'export const X = class extends ActionableError { readonly code = "x"; };',
      className: "X",
    },
  ])("the module checker detects $name", ({ source, className }) => {
    const inventory = codedErrorModules([
      { module: "mutation", source },
      {
        module: "daemon/inputDeviceOwnership",
        source:
          'export class InputDeviceOwnedError extends ActionableError { readonly code = "owned"; }',
      },
      { module: "negative", source: 'export class NotAnError { readonly code = "ordinary"; }' },
    ]);
    expect(
      unlistedCodedErrorModules(inventory, new Set(Object.keys(refusalErrorModules)), {}),
    ).toEqual([`mutation: ${className}`]);
  });

  test("the module scanner covers properties, parameter properties and exported aliases", () => {
    expect(
      codedErrorModule(
        "variants",
        `
      export class Own extends Error { readonly code = "own"; }
      export class Parameter extends ActionableError { constructor(readonly code: string) { super(code); } }
      class Alias extends Error { "code" = "alias"; } export { Alias as Refusal };
      export default class extends ns.Error { code = "default"; }
      class Local extends Error { code = "local"; }
      export class Uncoded extends Error { constructor(code: string) { super(code); } }
      export class Other extends Object { code = "other"; }
      // export class Comment extends Error { code = "comment"; }
      const text = 'export class Text extends Error { code = "text"; }';
    `,
      ),
    ).toEqual([{ module: "variants", classes: ["Own", "Parameter", "Alias", "default"] }]);
    expect(() => codedErrorModule("broken", "export class Broken extends Error { code =")).toThrow(
      "broken:",
    );
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
        "plan lock",
        () => new planLockRefusal.PlanExecutionInProgressError("session"),
        "plan_execution_in_progress",
        true,
        undefined,
      ],
      [
        "device ambiguity",
        () =>
          new ambiguousTargetRefusal.AmbiguousDeviceTargetError("Choose a device.", [
            { deviceId: "ios-a", platform: "ios" },
          ]),
        "ambiguous_device_target",
        false,
        undefined,
      ],
      [
        "creation release",
        () => new acquisitionRefusals.SessionReleasedDuringCreationError(SESSION),
        "session_released_during_creation",
        false,
        "acquire_new_session",
      ],
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

    test("plan lock has no invented holder or retry deadline on any wire", () => {
      const error = new planLockRefusal.PlanExecutionInProgressError("global");
      expect(error).not.toHaveProperty("retryAfterMs");
      expect(error.toPayload()).toEqual({
        code: "plan_execution_in_progress",
        retryable: true,
        scope: "global",
      });
      expect(new planLockRefusal.PlanExecutionInProgressError().toPayload()).toEqual({
        code: "plan_execution_in_progress",
        retryable: true,
      });
      expect(mcpRequestFailureDetails(error, undefined)).toMatchObject({
        code: error.code,
        retryable: true,
        details: { scope: "global" },
      });
      expect(mcpRequestFailureDetails(error, undefined)).not.toHaveProperty("retryAfterMs");
      expect(planRefusalFields(error)).toEqual({
        code: error.code,
        retryable: true,
        scope: "global",
      });
    });

    test("candidate evidence crosses all three wires without device names or session ids", () => {
      const candidates = [
        { deviceId: "ios-a", platform: "ios", name: "private name", sessionUuid: "other-holder" },
      ];
      const error = new ambiguousTargetRefusal.AmbiguousDeviceTargetError(
        "Choose a device.",
        candidates,
      );
      const payload = {
        code: "ambiguous_device_target",
        retryable: false,
        candidates: [{ deviceId: "ios-a", platform: "ios" }],
      };
      expect(error.toPayload()).toEqual(payload);
      expect(JSON.parse(shapedRefusalResult(error).content[0].text)).toMatchObject(payload);
      expect(mcpRequestFailureDetails(error, undefined).details).toEqual({
        candidates: payload.candidates,
      });
      expect(planRefusalFields(error)).toEqual(payload);
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
        for (const fixture of [...surfaceFixtures, ...ownedSurfaceFixtures]) {
          writeFileSync(
            join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`),
            serializeRefusalSurfaceFixture(fixture),
          );
        }
      }
      for (const fixture of [...surfaceFixtures, ...ownedSurfaceFixtures]) {
        const path = join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`);
        expect(existsSync(path), `${path}; regenerate with UPDATE_CAPTURED_FIXTURES=1`).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(serializeRefusalSurfaceFixture(fixture));
      }
    });

    test("new surfaces carry their named code without inventing retry intent", () => {
      const addedSurfaces = new Set([
        "device-loss-outcome",
        "device-session-error-fields",
        "recording-start-result",
        "proxy-tool-result",
        "request-failure-fields",
        "liveness-handover",
        "provision-envelope",
      ]);
      for (const fixture of allSurfaceFixtures.filter((fixture) =>
        addedSurfaces.has(fixture.surface),
      )) {
        expect([surfaceTyped(fixture).typed.code], surfaceFixtureStem(fixture)).toEqual(
          expectedWireCodes(fixture.name),
        );
      }
      expect(ownedSurfaceFixtures.map(surfaceFixtureStem).sort()).toEqual(
        EXTERNALLY_CAPTURED_SURFACE_FIXTURES.filter(
          (fixture) => fixture.testFile === "test/daemon/refusalWireContract.test.ts",
        )
          .map(surfaceFixtureStem)
          .sort(),
      );
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
            fields.retryable === true,
            fields.acquireNewSession ? "acquire_new_session" : undefined,
            (fields.recovering ?? fields.details?.recovering) === true,
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
          "device_outside_broker_grant",
          "device_assigned_to_binding",
        ]),
      );
      expect(names("delete-device")).toEqual(
        expect.arrayContaining(["device_owned_by_other_daemon", "discovery_incomplete"]),
      );
    });
  });
});
