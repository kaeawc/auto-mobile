import { fakeServerContext } from "../helpers/fakeServerContext";
import { Server } from "@modelcontextprotocol/server";
import * as prototypeHidden from "../../src/features/prototype/prototypeHidden";
import * as prototypeSuspended from "../../src/features/prototype/prototypeSuspended";
import { isTypedToolRefusal } from "../../src/daemon/shapeToolCallError";
import * as directSessionNotActive from "../../src/models/DirectSessionNotActiveError";
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { parseSync, Visitor, type Class } from "oxc-parser";
import type { ServerContext } from "@modelcontextprotocol/server";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
import * as hostBootRegistry from "../../src/features/bootAdmission/HostBootAdmissionRegistry";
import * as downloadsRefusals from "../../src/server/downloadsFixtureService";
import * as downloadsStageRefusal from "../../src/server/StageSessionDownloadsRefusal";
import * as adbHealth from "../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import * as deviceLost from "../../src/models/DeviceLostError";
import * as bindingConfig from "../../src/daemon/sessionBroker/provisioning/provisionRequest";
import * as bindingRefusals from "../../src/daemon/sessionBroker/provisioning/refusal";
import * as bindingDiscoveryIncompleteErrorModule from "../../src/daemon/sessionBroker/provisioning/BindingDiscoveryIncompleteError";
import * as bindingRegistrySchemaUnsupportedErrorModule from "../../src/daemon/sessionBroker/provisioning/BindingRegistrySchemaUnsupportedError";
import * as bindingOwnershipLostErrorModule from "../../src/daemon/sessionBroker/provisioning/BindingOwnershipLostError";
import * as bindingOwnershipUnconfirmedErrorModule from "../../src/daemon/sessionBroker/provisioning/BindingOwnershipUnconfirmedError";
import * as sessionConfig from "../../src/devices/sessionConfig";
import * as discoveryRefusals from "../../src/models/BootedDeviceDiscoveryIncompleteError.base";
import * as androidDiscoveryRefusals from "../../src/models/AndroidBootedDeviceDiscoveryIncompleteError";
import * as androidAvdIdentityConflict from "../../src/devices/AndroidAvdIdentityConflictError";
import * as androidIdentityUnresolved from "../../src/devices/AndroidIdentityUnresolvedError";
import * as androidDeviceIdentityUnresolved from "../../src/devices/AndroidDeviceIdentityUnresolvedError";
import * as androidAvdIdentityUnresolved from "../../src/devices/AndroidAvdIdentityUnresolvedError";
import * as shutdownTimeout from "../../src/models/DeviceShutdownTimeoutError";
import * as iosHomeLaunchTimeout from "../../src/models/IosHomeLaunchTimeoutError";
import * as sdkCapabilityQuery from "../../src/features/observe/ios/SdkCapabilityQueryError";
import * as recoveryAssignment from "../../src/models/SessionRecoveryAssignmentError";
import * as streamPolicy from "../../src/daemon/streamSubscriptionPolicy";
import * as namespaceGuard from "../../src/daemon/sharedNamespaceGuard";
import * as restartAdmission from "../../src/daemon/daemonRestartAdmission";
import * as restartPending from "../../src/daemon/daemonRestartPending";
import * as deviceSessionResolver from "../../src/daemon/deviceSessionResolver";
import * as orphanRecorderRefusal from "../../src/daemon/orphanRecorderRefusal";
import * as recordingAdmission from "../../src/daemon/deviceGestureRecordingStartAdmission";
import * as handoffInterruption from "../../src/daemon/daemonHandoffInterruption";
import * as daemonProxy from "../../src/daemon/daemonMcpProxy";
import * as nsDaemonAmbiguousSessionSelectorError from "../../src/daemon/proxy/DaemonAmbiguousSessionSelectorError";
import * as nsDaemonAssetVersionMismatchError from "../../src/daemon/proxy/DaemonAssetVersionMismatchError";
import * as nsDaemonBoundSessionExpiredError from "../../src/daemon/proxy/DaemonBoundSessionExpiredError";
import * as nsDaemonBuildMismatchError from "../../src/daemon/proxy/DaemonBuildMismatchError";
import * as nsDaemonConnectionSessionReleasedError from "../../src/daemon/proxy/DaemonConnectionSessionReleasedError";
import * as nsDaemonRestartOptionsUnknownError from "../../src/daemon/proxy/DaemonRestartOptionsUnknownError";
import * as nsDaemonSessionStalledError from "../../src/daemon/proxy/DaemonSessionStalledError";
import * as nsDaemonToolOutcomeUnknownError from "../../src/daemon/proxy/DaemonToolOutcomeUnknownError";
import * as nsDaemonToolUnavailableError from "../../src/daemon/proxy/DaemonToolUnavailableError";
import * as nsDaemonVersionMismatchError from "../../src/daemon/proxy/DaemonVersionMismatchError";
import * as nsLifecycleConnectionInFlightError from "../../src/daemon/proxy/LifecycleConnectionInFlightError";
import * as sessionManager from "../../src/daemon/sessionManager";
import * as nsSessionRecoveryIdentityLossError from "../../src/daemon/sessionManager/SessionRecoveryIdentityLossError";
import * as sessionErrors from "../../src/daemon/sessionErrors";
import * as sessionOwnership from "../../src/models/sessionNoLongerOwnsDevice";
import * as daemonCommand from "../../src/daemon/cli/runDaemonCommand";
import * as provisioning from "../../src/devices/exactDeviceProvisioning";
import * as provisionDeviceError from "../../src/devices/ProvisionDeviceError";
import * as provisionDeviceCreateRejected from "../../src/devices/ProvisionDeviceCreateRejectedError";
import * as deviceBootTimeout from "../../src/devices/DeviceBootTimeoutError";
import * as deviceBoot from "../../src/devices/deviceBootService";
import { ActionableError } from "../../src/models/ActionableError";
import * as acquisitionRefusals from "../../src/models/deviceAcquisitionRefusals";
import * as sessionReleasedDuringCreation from "../../src/models/SessionReleasedDuringCreationError";
import * as deviceShuttingDown from "../../src/models/DeviceShuttingDownError";
import * as sessionCreationTimeout from "../../src/models/SessionCreationTimeoutError";
import * as retryableDeviceAcquisition from "../../src/models/RetryableDeviceAcquisitionError";
import * as deviceOwnedByOtherDaemon from "../../src/models/DeviceOwnedByOtherDaemonError";
import * as deviceCleanupInProgress from "../../src/models/DeviceCleanupInProgressError";
import * as deviceUnhealthy from "../../src/models/DeviceUnhealthyError";
import * as deviceTransportOffline from "../../src/models/DeviceTransportOfflineError";
import * as inputOwnership from "../../src/daemon/inputDeviceOwnership";
import * as inputOwnedError from "../../src/models/InputDeviceOwnedError";
import * as deviceAssignedToBinding from "../../src/models/DeviceAssignedToBindingError";
import * as brokerConnectionRefusals from "../../src/daemon/sessionBroker/connectionRefusal";
import * as bootCapacity from "../../src/models/BootCapacityExhaustedError";
import * as boundSessionRefusal from "../../src/daemon/deviceOutsideBoundSessionRefusal";
import * as deviceOutsideBoundSession from "../../src/daemon/DeviceOutsideBoundSessionError";
import * as sessionOutsideBoundSession from "../../src/daemon/SessionOutsideBoundSessionError";
import * as planLockRefusal from "../../src/daemon/planExecutionInProgressRefusal";
import * as adbTransportUnavailable from "../../src/utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import * as ambiguousTargetRefusal from "../../src/daemon/ambiguousDeviceTargetRefusal";
import * as daemonTypes from "../../src/daemon/types";
import * as daemonConstants from "../../src/daemon/constants";
import * as mcpTimeouts from "../../src/daemon/McpTimeoutError";
import * as sessionReleasedDuringCall from "../../src/daemon/sessionReleasedDuringCall";
import * as sdkTooOld from "../../src/models/SdkTooOldError";
import * as appNotRunning from "../../src/models/AppNotRunningError";
import * as nsDaemonRequestNotDeliveredError from "../../src/daemon/DaemonRequestNotDeliveredError";
import * as nsDaemonUnavailableError from "../../src/daemon/DaemonUnavailableError";
import * as nsUnknownToolError from "../../src/daemon/UnknownToolError";
import * as nsReleaseErrors from "../../src/daemon/releaseErrors";
import * as nsDaemonSessionCreationRejectedError from "../../src/daemon/sessionErrors/DaemonSessionCreationRejectedError";
import * as nsPooledAvdIdentityError from "../../src/features/deviceLifecycle/PooledAvdIdentityError";
import * as daemonHandshakeMismatch from "../../src/daemon/DaemonHandshakeMismatchError";
import { DaemonBoundSessionLostError } from "../../src/daemon/DaemonBoundSessionLostError";
import { DaemonShuttingDownError } from "../../src/daemon/DaemonShuttingDownError";
import * as controlTransport from "../../src/daemon/deviceControlTransportFailure";
import * as toolUnavailable from "../../src/daemon/toolUnavailableError";
import * as deviceLifecycleCore from "../../src/features/deviceLifecycle/deviceLifecycleCore";
import * as sessionRecovery from "../../src/models/deviceSessionRecovery";
import { DEFAULT_PROVISION_DEVICE_RETRYABILITY } from "../../src/devices/exactDeviceProvisioning";
import {
  bindingsFailure,
  optionalRecord,
  readExpectations,
  readSurfaceExpectations,
  readSurfaceFixture,
  readTypedFields,
  readWirePayload,
  requireRecord,
  resultJson,
  wirePayloadOf,
  type RefusalFields,
  type SurfaceFields,
  type TypedFields,
  type WirePayload,
} from "./helpers/refusalWireReaders";
import { planRefusalFields } from "../../src/server/planExecutionOrchestrator";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { DaemonRestartDeferredError } from "../../src/daemon/daemonRestartAdmission";
import { DaemonRestartPendingError } from "../../src/daemon/daemonRestartPending";
import {
  EXTERNALLY_CAPTURED_SURFACE_FIXTURES,
  EXEMPT_REFUSAL_ERROR_CLASSES,
  fixtureDrivenErrorClasses,
  recoveryPendingError,
  shapedRefusalResult,
  PROVISION_DEVICE_FIXTURE_PREFIX,
  buildRefusalSurfaceFixtures,
  type RefusalSurfaceFixture,
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
  "models/DirectSessionNotActiveError": directSessionNotActive,
  "features/bootAdmission/HostBootAdmissionRegistry": hostBootRegistry,
  "server/downloadsFixtureService": downloadsRefusals,
  "server/StageSessionDownloadsRefusal": downloadsStageRefusal,
  "utils/android-cmdline-tools/AdbDeviceHealth": adbHealth,
  "models/DeviceLostError": deviceLost,
  "daemon/sessionBroker/provisioning/provisionRequest": bindingConfig,
  "daemon/sessionBroker/provisioning/refusal": bindingRefusals,
  "daemon/sessionBroker/provisioning/BindingDiscoveryIncompleteError":
    bindingDiscoveryIncompleteErrorModule,
  "daemon/sessionBroker/provisioning/BindingRegistrySchemaUnsupportedError":
    bindingRegistrySchemaUnsupportedErrorModule,
  "daemon/sessionBroker/provisioning/BindingOwnershipLostError": bindingOwnershipLostErrorModule,
  "daemon/sessionBroker/provisioning/BindingOwnershipUnconfirmedError":
    bindingOwnershipUnconfirmedErrorModule,
  "devices/sessionConfig": sessionConfig,
  "models/BootedDeviceDiscoveryIncompleteError.base": discoveryRefusals,
  "models/AndroidBootedDeviceDiscoveryIncompleteError": androidDiscoveryRefusals,
  "devices/AndroidAvdIdentityConflictError": androidAvdIdentityConflict,
  "devices/AndroidIdentityUnresolvedError": androidIdentityUnresolved,
  "devices/AndroidDeviceIdentityUnresolvedError": androidDeviceIdentityUnresolved,
  "devices/AndroidAvdIdentityUnresolvedError": androidAvdIdentityUnresolved,
  "models/DeviceShutdownTimeoutError": shutdownTimeout,
  "models/IosHomeLaunchTimeoutError": iosHomeLaunchTimeout,
  "features/observe/ios/SdkCapabilityQueryError": sdkCapabilityQuery,
  "models/SessionRecoveryAssignmentError": recoveryAssignment,
  "daemon/streamSubscriptionPolicy": streamPolicy,
  "daemon/sharedNamespaceGuard": namespaceGuard,
  "daemon/daemonRestartAdmission": restartAdmission,
  "daemon/daemonRestartPending": restartPending,
  "daemon/deviceSessionResolver": deviceSessionResolver,
  "daemon/deviceGestureRecordingStartAdmission": recordingAdmission,
  "daemon/orphanRecorderRefusal": orphanRecorderRefusal,
  "daemon/daemonHandoffInterruption": handoffInterruption,
  "daemon/daemonMcpProxy": daemonProxy,
  "daemon/proxy/DaemonAmbiguousSessionSelectorError": nsDaemonAmbiguousSessionSelectorError,
  "daemon/proxy/DaemonAssetVersionMismatchError": nsDaemonAssetVersionMismatchError,
  "daemon/proxy/DaemonBoundSessionExpiredError": nsDaemonBoundSessionExpiredError,
  "daemon/proxy/DaemonBuildMismatchError": nsDaemonBuildMismatchError,
  "daemon/proxy/DaemonRestartOptionsUnknownError": nsDaemonRestartOptionsUnknownError,
  "daemon/proxy/DaemonConnectionSessionReleasedError": nsDaemonConnectionSessionReleasedError,
  "daemon/proxy/DaemonSessionStalledError": nsDaemonSessionStalledError,
  "daemon/proxy/DaemonToolOutcomeUnknownError": nsDaemonToolOutcomeUnknownError,
  "daemon/proxy/DaemonToolUnavailableError": nsDaemonToolUnavailableError,
  "daemon/proxy/DaemonVersionMismatchError": nsDaemonVersionMismatchError,
  "daemon/proxy/LifecycleConnectionInFlightError": nsLifecycleConnectionInFlightError,
  "daemon/sessionManager": sessionManager,
  "daemon/sessionManager/SessionRecoveryIdentityLossError": nsSessionRecoveryIdentityLossError,
  "daemon/sessionErrors/SessionHeldByRecoveryError": sessionErrors,
  "daemon/sessionErrors/SessionRebindingError": sessionErrors,
  "daemon/sessionErrors/SessionSuspectError": sessionErrors,
  "daemon/sessionErrors/SessionTerminalReleaseInProgressError": sessionErrors,
  "models/sessionNoLongerOwnsDevice": sessionOwnership,
  "daemon/cli/runDaemonCommand": daemonCommand,
  "devices/exactDeviceProvisioning": provisioning,
  "devices/ProvisionDeviceError": provisionDeviceError,
  "devices/ProvisionDeviceCreateRejectedError": provisionDeviceCreateRejected,
  "devices/deviceBootService": deviceBoot,
  "devices/DeviceBootTimeoutError": deviceBootTimeout,
  "models/SessionReleasedDuringCreationError": sessionReleasedDuringCreation,
  "models/DeviceShuttingDownError": deviceShuttingDown,
  "models/SessionCreationTimeoutError": sessionCreationTimeout,
  "models/RetryableDeviceAcquisitionError": retryableDeviceAcquisition,
  "models/DeviceOwnedByOtherDaemonError": deviceOwnedByOtherDaemon,
  "models/DeviceCleanupInProgressError": deviceCleanupInProgress,
  "models/DeviceUnhealthyError": deviceUnhealthy,
  "models/DeviceTransportOfflineError": deviceTransportOffline,
  "models/InputDeviceOwnedError": inputOwnedError,
  "models/DeviceAssignedToBindingError": deviceAssignedToBinding,
  "daemon/inputDeviceOwnership": inputOwnership,
  "daemon/sessionBroker/connectionRefusal": brokerConnectionRefusals,
  "models/BootCapacityExhaustedError": bootCapacity,
  "daemon/DeviceOutsideBoundSessionError": deviceOutsideBoundSession,
  "daemon/SessionOutsideBoundSessionError": sessionOutsideBoundSession,
  "daemon/planExecutionInProgressRefusal": planLockRefusal,
  "daemon/ambiguousDeviceTargetRefusal": ambiguousTargetRefusal,
  "utils/android-cmdline-tools/AdbDeviceTransportUnavailableError": adbTransportUnavailable,
  "daemon/McpTimeoutError": mcpTimeouts,
  "daemon/sessionReleasedDuringCall": sessionReleasedDuringCall,
  "models/AppNotRunningError": appNotRunning,
  "models/SdkTooOldError": sdkTooOld,
  "features/prototype/prototypeHidden": prototypeHidden,
  "features/prototype/prototypeSuspended": prototypeSuspended,
  "daemon/DaemonHandshakeMismatchError": daemonHandshakeMismatch,
  "daemon/DaemonRequestNotDeliveredError": nsDaemonRequestNotDeliveredError,
  "daemon/DaemonUnavailableError": nsDaemonUnavailableError,
  "daemon/UnknownToolError": nsUnknownToolError,
  "daemon/releaseErrors": nsReleaseErrors,
  "daemon/sessionErrors/DaemonSessionCreationRejectedError": nsDaemonSessionCreationRejectedError,
  "features/deviceLifecycle/PooledAvdIdentityError": nsPooledAvdIdentityError,
  "daemon/deviceControlTransportFailure": controlTransport,
  "daemon/toolUnavailableError": toolUnavailable,
  "features/deviceLifecycle/provisioning/provisioning": deviceLifecycleCore,
};

