import { beforeAll, describe, expect, test } from "bun:test";

import { fileURLToPath } from "node:url";
import ts from "typescript";
import { relativePosix, typeScriptFiles, readGuardFile } from "./astGuard";
import { scanNamedCallOwners, scanNamedCalls } from "./recordHeartbeatCallers";

const source = ts.createSourceFile(
  "sessionManager.ts",
  readGuardFile(new URL("../../src/daemon/sessionManager.ts", import.meta.url)),
  ts.ScriptTarget.Latest,
  true,
);
const manager = source.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "SessionManager",
);
if (!manager) {
  throw new Error("SessionManager class not found");
}
const methods = manager.members.filter(ts.isMethodDeclaration);

function collaboratorMethods(file: string, name: string): ts.MethodDeclaration[] {
  const collaborator = ts.createSourceFile(
    file,
    readGuardFile(new URL(`../../src/daemon/sessionManager/${file}`, import.meta.url)),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = collaborator.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) {
    throw new Error(`${name} class not found`);
  }
  return declaration.members.filter(ts.isMethodDeclaration);
}

const admissionMethods = collaboratorMethods("admission.ts", "SessionAdmission");
const recoveryMethods = collaboratorMethods("recoveryPublication.ts", "SessionRecoveryPublication");

// Retained expireIfDue paths use this.getSession to preserve instance patches (#12581).
// Counts must shrink with migrations; adding a reader requires an explicit expiry decision.
const RETAINED_EXPIRY_READERS: Readonly<Record<string, number>> = {
  // Live facade wiring; the target remains checked in recoveryPublication.
  createCollaboratorHost: 1,
  recoverPersistedRow: 1,
};

// The liveness lease and policy moved to SessionLivenessController (#11797). Its lookups reach
// SessionManager.getSession through `this.port.getSession` (an expiring lookup, as they were in
// class); the same per-method counts hold, and none may become findSession.
const RETAINED_LIVENESS_EXPIRY_READERS: Readonly<Record<string, number>> = {
  recordHeartbeat: 1,
  claimLivenessOwnership: 2,
  releaseLivenessOwnership: 2,
  hasLivenessOwnership: 1,
  claimUnownedLivenessOwnership: 1,
  adoptCliLivenessPolicy: 1,
  adoptManagedExecutionLivenessPolicy: 1,
  restoreHeartbeatLivenessPolicy: 1,
};

function callsIn(method: ts.MethodDeclaration, onlyThis = false): string[] {
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (
          !onlyThis ||
          callee.expression.kind === ts.SyntaxKind.ThisKeyword ||
          callee.expression.getText(method.getSourceFile()) === "this.host"
        ) {
          calls.push(callee.name.text);
        }
      } else if (
        ts.isElementAccessExpression(callee) &&
        ts.isStringLiteral(callee.argumentExpression) &&
        (!onlyThis || callee.expression.kind === ts.SyntaxKind.ThisKeyword)
      ) {
        calls.push(callee.argumentExpression.text);
      } else if (!onlyThis && ts.isIdentifier(callee)) {
        calls.push(callee.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (method.body) {
    visit(method.body);
  }
  return calls;
}

test("findSession contains no release or execution-cancellation call", () => {
  const find = admissionMethods.find((method) => method.name.getText() === "findSession");
  expect(find?.body).toBeDefined();
  if (!find?.body) {
    throw new Error("findSession body not found");
  }
  const forbidden = new Set([
    "releaseExpiredSessionLazily",
    "releaseSessionPastIdleDeadline",
    "releaseSession",
    "releaseSessionForReason",
    "cancelExecutionsOverriddenByExpiry",
  ]);
  expect(callsIn(find).filter((name) => forbidden.has(name))).toEqual([]);
});

test.each(["findSession", "expireIfDue"])("%s stays synchronous", (name) => {
  const owners = name === "findSession" ? admissionMethods : methods;
  const method = owners.find((method) => method.name.getText() === name);
  expect(method?.body).toBeDefined();
  expect(
    method?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
  ).toBe(false);
  expect(method && callsIn(method)).not.toContain("then");
});

test("in-class getSession calls stay within the retained expiry reader inventory", () => {
  const actual = Object.fromEntries(
    [...methods, ...recoveryMethods].flatMap((method) => {
      if (method.name.getText().includes("CollaboratorActions")) {
        return [];
      }
      const count = callsIn(method, true).filter((name) => name === "getSession").length;
      return count ? [[method.name.getText(), count]] : [];
    }),
  );
  expect(actual).toEqual(RETAINED_EXPIRY_READERS);
});

test("the liveness controller's port getSession calls stay within the retained expiry reader inventory", () => {
  const controllerSource = ts.createSourceFile(
    "sessionLivenessLease.ts",
    readGuardFile(new URL("../../src/daemon/sessionLivenessLease.ts", import.meta.url)),
    ts.ScriptTarget.Latest,
    true,
  );
  const controller = controllerSource.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === "SessionLivenessController",
  );
  expect(controller).toBeDefined();
  const counts: Record<string, number> = {};
  const visitMethod = (name: string, node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "getSession" &&
      node.expression.expression.getText(controllerSource) === "this.port"
    ) {
      counts[name] = (counts[name] ?? 0) + 1;
    }
    ts.forEachChild(node, (child) => visitMethod(name, child));
  };
  for (const member of controller?.members ?? []) {
    if (ts.isMethodDeclaration(member) && member.body) {
      visitMethod(member.name.getText(controllerSource), member.body);
    }
  }
  expect(counts).toEqual(RETAINED_LIVENESS_EXPIRY_READERS);
});

