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
 * Secure-state uses platform-specific discovery. Android reports only Keystore
 * metadata support; iOS Keychain / Core Data policy remains owned by #5161.
 */

import {
  describeDefaultAppFileProviderCoverage,
  type AppFileProviderCoverage,
} from "../../server/appFileService";
import {
  describeDefaultSharedStorageReadCoverage,
  IOS_MEDIA_READ_UNSUPPORTED_REASON,
  type SharedStorageReadCoverage,
} from "../../server/sharedStorageReadService";
import type { KeystoreDiscoveryState } from "./keystoreDiscovery";

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
  /** Omission uses metadata from the production provider set; [] means no providers. */
  providerCoverage?: readonly AppFileProviderCoverage[];
  /** Bounded user-files reads belong to SharedStorageReadService, not app-file providers. */
  sharedStorageReadCoverage?: SharedStorageReadCoverage;
  mediaLibraryReadCoverage?: SharedStorageReadCoverage;
  platform: "android" | "ios";
  deviceType: StorageDeviceType;
  /** AutoMobile SDK embedded with storage inspection enabled. */
  embeddedSdk: boolean;
  /** Verified through the typed Android test-control bridge, not inferred from SDK presence. */
  keystore?: KeystoreDiscoveryState;
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
  /** Verified managed fixture container availability; omission is pending verification. */
  iosFilesFixtureInstalled?: boolean;
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
   * platform-specific extension point (e.g. managed user-files fixtures); it must not
   * be treated as portable behavior (#5602: document extension points).
   */
  portable: boolean;
  platformScope: "android" | "ios" | "cross-platform";
  operations: OperationCapability[];
  note?: string;
  /** Platform-specific bridge discovery; contains metadata support, never secret values. */
  capabilities?: KeystoreDiscoveryState[];
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
    iosFilesFixtureInstalled?: boolean;
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
const PREREQ_IOS_FILES_FIXTURE = "managed iOS Files fixture app installed";
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
    // Physical Android: only private containers need a debuggable build for run-as.
    if (ctx.debuggableBuild === false) {
      return {
        operation,
        state: "partial",
        reason:
          "Private containers require a debuggable app build; externalFiles remains available.",
        prerequisites: [PREREQ_DEBUGGABLE],
      };
    }
    return deriveOperation(operation, undefined, [req(PREREQ_DEBUGGABLE, ctx.debuggableBuild)]);
  };
  return {
    domain: "app_containers",
    portable: true,
    platformScope: "cross-platform",
    note: "putAppFile target.domain app_containers. Canonical resources: automobile:devices/{deviceId}/storage-domains/app_containers/{appId}/{container}[/{path}]{?userId}; compatibility aliases: automobile:devices/{deviceId}/apps/{appId}/files/{container}[/{path}]{?userId}. Fully available on simulators/emulators; qualified on physical devices.",
    operations: operations.map(buildOp),
  };
}

