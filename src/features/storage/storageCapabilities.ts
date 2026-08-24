/**
 * Cross-platform storage capabilities by logical domain (issue #5602).
 *
 * Clients negotiate what storage operations are available for a selected device
 * and app context instead of inferring them from platform names or parsing failed
 * operations. This module is a pure, input-driven capability model: given a
 * resolved {@link StorageCapabilityContext} it produces a deterministic
 * {@link StorageCapabilitiesReport}. The MCP resource layer
 * (`src/server/storageCapabilityResources.ts`) resolves the context from a booted
 * device and delegates the reasoning here so the state machine is fully testable
 * without devices, sockets, or a clock.
 *
 * Secure-state (Keychain / Core Data) policy is owned by #5161; this module reports
 * the domain as an explicit extension point and never advertises secret export.
 */

/** Payload schema version. Bump when the report shape changes incompatibly. */
export const STORAGE_CAPABILITIES_SCHEMA_VERSION = 1 as const;

/** Logical storage domains, modeled independently of native paths. */
export type StorageDomain =
  | "app_containers"
  | "user_files"
  | "media_library"
  | "key_value"
  | "databases"
  | "secure_state";

/** Operations a domain may expose. */
export type StorageOperation =
  | "list"
  | "read"
  | "write"
  | "namespace_reset"
  | "media_indexing"
  | "observe";

/**
 * Capability state for a single operation.
 * - `supported`: available now for this device/app context.
 * - `partial`: structurally available but gated by a prerequisite the descriptor
 *   cannot verify ahead of time (e.g. debuggable build, authorization); the client
 *   must satisfy the listed prerequisites.
 * - `unavailable`: supported in principle but a known prerequisite is unmet right
 *   now (fixable by enabling the SDK, connecting a session, etc.).
 * - `unsupported`: the platform/device cannot perform it at all; not fixable by
 *   configuration.
 */
export type CapabilityState = "supported" | "partial" | "unavailable" | "unsupported";

/** Android emulator, iOS simulator, or a physical device of either platform. */
export type StorageDeviceType = "emulator" | "simulator" | "physical";

/**
 * Resolved signals the capability model reasons over. Fields typed
 * `boolean | undefined` are three-valued: `true`/`false` are verified,
 * `undefined` means "unverified at descriptor time" and yields `partial`.
 */
export interface StorageCapabilityContext {
  platform: "android" | "ios";
  deviceType: StorageDeviceType;
  /** AutoMobile SDK embedded with storage inspection enabled. */
  embeddedSdk: boolean;
  /** Active CtrlProxy runner session. */
  sessionActive?: boolean;
  /** App built debuggable (required for adb `run-as` file/db access). */
  debuggableBuild?: boolean;
  /** User granted the relevant storage authorization (media/shared storage). */
  authorized?: boolean;
  /** Android has an active, unlocked user/profile for the app. */
  activeUserProfile?: boolean;
  /**
   * Opt-in app integration advertises iOS physical-device file access (#5602 AC3).
   * Without it, iOS physical file behavior is unsupported.
   */
  iosFileIntegration?: boolean;
  /** Optional app scope the report was computed for. */
  appId?: string;
}

/** Capability of a single operation within a domain. */
export interface OperationCapability {
  operation: StorageOperation;
  state: CapabilityState;
  /** Human-readable explanation of the state. */
  reason?: string;
  /** Prerequisites the client must satisfy before the operation is available. */
  prerequisites?: string[];
}

/** Capability of one logical domain. */
export interface DomainCapability {
  domain: StorageDomain;
  /**
   * Whether the domain behaves portably across platforms. `false` marks a
   * platform-specific extension point (e.g. Android-only user files); it must not
   * be treated as portable behavior (#5602: document extension points).
   */
  portable: boolean;
  platformScope: "android" | "ios" | "cross-platform";
  operations: OperationCapability[];
  note?: string;
}