// Expiring `getSession(` calls left in src/server (#12581). Each is a mutation, release path,
// identity compare or routing/admission site where lazy expiry is observable; pure device reads
// use findSession. Keyed by `file#enclosing function` so a sanctioned call and a pure reader
// cannot trade places within a file. Counts may only shrink; a new pure reader must call
// findSession.
const RETAINED_SERVER_EXPIRY_READERS: Readonly<Record<string, number>> = {
  "deviceLabelMapping.ts#releaseDeviceLabelSessions": 1,
  "deviceToolsBootPreparation.ts#callerMayReuse": 1,
  "pipeline/deviceCallDispatch.ts#refuseControlCallBeforeAdmission": 1,
  "pipeline/ingress/executeToolCall.ts#foreignOwnedExplicitSessionUuid": 1,
  "pipeline/ingress/routing.ts#admittedSessionDevice": 1,
  "pipeline/planLifecycle.ts#getCleanupDevices": 1,
  "pipeline/planLifecycle.ts#releasePlanBaseSession": 1,
  "planDeviceOwnership.ts#ownsDevice": 1,
  "planExecutionOrchestrator.ts#brokerGrantedLabelDevices": 1,
  "planExecutionOrchestrator.ts#buildDeviceMapping": 1,
  "sessionAppLinks.ts#runSessionAppLinksMutation": 1,
  "sessionBiometricEnrollment.ts#runSessionBiometricMutation": 1,
  "sessionClock.ts#runSessionClockMutation": 1,
  "sessionLocation.ts#createSessionLocationAppliedCallback": 2,
  "sessionLocation.ts#createSessionLocationWriteAdmission": 1,
  "sessionLocation.ts#getLiveSessionLocationWrite": 1,
  "sessionLocation.ts#runSessionLocationMutation": 1,
  "sessionDisplayProfile.ts#runSessionDisplayProfileMutation": 1,
  "sessionKeyboardProfile.ts#runSessionKeyboardProfileMutation": 1,
  "sessionPersona.ts#runSessionPersonaMutation": 1,
  "sessionKillProfile.ts#runSessionKillProfileMutation": 1,
  "sessionNetworkCondition.ts#runSessionNetworkMutation": 1,
  "sessionRotation.ts#runSessionRotationMutation": 1,
  "sessionScreenLock.ts#createSessionScreenLockMutation": 1,
  "sessionScreenLock.ts#isLiveOn": 1,
  "sessionScreenReader.ts#runSessionScreenReaderMutation": 1,
  "sessionStatusBar.ts#runSessionStatusBarMutation": 1,
  "sessionSensor.ts#runSessionSensorMutation": 1,
  "setActiveDevice.ts#admitSessionlessSelection": 1,
  "setActiveDevice.ts#assertDeviceOwner": 1,
  "setActiveDevice.ts#bindRequestedDevice": 1,
  "setActiveDevice.ts#refuseForeignOwnedSession": 1,
  "setActiveDevice.ts#restorePriorDisplayPin": 1,
};