function userFilesDomain(ctx: StorageCapabilityContext): DomainCapability {
  if (ctx.platform === "ios") {
    const physicalReason =
      ctx.deviceType === "simulator"
        ? undefined
        : "Physical iOS user_files is unsupported without an on-device fixture-app integration; generic iosFileIntegration does not provide it.";
    const requirements = [req(PREREQ_IOS_FILES_FIXTURE, ctx.iosFilesFixtureInstalled)];
    return {
      domain: "user_files",
      portable: false,
      platformScope: "cross-platform",
      note: "iOS Simulator only: managed fixture-app Documents/automobile namespaces. The fixture app is not shipped in this repo. Writes require its installed container; picker visibility is reported separately and unavailable unless verified. Physical iOS is unsupported. Canonical user_files resources list/read only these managed namespaces.",
      operations: [
        physicalReason
          ? deriveOperation("list", physicalReason, [])
          : deriveOperation("list", undefined, []),
        physicalReason
          ? deriveOperation("read", physicalReason, [])
          : deriveOperation("read", undefined, []),
        deriveOperation(
          "write",
          physicalReason,
          requirements,
          "Stages files in the managed iOS Files fixture app; picker visibility requires separate verification.",
        ),
        deriveOperation(
          "namespace_reset",
          physicalReason,
          requirements,
          "Resets only Documents/automobile/<namespace> in the managed fixture app.",
        ),
        deriveOperation(
          "media_indexing",
          physicalReason ?? "iOS user_files has no Android media indexing equivalent.",
          [],
        ),
      ],
    };
  }
  return {
    domain: "user_files",
    portable: false,
    platformScope: "cross-platform",
    note: 'Android user-visible shared storage. putAppFile target.domain user_files writes, resets one namespace, and optionally indexes media in bounded Downloads namespaces; canonical resources: automobile:devices/{deviceId}/storage-domains/user_files/{namespace}[/{path}]; compatibility aliases: the "Downloads Namespace Files" and "Downloads Namespace File" MCP resources expose listing and reading at automobile:devices/{deviceId}/downloads/{namespace}[/{path}].',
    operations: [
      deriveOperation(
        "list",
        undefined,
        [req(PREREQ_ACTIVE_PROFILE, ctx.activeUserProfile)],
        'Exposed by the "Downloads Namespace Files" MCP resource template.',
      ),
      deriveOperation(
        "read",
        undefined,
        [req(PREREQ_ACTIVE_PROFILE, ctx.activeUserProfile)],
        'Exposed by the "Downloads Namespace File" MCP resource template.',
      ),
      deriveOperation("write", undefined, [req(PREREQ_ACTIVE_PROFILE, ctx.activeUserProfile)]),
      deriveOperation(
        "namespace_reset",
        undefined,
        [req(PREREQ_ACTIVE_PROFILE, ctx.activeUserProfile)],
        "Resets only the declared user_files namespace.",
      ),
      deriveOperation(
        "media_indexing",
        undefined,
        [req(PREREQ_ACTIVE_PROFILE, ctx.activeUserProfile)],
        "Requested with putAppFile target.indexMedia.",
      ),
    ],
  };
}

function mediaLibraryDomain(ctx: StorageCapabilityContext): DomainCapability {
  // Android reads are bounded to putAppFile staging; iOS imports have no reader.
  const androidWrite = deriveOperation("write", undefined, [
    req(PREREQ_ACTIVE_PROFILE, ctx.activeUserProfile),
  ]);
  const indexing =
    ctx.platform === "ios"
      ? deriveOperation(
          "media_indexing",
          "iOS has no MediaScanner-style host-triggered indexing equivalent.",
          [],
        )
      : deriveOperation(
          "media_indexing",
          undefined,
          [req(PREREQ_ACTIVE_PROFILE, ctx.activeUserProfile)],
          "Verified as part of Android putAppFile media_library writes.",
        );
  const iosWrite = deriveOperation(
    "write",
    ctx.deviceType === "simulator"
      ? undefined
      : "iOS media-library fixture staging is only supported on iOS Simulators.",
    [],
    "Imports image and video fixtures through xcrun simctl addmedia; picker visibility is unverified.",
  );
  return {
    domain: "media_library",
    portable: false,
    platformScope: "cross-platform",
    note:
      ctx.platform === "android"
        ? "Android putAppFile writes bounded media fixtures and verifies MediaStore discovery; list/read is bounded to Download/automobile-media."
        : ctx.deviceType === "simulator"
          ? "iOS Simulator putAppFile imports image and video fixtures through simctl addmedia; browse/read is not exposed."
          : "iOS physical media-library mutation is not exposed.",
    operations: [
      ...(["list", "read"] as const).map((operation) =>
        ctx.platform === "ios"
          ? unavailableOperation(operation, IOS_MEDIA_READ_UNSUPPORTED_REASON)
          : deriveOperation(
              operation,
              undefined,
              [req(PREREQ_ACTIVE_PROFILE, ctx.activeUserProfile)],
              "Canonical media_library resources read only Download/automobile-media.",
            ),
      ),
      ctx.platform === "ios" ? iosWrite : androidWrite,
      indexing,
    ],
  };
}