/** A documented platform-specific extension point. */
export interface StorageExtensionPoint {
  domain: StorageDomain;
  platform: "android" | "ios";
  description: string;
}

/** The full capability report for a device/app context. */
export interface StorageCapabilitiesReport {
  schemaVersion: typeof STORAGE_CAPABILITIES_SCHEMA_VERSION;
  platform: "android" | "ios";
  deviceType: StorageDeviceType;
  appId?: string;
  /** The resolved signals used to derive this report. */
  context: {
    embeddedSdk: boolean;
    sessionActive?: boolean;
    debuggableBuild?: boolean;
    authorized?: boolean;
    activeUserProfile?: boolean;
    iosFileIntegration?: boolean;
  };
  domains: DomainCapability[];
  extensionPoints: StorageExtensionPoint[];
}

// A prerequisite the descriptor evaluates. `satisfied === undefined` means
// unverified at descriptor time (contributes a `partial` state, never a failure).
interface Requirement {
  label: string;
  satisfied: boolean | undefined;
}

// Derive an operation state from a hard-unsupported reason plus AND-combined
// requirements. Known-unmet requirements dominate (unavailable); an unverified
// requirement degrades an otherwise-supported op to partial. This makes
// conflicting inputs (e.g. embeddedSdk true but sessionActive false) resolve
// deterministically to the most restrictive reachable state.
function deriveOperation(
  operation: StorageOperation,
  hardUnsupportedReason: string | undefined,
  requirements: Requirement[],
  supportedReason?: string,
): OperationCapability {
  if (hardUnsupportedReason) {
    return { operation, state: "unsupported", reason: hardUnsupportedReason };
  }
  const unmet = requirements.filter((requirement) => requirement.satisfied === false);
  const unverified = requirements.filter((requirement) => requirement.satisfied === undefined);
  if (unmet.length > 0) {
    return {
      operation,
      state: "unavailable",
      reason: `Missing prerequisite: ${unmet.map((requirement) => requirement.label).join(", ")}.`,
      prerequisites: [...unmet, ...unverified].map((requirement) => requirement.label),
    };
  }
  if (unverified.length > 0) {
    return {
      operation,
      state: "partial",
      reason: `Available pending verification of: ${unverified
        .map((requirement) => requirement.label)
        .join(", ")}.`,
      prerequisites: unverified.map((requirement) => requirement.label),
    };
  }
  return { operation, state: "supported", reason: supportedReason };
}

// An operation that is structurally possible on the platform but has no AutoMobile
// surface exposed yet. Distinct from `unsupported` (the platform cannot do it) and
// from a prerequisite-gated `unavailable` (which the client can satisfy): here the
// gap is a missing tool, so the client should not attempt the operation.
function unavailableOperation(operation: StorageOperation, reason: string): OperationCapability {
  return { operation, state: "unavailable", reason };
}

function req(label: string, satisfied: boolean | undefined): Requirement {
  return { label, satisfied };
}

const PREREQ_SDK = "AutoMobile SDK embedded with storage inspection";
const PREREQ_SESSION = "active CtrlProxy runner session";
const PREREQ_DEBUGGABLE = "debuggable app build";
const PREREQ_ACTIVE_PROFILE = "active Android user/profile";
const PREREQ_IOS_FILE_INTEGRATION = "opt-in iOS app file-access integration";

function keyValueDomain(ctx: StorageCapabilityContext): DomainCapability {
  const requirements = [req(PREREQ_SDK, ctx.embeddedSdk), req(PREREQ_SESSION, ctx.sessionActive)];
  const operations: StorageOperation[] = ["list", "read", "write", "namespace_reset", "observe"];
  return {
    domain: "key_value",
    portable: true,
    platformScope: "cross-platform",
    note: "SharedPreferences / DataStore (Android) and UserDefaults (iOS) via the AutoMobile SDK.",
    operations: operations.map((operation) => deriveOperation(operation, undefined, requirements)),
  };
}