const SERVER_DIR = fileURLToPath(new URL("../../src/server/", import.meta.url));
const FEATURES_DIR = fileURLToPath(new URL("../../src/features/", import.meta.url));
const DAEMON_DIR = fileURLToPath(new URL("../../src/daemon/", import.meta.url));
// Parsing the whole src/server tree can exceed Bun's default hook limit on loaded runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;

// `getSession(` calls in src/daemon outside SessionManager and the liveness controller (#12581),
// keyed by `file#enclosing function`. Counts include non-manager receivers (persistence and
// broker stores) and are a pre-triage baseline: each call site is an admission, binding, routing
// or release path where lazy expiry may be observable until a pure reader is proven and moved to
// findSession (a migrated site drops out, as the appearance sweep did). Counts may only shrink;
// a new pure reader must call findSession, a new admission site needs an explicit entry here.
const RETAINED_DAEMON_EXPIRY_READERS: Readonly<Record<string, number>> = {
  "webrtcStreamManager.ts#isDaemonSessionLive": 1,
  // These factories moved from SessionManager; retain each expiring call, including the row read.
  "sessionManager/construction.ts#getSession": 1,
  "sessionManager/wiring.ts#getSession": 1,
  "sessionManager/wiring.ts#readSessionRow": 1,
  "sessionManager/recoveryPublication.ts#recoverPersistedRow": 1,
  "sessionManager/recoveredTerminalReleaseIntents.ts#applyRecoveredTerminalReleaseIntents": 1,
  "setupTiming.ts#consumeSetupTiming": 1,
  "setupTiming.ts#storeSetupTiming": 1,
  "adbServerResetQuarantine.ts#detachAdbServerResetCohort": 1,
  "adbServerResetQuarantine.ts#getAdbResetRecoverySession": 1,
  "adbServerResetQuarantine.ts#getAdbServerResetCohortSessionTargets": 1,
  "adbServerResetQuarantine.ts#settleFailedAdbResetCohortPreparation": 1,
  "cli/runDaemonCommand.ts#recordLocalDaemonHeartbeat": 1,
  "cli/runDaemonCommand.ts#requireDaemonSession": 1,
  "daemonCore/disconnectTargets.ts#captureDisconnectCleanup": 1,
  "daemonCore/persistedSessionReaders.ts#getPersistedSession": 1,
  "daemonCore/persistedSessionReaders.ts#getSession": 1,
  "daemonCore/disconnectTargets.ts#isCapturedDisconnectTargetCurrent": 1,
  "daemonCore/managedExecutionWarmup.ts#verifyIosDevice": 1,
  "daemonCore/managedExecutionWarmup.ts#warmConfirmedManagedExecution": 1,
  "daemonRequestHandlers.ts#grantedDeviceOf": 1,
  "daemonRequestHandlers.ts#handleReleaseSession": 1,
  "daemonRequestHandlers.ts#releaseSessionOwnerRefusal": 1,
  "daemonRequestHandlers.ts#releaseUnknownSession": 1,
  "derivedLabelSessionReleaseCascade.ts#releaseDerived": 1,
  "deviceAllocation.ts#claimSelectedDeviceForSession": 1,
  "deviceAutolockManager.ts#adoptResumedAutolockSession": 1,
  "deviceAutolockManager.ts#attachAutolockSessionToMcpSession": 1,
  "deviceAutolockManager.ts#getOwnedAutolockSession": 1,
  "deviceAutolockManager.ts#throwIfFreshStartAlreadyBound": 1,
  "devicePoolParts/allocationHealth.ts#assertDeviceCleanupComplete": 1,
  "devicePoolParts/reservations.ts#assertNotPreparedForOtherRequest": 1,
  "devicePoolParts/status.ts#assertSessionReadyForAutomation": 1,
  "devicePoolParts/androidRecovery.ts#bindRecoveredAndroidDeviceSession": 1,
  "devicePoolParts/androidRecovery.ts#consumeAndroidRecoveryCancellation": 1,
  "devicePoolParts/release.ts#createSessionAndCommit": 1,
  "devicePoolParts/androidRecovery.ts#detachSessionForAndroidRecovery": 1,
  "devicePoolParts/multiAllocation.ts#deviceHeldByExistingSession": 1,
  "devicePoolParts/initialization.ts#getSession": 3,
  "devicePoolParts/sessionRecovery.ts#getSessionPreservingRecoveryTarget": 1,
  "devicePoolParts/release.ts#isSessionAssignmentCurrent": 1,
  "devicePoolParts/connectionSessions.ts#isSessionOwnedByOtherConnection": 2,
  "devicePoolParts/connectionSessions.ts#liveOwnershipSession": 1,
  "devicePoolParts/androidRecovery.ts#rebindSameAvdReplacementSession": 1,
  "devicePoolParts/sessionRecovery.ts#releaseDisconnectedRecoverySessionWithRetry": 1,
  "devicePoolParts/connectionSessions.ts#resolveOwnedDeviceSessionForMcpSession": 1,
  "devicePoolParts/presence.ts#restartReleaseReasonForIdentityReplacement": 1,
  "devicePoolParts/connectionSessions.ts#restartReservationOwnerToken": 1,
  "devicePoolParts/connectionSessions.ts#restoreOwnedDeviceSessionsUnderBindClaim": 1,
  "devicePoolParts/release.ts#rollbackAssignments": 2,
  "devicePoolParts/presence.ts#tryPreserveSessionForMissingDevice": 1,
  "deviceReplacement.ts#restoreSystemUiAnrRecoverySession": 1,
  "deviceReplacement.ts#rollbackSystemUiAnrRecoveryReplacement": 1,
  "deviceReplacement.ts#systemUiAnrRecoverySession": 1,
  "deviceReplacement.ts#validateSystemUiAnrRecoverySession": 1,
  "deviceReservations.ts#assertReadinessReservationOwner": 1,
  "emulatorLossIncidentLedger.ts#buildEmulatorLossRecoverySettlement": 1,
  "emulatorLossIncidentLedger.ts#captureEmulatorLossSession": 1,
  "emulatorProcessLifecycle.ts#evictStartedDeviceAfterProcessExit": 2,
  "explicitDeviceBind.ts#assignDeviceToBoundSession": 1,
  "explicitDeviceBind.ts#claimExplicitlyBoundDevice": 1,
  "explicitDeviceBind.ts#operation": 1,
  "explicitDeviceBind.ts#restoreUndeliveredRebind": 2,
  "httpHeartbeat.ts#handleHttpHeartbeat": 1,
  "ownerDisconnectRelease.ts#afterAttempt": 1,
  "ownerDisconnectRelease.ts#fire": 1,
  "ownerDisconnectRelease.ts#ownerDisconnected": 1,
  "sessionBroker/broker.ts#commitOwnerExit": 1,
  "sessionBroker/broker.ts#hasActiveSession": 1,
  "sessionBroker/broker.ts#ownedSessionRequest": 1,
  "sessionBroker/provisioning/executionReleaseContracts.ts#deviceOf": 1,
  "sessionBroker/service.ts#recoverSessionMutationRecorder": 1,
  "sessionBroker/sessionDisposition.ts#sessionDisposition": 1,
  "sessionClockPersistence.ts#getSession": 1,
  "sessionForIngress.ts#sessionForIngress": 1,
  "socketServerParts/McpBindings.ts#getAssignedDeviceForSession": 1,
  "socketServerParts/McpBindings.ts#getSessionIncarnation": 1,
  "socketServer/inputDeviceGating.ts#grantedDeviceOf": 1,
  "socketServerParts/McpBindings.ts#hasActiveDaemonSession": 1,
  "socketServer/inputDeviceGating.ts#selectInputTargetDevice": 1,
};