function secureStateDomain(ctx: StorageCapabilityContext): DomainCapability {
  if (ctx.platform === "android") {
    return {
      domain: "secure_state",
      portable: false,
      platformScope: "android",
      note: "App-owned Android Keystore metadata via storage.keystore; exact declared scopes only, never key material. Package-data reset is separate.",
      capabilities: ctx.keystore ? [ctx.keystore] : [],
      operations: [
        {
          operation: "read",
          state: "unavailable",
          reason:
            "SDK alias metadata is read-only; no host storage read surface is exposed in this slice.",
          prerequisites: ["code-only KeystoreTestState opt-in and exact declared scope (#5189)"],
        },
        deriveOperation(
          "write",
          "Keystore mutation is declared_unsupported in this slice (#5190).",
          [],
        ),
        deriveOperation(
          "namespace_reset",
          "Keystore mutation is declared_unsupported; package-data reset is explicit and separate (#5190).",
          [],
        ),
      ],
    };
  }
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
        "Android bounded Downloads namespaces are platform-specific; the separate iOS Simulator fixture-app provider does not make user_files portable.",
    },
    {
      domain: "user_files",
      platform: "ios",
      description:
        "iOS Simulator staging requires an installed managed Files fixture app; picker visibility requires separate verification. Physical iOS is unsupported; this is not portable storage.",
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

function absentProviderDescription(domain: StorageDomain, operation: StorageOperation): string {
  if (
    (domain === "user_files" || domain === "media_library") &&
    (operation === "list" || operation === "read")
  ) {
    return `SharedStorageReadService ${operation} provider`;
  }
  return operation === "namespace_reset" || operation === "media_indexing"
    ? `write provider declaring ${operation}`
    : `${operation} provider`;
}

/** Provider absence never advertises support; device restrictions remain authoritative. */
function applyProviderCoverage(
  ctx: StorageCapabilityContext,
  domain: DomainCapability,
): DomainCapability {
  const providers = ctx.providerCoverage ?? describeDefaultAppFileProviderCoverage();
  const provider = providers.find(
    (entry) => entry.platform === ctx.platform && entry.domain === domain.domain,
  ) ?? { write: false, list: false, read: false, namespaceReset: false, mediaIndexing: false };
  const coverage: Partial<Record<StorageOperation, boolean>> = {
    write: provider.write,
    list: provider.list,
    read: provider.read,
    namespace_reset: provider.write && provider.namespaceReset,
    media_indexing: provider.write && provider.mediaIndexing,
  };
  if (domain.domain === "user_files" || domain.domain === "media_library") {
    const sharedRead =
      (domain.domain === "user_files"
        ? ctx.sharedStorageReadCoverage
        : ctx.mediaLibraryReadCoverage) ??
      describeDefaultSharedStorageReadCoverage(ctx.platform, domain.domain);
    coverage.list = sharedRead.list;
    coverage.read = sharedRead.read;
  }
  return {
    ...domain,
    operations: domain.operations.map((capability) => {
      const operation = capability.operation;
      if (coverage[operation]) {
        return capability;
      }
      const absent = absentProviderDescription(domain.domain, operation);
      return {
        ...capability,
        state: capability.state === "unsupported" ? "unsupported" : "unavailable",
        reason: `${capability.reason ? `${capability.reason} ` : ""}No ${absent} is registered for ${ctx.platform}:${domain.domain}.`,
      };
    }),
  };
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
      iosFilesFixtureInstalled: ctx.iosFilesFixtureInstalled,
    },
    domains: [
      applyProviderCoverage(ctx, appContainersDomain(ctx)),
      applyProviderCoverage(ctx, userFilesDomain(ctx)),
      applyProviderCoverage(ctx, mediaLibraryDomain(ctx)),
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