function databasesDomain(ctx: StorageCapabilityContext): DomainCapability {
  // List/read/observe route through the on-device AutoMobile SDK
  // (DatabaseInspector); writes route through the opt-in `sqlQuery` tool, which
  // executes INSERT/UPDATE/DELETE and DDL. Both paths require the embedded SDK, so
  // all exposed operations share the same prerequisites.
  const requirements = [req(PREREQ_SDK, ctx.embeddedSdk), req(PREREQ_SESSION, ctx.sessionActive)];
  return {
    domain: "databases",
    portable: true,
    platformScope: "cross-platform",
    note: "SQLite inspection (list, read, bounded queries) and mutation via the opt-in sqlQuery tool.",
    operations: (["list", "read", "observe", "write"] as StorageOperation[]).map((operation) =>
      deriveOperation(operation, undefined, requirements),
    ),
  };
}

function appContainersDomain(ctx: StorageCapabilityContext): DomainCapability {
  const operations: StorageOperation[] = ["list", "read", "write"];
  const buildOp = (operation: StorageOperation): OperationCapability => {
    if (ctx.platform === "ios") {
      if (ctx.deviceType === "simulator") {
        // Host-mediated simctl container access.
        return deriveOperation(operation, undefined, []);
      }
      // Physical iOS: unsupported unless an opt-in app integration advertises it.
      if (ctx.iosFileIntegration === true) {
        return {
          operation,
          state: "partial",
          reason:
            "Available only through an opt-in app file-access integration; not native iOS behavior.",
          prerequisites: [PREREQ_IOS_FILE_INTEGRATION],
        };
      }
      return deriveOperation(
        operation,
        "Direct app-container file access is unsupported on physical iOS devices unless an opt-in app integration advertises it.",
        [],
      );
    }
    // Android
    if (ctx.deviceType === "emulator") {
      return deriveOperation(operation, undefined, []);
    }
    // Physical Android: needs a debuggable build for run-as.
    return deriveOperation(operation, undefined, [req(PREREQ_DEBUGGABLE, ctx.debuggableBuild)]);
  };
  return {
    domain: "app_containers",
    portable: true,
    platformScope: "cross-platform",
    note: "Direct app-sandbox file access. Fully available on simulators/emulators; qualified on physical devices.",
    operations: operations.map(buildOp),
  };
}

function userFilesDomain(ctx: StorageCapabilityContext): DomainCapability {
  if (ctx.platform === "ios") {
    const reason =
      "User-visible shared storage is an Android-only concept; iOS apps are sandboxed to per-app containers.";
    return {
      domain: "user_files",
      portable: false,
      platformScope: "android",
      note: reason,
      operations: (["list", "read", "write"] as StorageOperation[]).map((operation) =>
        deriveOperation(operation, reason, []),
      ),
    };
  }
  return {
    domain: "user_files",
    portable: false,
    platformScope: "android",
    note: "Android user-visible / shared storage. Staging files into shared storage is supported (stageSharedStorage); a listing/read surface is not yet exposed.",
    operations: [
      unavailableOperation(
        "list",
        "No AutoMobile shared-storage listing surface is currently exposed.",
      ),
      unavailableOperation(
        "read",
        "No AutoMobile shared-storage read surface is currently exposed.",
      ),
      deriveOperation("write", undefined, [req(PREREQ_ACTIVE_PROFILE, ctx.activeUserProfile)]),
    ],
  };
}

function mediaLibraryDomain(ctx: StorageCapabilityContext): DomainCapability {
  // No AutoMobile tool browses or reads the media library on either platform.
  // On Android, indexing happens only as a side effect of staging a file into
  // shared storage (there is no standalone index operation); iOS has no
  // host-triggered indexer at all.
  const indexing =
    ctx.platform === "ios"
      ? deriveOperation(
          "media_indexing",
          "iOS has no MediaScanner-style host-triggered indexing equivalent.",
          [],
        )
      : unavailableOperation(
          "media_indexing",
          "Media indexing currently occurs only as a side effect of staging a file into shared storage; no standalone indexing operation is exposed.",
        );
  return {
    domain: "media_library",
    portable: false,
    platformScope: "cross-platform",
    note: "Media-library browse/read is not yet exposed as an AutoMobile capability.",
    operations: [
      unavailableOperation(
        "list",
        "No AutoMobile media-library listing surface is currently exposed.",
      ),
      unavailableOperation(
        "read",
        "No AutoMobile media-library read surface is currently exposed.",
      ),
      indexing,
    ],
  };
}