// src/features: the one remaining reader consumes the session object and, when it is expired,
// relies on the lazy release to take the "no session" branch (#12581).
const RETAINED_FEATURES_EXPIRY_READERS: Readonly<Record<string, number>> = {
  "deviceLifecycle/readiness/readiness.ts#createSystemUiAnrRebooter": 1,
};

function scanGetSession(source: string): { line: number }[] {
  return scanNamedCalls("fixture.ts", source, "getSession");
}

describe("getSession call detection", () => {
  test.each([
    "m.getSession(id);",
    "m.getSession?.(id);",
    'm["getSession"](id);',
    "m[`getSession`](id);",
    "m.getSession!(id);",
    "(m.getSession)(id);",
    "m.getSession.call(m, id);",
    "m.getSession.apply(m, [id]);",
    "m.getSession.bind(m)(id);",
  ])("counts: %s", (source) => {
    expect(scanGetSession(source)).toEqual([{ line: 1 }]);
  });

  test.each([
    "m.findSession(id);",
    "m.getSessionForNewExecution(id);",
    'const s = "m.getSession(id)";',
    "// m.getSession(id);",
    "const r = /m.getSession(id)/;",
    "class Fake { getSession(id: string) {} }",
    "expect(m.getSession).toHaveBeenCalled();",
  ])("ignores: %s", (source) => {
    expect(scanGetSession(source)).toEqual([]);
  });
});