/** Only non-wire codes may bypass the module map; the inventory rejects stale exemptions. */
const INSTALLER_ERROR_EXEMPTION =
  "Host installer library errors; no MCP/tool boundary until #12257 wires the installer.";

const EXEMPT_CODED_ERROR_MODULES: Readonly<Record<string, string>> = {
  "features/prototype/bundle/bundleContract":
    "Internal ZIP/manifest parsing control flow caught by readPrototypeBundle and exportPrototypeBundle and returned as corpus-tested BundleRejection values; BundleFailure never escapes as an MCP/tool or daemon refusal.",
  "features/action/androidLaunchIntent":
    "launchApp intent failures (#14080) are thrown as ActionableError through the generic tool-error path, which serializes only the message; the code reaches clients as the message's leading [code] text, not a structured wire field.",
  "utils/android-cmdline-tools/EmulatorConsolePortExcludedError":
    "Emulator launch refusal is thrown as an ActionableError through the generic tool-error path, which serializes only the message; the code is a property on the error, not a structured wire field.",
  "features/prototype/ios/installerErrors/PrototypeInstallPhysicalDeviceError":
    INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/InvalidPrototypeIdError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/TemplateResolveError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/TemplateCopyError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/PlistRewriteError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/IconRenderError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/SimctlInstallError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/PrototypeListError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/PrototypeUninstallError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/DataContainerError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/DataWriteError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/NotPrototypeBundleError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/CodesignError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/PrototypeViewerChecksumMismatchError":
    INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/PrototypeViewerDownloadError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/PrototypeViewerUnsupportedVersionError":
    INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/PrototypeViewerDownloadDisabledError":
    INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/PrototypeViewerOverrideError": INSTALLER_ERROR_EXEMPTION,
  "features/prototype/ios/installerErrors/PrototypeViewerExtractError": INSTALLER_ERROR_EXEMPTION,
  "daemon/sessionBroker/store":
    "Export identity mismatch is mapped to a {success:false, code} daemon reply by the export handlers (test/daemon/sessionBroker/handlers.test.ts), not a tool refusal serializer.",
  "daemon/sessionBroker/SessionRequestOwnerMismatchError":
    "Request owner mismatch is mapped to a {success:false, code, retryable, retryAfterMs} daemon reply (retryAfterMs only when retryable) by the release/abandon handlers (test/daemon/sessionBroker/handlers.test.ts), not a tool refusal serializer.",
  "daemon/sessionBroker/SessionBrokerInvariantError":
    "Store precondition failure raised inside the broker; it is classified as a permanent clean-release failure by cleanReleaseFailure.ts and never serialized as a coded tool or daemon refusal (session_broker_invariant_failed appears nowhere on the wire). It reaches daemon RPCs only as an untyped rethrow (brokerRejection rethrows unknown errors; store requireValue/ownedResource can throw it out of releaseOnce).",
  "server/SessionLogSourceError":
    "Session-log source failure caught by DefaultSessionLogService.runSource and reported as that source's {status, reason, code} outcome inside a successful collection (test/server/physicalIosSessionLog.test.ts); it never escapes as a tool or daemon refusal.",
  "daemon/sessionBroker/SessionBrokerStoppingError":
    "Shutdown refusal is mapped to a {success:false, code, retryable, retryAfterMs} daemon reply by broker handlers (test/daemon/sessionBroker/handlers.test.ts), not a tool refusal serializer.",
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

type ScannedClassNode = Class;

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
          exportedNames.add(
            specifier.local.type === "Literal" ? specifier.local.value : specifier.local.name,
          );
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
      readdirSync(root, { recursive: true, encoding: "utf8" })
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
/** The codes a payload names on the wire, outermost first. */
function wireCodes(payload: WirePayload): string[] {
  const codes = [typeof payload.error === "object" ? payload.error.code : payload.code].filter(
    (code): code is string => code !== undefined,
  );
  const nested =
    typeof payload.error === "object" ? payload.error.acquisitionFailure?.code : undefined;
  return nested ? [...codes, nested] : codes;
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
    ...(payload.heldDevices ? { heldDevices: payload.heldDevices } : {}),
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

const expectations = readExpectations(
  readFileSync(join(REFUSAL_FIXTURES_DIR, "expectations.json"), "utf8"),
);
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

/** The typed fields a surface fixture's payload carries, and where they sit on that surface. */
function surfaceTyped(fixture: RefusalSurfaceFixture): {
  typed: TypedFields;
  details?: Record<string, unknown>;
  capacity?: Record<string, unknown>;
  budget?: Record<string, unknown>;
} {
  const payload = requireRecord(fixture.payload, `${fixture.name} payload`);
  if (
    [
      "device-loss-outcome",
      "device-session-error-fields",
      "request-failure-fields",
      "press-button-result",
    ].includes(fixture.surface)
  ) {
    return { typed: readTypedFields(payload) };
  }
  if (fixture.surface === "recording-start-result") {
    return { typed: readTypedFields(resultJson(payload)) };
  }
  if (fixture.surface === "proxy-tool-result") {
    return { typed: readTypedFields(requireRecord(resultJson(payload), "body").error) };
  }
  if (fixture.surface === "provision-envelope" || fixture.surface === "liveness-handover") {
    return { typed: readTypedFields(payload.error) };
  }
  if (fixture.surface === "aux-socket-response") {
    return { typed: readTypedFields(payload), details: { deviceId: payload.deviceId } };
  }
  if (fixture.surface === "socket-frame") {
    return {
      typed: readTypedFields(payload),
      details: optionalRecord(payload, "details", "socket frame"),
    };
  }
  if (fixture.surface === "overload-frame") {
    const failure = requireRecord(payload.overloadFailure, "overloadFailure");
    return {
      typed: readTypedFields({
        code: failure.code,
        retryable: failure.retryable,
        retryAfterMs: failure.retryAfterMs,
      }),
      details: {
        queueWaitMs: failure.queueWaitMs,
        remainingTimeoutMs: failure.remainingTimeoutMs,
        reason: failure.reason,
      },
    };
  }
  if (fixture.surface === "webrtc-stream-response") {
    // Preserve absence of retry intent rather than inventing a boolean on this wire.
    expect(Object.hasOwn(payload, "retryable"), fixture.name).toBe(false);
    return { typed: { code: String(payload.errorCode) } };
  }
  if (fixture.surface === "delete-device") {
    const failure = requireRecord(requireRecord(resultJson(payload), "body").failure, "failure");
    const { code, phase, message, retryable, retryAfterMs, nextAction, ...evidence } = failure;
    expect([phase, typeof message], fixture.name).toEqual(["precondition", "string"]);
    return {
      typed: readTypedFields({ code, retryable, retryAfterMs, nextAction }),
      details: Object.keys(evidence).length > 0 ? evidence : undefined,
    };
  }
  const failure = bindingsFailure(payload);
  return {
    typed: readTypedFields(failure),
    capacity: optionalRecord(failure, "capacity", "failure"),
    budget: optionalRecord(failure, "budget", "failure"),
  };
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
).map((fixture) =>
  readSurfaceFixture(
    readFileSync(join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`), "utf8"),
  ),
);
const allSurfaceFixtures = [...surfaceFixtures, ...capturedSurfaceFixtures];
const coveredWireCodes = new Set([
  ...fixtureCodes.map((code) => expectedWireCodes(code)[0]),
  ...surfaceFixtures.flatMap((fixture) => expectedWireCodes(fixture.name)),
  ...EXTERNALLY_CAPTURED_SURFACE_FIXTURES.flatMap((fixture) => expectedWireCodes(fixture.name)),
]);
const drivenErrorClasses = fixtureDrivenErrorClasses();
const surfaceExpectations = readSurfaceExpectations(
  readFileSync(join(REFUSAL_SURFACES_DIR, "expectations.json"), "utf8"),
);

type ToolsCallHandler = (request: unknown, ctx: ServerContext) => Promise<unknown>;

function isToolsCallHandler(value: unknown): value is ToolsCallHandler {
  return typeof value === "function";
}

// Capture private production builders through their registered public handlers, using only fakes.
const ownedSurfaceFixtures: RefusalSurfaceFixture[] = [];
beforeAll(async () => {
  const registration = spyOn(Server.prototype, "setRequestHandler");
  let harness: ReturnType<typeof createProxyMcpServer>;
  let registrations: ReadonlyArray<readonly unknown[]>;
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
  const handler = registrations.findLast(([method]) => method === "tools/call")?.[1];
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    if (!isToolsCallHandler(handler)) {
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
      ["daemon_shutting_down", new DaemonShuttingDownError()],
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
            fakeServerContext({ signal: new AbortController().signal, id: 1 }),
          ),
        });
      } finally {
        call.mockRestore();
      }
    }
    const sessionUuid = "11111111-2222-4333-8444-555555555555";
    const loss = new DaemonBoundSessionLostError({
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
        fakeServerContext({ signal: new AbortController().signal, id: 1 }),
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
      const payload = requireRecord(resultJson(fixture.result), "payload");
      expect(payload).toMatchObject({
        success: false,
        error: expect.any(String),
        code: "device_unhealthy",
        recovering: stem !== "device_unhealthy.permanent",
        retryable: stem !== "device_unhealthy.permanent",
      });
      expect(Array.isArray(payload.devices)).toBe(true);
      expect(payload).not.toHaveProperty("nextAction");
      expect(
        typeof payload.code === "string" &&
          acquisitionRefusals.RETRYABLE_DEVICE_ACQUISITION_CODES.has(payload.code),
      ).toBe(false);
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
    const payload = requireRecord(resultJson(fixture.result), "payload");
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
    expect(deriveDisposition(readWirePayload(payload))).toBe("fail");
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
      const payload = wirePayloadOf(fixture.result);
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
      const payload = wirePayloadOf(fixture.result);
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
      const payload = wirePayloadOf(fixture.result);
      expect(expectations.codes[fixture.code].expected, fixture.code).toBe(
        deriveDisposition(payload),
      );
    }
  });

  test("the expectations pin the fields each fixture carries on the wire", () => {
    for (const fixture of fixtures) {
      const payload = wirePayloadOf(fixture.result);
      expect(expectations.codes[fixture.code].fields, fixture.code).toEqual(readFields(payload));
    }
    const rows = Object.values(expectations.codes).map((row) => row.fields);
    expect(rows.some((fields) => fields.retryAfterMs !== undefined)).toBe(true);
    expect(rows.some((fields) => fields.externalDevices !== undefined)).toBe(true);
    expect(rows.some((fields) => fields.heldDevices !== undefined)).toBe(true);
    expect(
      rows.some(
        (fields) => fields.heldDevices?.length === 2 && fields.externalDevices === undefined,
      ),
    ).toBe(true);
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
        "SDK capability query timeout",
        () => new sdkCapabilityQuery.SdkCapabilityQueryError("timeout", "SDK probe timed out"),
        "timeout",
        true,
        undefined,
      ],
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
      const mcp = readFields(wirePayloadOf(shapedRefusalResult(error)));
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
      expect(resultJson(shapedRefusalResult(error))).toMatchObject(payload);
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

  test.each(["cancelled", "timeout", "not_connected", "sdk_capability_query_failed"] as const)(
    "SDK capability query %s carries code and retryable on every wire",
    (code) => {
      const error = new sdkCapabilityQuery.SdkCapabilityQueryError(code, "SDK probe failed");
      const mcp = shapedRefusalResult(error);
      expect(mcp.isError).toBe(true);
      expect(JSON.parse(mcp.content[0].text)).toEqual({
        success: false,
        error: "SDK probe failed",
        code,
        retryable: true,
      });
      expect(isTypedToolRefusal(error)).toBe(true);
      expect(mcpRequestFailureDetails(error, undefined)).toEqual({ code, retryable: true });
      expect(planRefusalFields(error)).toEqual({ code, retryable: true });
    },
  );

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
        const frame = requireRecord(fixture.payload, fixture.name);
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