function secureStateDomain(_ctx: StorageCapabilityContext): DomainCapability {
  // Policy is owned by #5161. Values are never exported here; mutation is a non-goal.
  const policyPrereq = "host secure-state policy (see #5161)";
  return {
    domain: "secure_state",
    portable: false,
    platformScope: "cross-platform",
    note: "Keychain / Core Data secure state. Inspection policy is owned by #5161; secrets are never exported without an explicit host redaction policy.",
    operations: [
      {
        operation: "read",
        state: "unavailable",
        reason:
          "Secure-state values are unavailable by default; an opt-in host redaction policy (#5161) must allow the exact field.",
        prerequisites: [policyPrereq],
      },
      deriveOperation("write", "Secure-state mutation is not an AutoMobile storage feature.", []),
      deriveOperation(
        "namespace_reset",
        "Bulk secure-state reset is out of scope here; scoped resets are tracked separately (#5188 / #5190).",
        [],
      ),
    ],
  };
}

function extensionPoints(): StorageExtensionPoint[] {
  return [
    {
      domain: "user_files",
      platform: "android",
      description:
        "User-visible shared storage is Android-only and must not be advertised as portable behavior.",
    },
    {
      domain: "app_containers",
      platform: "ios",
      description:
        "Physical-iOS app-container file access is exposed only through an opt-in app integration, not as native portable behavior.",
    },
    {
      domain: "secure_state",
      platform: "ios",
      description:
        "Core Data and Keychain inspection policy is owned by #5161; treat as an extension point, not portable storage.",
    },
  ];
}

/**
 * Compute the storage capability report for a resolved device/app context.
 * Pure and deterministic — the same context always yields the same report.
 */
export function computeStorageCapabilities(
  ctx: StorageCapabilityContext,
): StorageCapabilitiesReport {
  return {
    schemaVersion: STORAGE_CAPABILITIES_SCHEMA_VERSION,
    platform: ctx.platform,
    deviceType: ctx.deviceType,
    appId: ctx.appId,
    context: {
      embeddedSdk: ctx.embeddedSdk,
      sessionActive: ctx.sessionActive,
      debuggableBuild: ctx.debuggableBuild,
      authorized: ctx.authorized,
      activeUserProfile: ctx.activeUserProfile,
      iosFileIntegration: ctx.iosFileIntegration,
    },
    domains: [
      appContainersDomain(ctx),
      userFilesDomain(ctx),
      mediaLibraryDomain(ctx),
      keyValueDomain(ctx),
      databasesDomain(ctx),
      secureStateDomain(ctx),
    ],
    extensionPoints: extensionPoints(),
  };
}

/** Look up one operation's capability in a report. */
export function findOperationCapability(
  report: StorageCapabilitiesReport,
  domain: StorageDomain,
  operation: StorageOperation,
): OperationCapability | undefined {
  return report.domains
    .find((entry) => entry.domain === domain)
    ?.operations.find((entry) => entry.operation === operation);
}

/**
 * True when a proposed storage operation is fully available now (state
 * `supported`). Serves AC1: a client can decide before invoking. `partial`,
 * `unavailable`, and `unsupported` all return false because each still needs the
 * client to act (satisfy a prerequisite) or avoid the call entirely.
 */
export function isStorageOperationAvailable(
  report: StorageCapabilitiesReport,
  domain: StorageDomain,
  operation: StorageOperation,
): boolean {
  return findOperationCapability(report, domain, operation)?.state === "supported";
}