describe("getSession call owners", () => {
  test.each([
    ["function f() { m.getSession(id); }", "f"],
    ["class C { run() { m.getSession(id); } }", "run"],
    ["class C { run = () => m.getSession(id); }", "run"],
    ["const g = () => m.getSession(id);", "g"],
    ["const o = { h() { return m.getSession(id); } };", "h"],
    ["function outer() { const inner = () => m.getSession(id); }", "inner"],
    ["m.getSession(id);", "<module>"],
  ])("%s -> %s", (source, owner) => {
    expect(scanNamedCallOwners("fixture.ts", source, "getSession")).toEqual([owner]);
  });
});

describe("src/server expiring getSession readers", () => {
  let actual: Record<string, number> = {};

  beforeAll(() => {
    actual = {};
    for (const file of typeScriptFiles(SERVER_DIR)) {
      const text = readGuardFile(file);
      if (!text.includes("getSession")) {
        continue;
      }
      for (const owner of scanNamedCallOwners(file, text, "getSession")) {
        const key = `${relativePosix(SERVER_DIR, file)}#${owner}`;
        actual[key] = (actual[key] ?? 0) + 1;
      }
    }
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("calls stay within the retained expiry reader inventory", () => {
    expect(actual).toEqual(RETAINED_SERVER_EXPIRY_READERS);
  });
});

describe("src/daemon expiring getSession readers", () => {
  let actual: Record<string, number> = {};

  beforeAll(() => {
    actual = {};
    for (const file of typeScriptFiles(DAEMON_DIR)) {
      const relative = relativePosix(DAEMON_DIR, file);
      if (relative === "sessionManager.ts" || relative === "sessionLivenessLease.ts") {
        continue;
      }
      const text = readGuardFile(file);
      if (!text.includes("getSession")) {
        continue;
      }
      for (const owner of scanNamedCallOwners(file, text, "getSession")) {
        const key = `${relative}#${owner}`;
        actual[key] = (actual[key] ?? 0) + 1;
      }
    }
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("calls stay within the retained expiry reader inventory", () => {
    expect(actual).toEqual(RETAINED_DAEMON_EXPIRY_READERS);
  });
});

describe("src/features expiring getSession readers", () => {
  let actual: Record<string, number> = {};

  beforeAll(() => {
    actual = {};
    for (const file of typeScriptFiles(FEATURES_DIR)) {
      const text = readGuardFile(file);
      if (!text.includes("getSession")) {
        continue;
      }
      for (const owner of scanNamedCallOwners(file, text, "getSession")) {
        const key = `${relativePosix(FEATURES_DIR, file)}#${owner}`;
        actual[key] = (actual[key] ?? 0) + 1;
      }
    }
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("calls stay within the retained expiry reader inventory", () => {
    expect(actual).toEqual(RETAINED_FEATURES_EXPIRY_READERS);
  });
});
