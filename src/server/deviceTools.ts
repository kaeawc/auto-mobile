import type { QrPosterWriter } from "../utils/qr/QrPosterWriter";
import {
  DefaultDeviceResourceObserver,
  type DeviceResourceObserver,
} from "../utils/deviceResourceObserver";
import {
  unadmittedAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  discoveryRefreshOutcome,
  deviceListRefreshFailureMessage,
} from "../daemon/devicePoolRefresh";
import {
  DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
  DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
  isShutdownTimeoutError,
  shouldClearIntentionalShutdownAfterFailure,
  stopVideoRecordingsBeforeShutdown,
  waitForDeviceShutdown,
} from "./deviceToolsShutdown";
import {
  getShutdownInitiatingExecutionId,
  retireShutdownOwnership,
  shutdownTimeoutError,
} from "./deviceToolsShutdown";
import {
  rebootAndroidAfterSystemUiAnr,
  type SystemUiAnrRecoveryResult,
} from "./deviceToolsSystemUiAnr";
import { errorMessage } from "../utils/describeUnknownError";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { terminateColdBootProcess } from "../devices/coldBootProcessTermination";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { androidAvdConfigurationSchema } from "../models/AndroidAvdConfiguration";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { startDeviceOutputSchema } from "./toolOutputSchemas";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { enableToolsSchemaField } from "./toolSelectionTools";
import { deviceResourceConfigurationSchema } from "./deviceResourceSchemas";
import { registerDeviceResourceTools } from "./deviceResourceTools";
import { createProvisionDeviceHandler } from "./deviceToolsProvisioning";
import { createAcquisitionHandlers } from "./deviceToolsAcquisition";
import { createStartDeviceHandlers } from "./deviceToolsStartDevice";
import { createLifecycleHandlers } from "./deviceToolsLifecycle";
import { createListingHandlers } from "./deviceToolsListing";
import {
  DefaultDeviceResourceController,
  type DeviceResourceController,
} from "../utils/deviceResourceController";
import type {
  DeviceResourceConfiguration,
  DeviceResourceConfigurationResult,
} from "../models/DeviceResourceConfiguration";
import {
  type BootedDeviceDiscovery,
  type BootedDeviceDiscoveryOptions,
  type DeviceImageDiscovery,
  MultiPlatformDeviceManager,
  PlatformDeviceManager,
} from "../devices/deviceUtils";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { ActionableError, BootedDevice, DeviceInfo, Platform, SomePlatform } from "../models";
import type { DeviceMatchCriteria, FormFactor } from "../models/DeviceMatchCriteria";
import {
  BOOTED_DEVICE_RESOURCE_URIS,
  notifyBootedDeviceResourcesUpdated,
} from "./bootedDeviceResources";
import {
  DEVICE_IMAGE_RESOURCE_URIS,
  ANDROID_INVENTORY_RETRY_AFTER_MS,
  notifyDeviceImageResourcesUpdated,
} from "./deviceImageResources";
import {
  configuredImageForBootedDevice,
  configuredImagesByStableId,
  type StableConfiguredDeviceImage,
} from "../utils/configuredDeviceInventory";
import { AvdManagerService } from "../utils/android-cmdline-tools/AvdManagerService";
import type { AvdManager } from "../utils/android-cmdline-tools/interfaces/AvdManager";
import type { AvdInfo } from "../utils/android-cmdline-tools/avdmanager";
import {
  describeDevice,
  projectListDevicesEntry,
  listDevicesEntrySchema,
  provisionedDeviceSchema,
  configuredImageSchema,
} from "./deviceDescription";
import {
  notifyInstalledAppResourceListChanged,
  syncInstalledAppResourceRegistry,
  syncInstalledAppResources,
} from "./appResources";
import { stopSegmentedVideoRecordingsForDevice } from "./videoRecordingTools";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { AndroidCtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { getPerformanceMonitor } from "../features/performance/PerformanceMonitor";
import {
  platformSchema,
  addSessionUuidToSchema,
  withCanonicalDiscriminatedUnionJsonSchema,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import { DefaultDeviceMatcher, type DeviceMatcher } from "../utils/deviceMatcher";
import {
  defaultDisplayInventoryProvider,
  type DisplayInventoryProvider,
} from "../devices/DisplayInventoryProvider";
import type { Environment } from "../daemon/poolConfig";
import { captureAutolockPolicy } from "../daemon/deviceAutolockPolicy";
import {
  deleteInternalToolParams,
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
} from "../daemon/constants";
import {
  DEVICE_CREATE_ENV_VAR,
  getDeviceCreationGate,
  type DeviceCreationGate,
} from "../devices/deviceCreationGate";
import {
  createDefaultDeviceProvisioner,
  type DeviceProvisioner,
} from "../devices/deviceProvisioning";
import { DaemonState } from "../daemon/daemonState";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import type { DevicePool, DeviceReadinessReservation, PooledDevice } from "../daemon/devicePool";
import {
  AndroidAvdIdentityConflictError,
  AndroidBootedDeviceDiscoveryIncompleteError,
  DeviceBootService,
  findUniqueBootedAndroidDeviceByName,
  type DeviceBootResult,
} from "../devices/deviceBootService";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  AndroidAvdProvenanceCache,
  CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS,
} from "../utils/AndroidAvdProvenanceCache";
import { runWithAbortSignal } from "../utils/AbortContext";
import { ResourceRegistry } from "./resourceRegistry";
import { executionTracker } from "./executionTracker";
import { unregisterDirectSessionsForStableIdentity } from "./directSessionDeviceRegistry";
import {
  type RunnerReadinessRequest,
  SystemUiAnrRecoveryRequiredError,
} from "../ctrlProxy/RunnerReadinessService";
import {
  DEFAULT_RUNNER_PROVISION_TIMEOUT_MS,
  MAX_RUNNER_READINESS_TIMEOUT_MS,
  MIN_RUNNER_READINESS_TIMEOUT_MS,
} from "../utils/runnerReadinessConfig";
import { serverConfig } from "../utils/ServerConfig";
import {
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS,
  MAX_PROVISION_DEVICE_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
} from "../utils/deviceTimeouts";
import {
  createDefaultExactDeviceProvisioner,
  type ExactDeviceProvisioner,
  type ExactDeviceSpecification,
  ProvisionDeviceError,
} from "../devices/exactDeviceProvisioning";
import { MIN_AVD_RAM_MB } from "../utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import {
  ProvisionDeviceOperationRepository,
  ProvisionDeviceOperationFailedError,
  ProvisionDeviceOperationInProgressError,
  type ProvisionDeviceLifecycleOutcome,
  type ProvisionDeviceOperationBeginResult,
  type ProvisionDeviceOperationStore,
} from "../db/provisionDeviceOperationRepository";
import {
  DeviceTeardownOperationRepository,
  type DeviceTeardownOperationStore,
} from "../db/deviceTeardownOperationRepository";
import { stableStringify } from "../utils/stableStringify";
import {
  getVirtualDeviceLifecycleCoordinator,
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
  type VirtualDeviceLifecycleOperation,
} from "../devices/virtualDeviceLifecycleCoordinator";
import { DeviceTeardownService } from "../devices/deviceTeardownService";
import { hasMutableDisplayName } from "../utils/ios-cmdline-tools/iosDeviceType";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { DISPLAY_CUTOUT_PREFERENCES } from "../utils/displayCutout";

export { reserveAndroidStartupLease } from "./deviceToolsStartupLease";

export function knownProvisionDeviceError(error: unknown): ProvisionDeviceError | undefined {
  if (error instanceof ProvisionDeviceError) {
    return error;
  }
  if (error instanceof AndroidAvdIdentityConflictError) {
    return new ProvisionDeviceError("identity_conflict", error.message);
  }
  if (error instanceof AndroidBootedDeviceDiscoveryIncompleteError) {
    return new ProvisionDeviceError("discovery_incomplete", error.message, true);
  }
  return undefined;
}

export function findExactProvisionedBootedDevice(
  platform: Platform,
  booted: readonly BootedDevice[],
  provisioned: Pick<DeviceInfo, "deviceId" | "name">,
): BootedDevice | undefined {
  if (platform === "ios") {
    return booted.find((device) => device.deviceId === provisioned.deviceId);
  }
  const byDeviceId = provisioned.deviceId
    ? booted.find((device) => device.deviceId === provisioned.deviceId)
    : undefined;
  return byDeviceId ?? findUniqueBootedAndroidDeviceByName(booted, provisioned.name);
}

// Schema definitions
export const listDeviceImagesSchema = z
  .object({
    platform: platformSchema,
    sessionUuid: z.string().optional().describe("Session used for inventory admission"),
  })
  .strict();

export const listDevicesSchema = z
  .object({
    platform: platformSchema.optional(),
    requires: z
      .object({
        panels: z.number().int().positive().optional(),
        posture: z
          .enum(["closed", "half_opened", "opened", "rear_display", "flipped", "tent", "unknown"])
          .optional(),
      })
      .strict()
      .optional()
      .describe("Filter booted devices by display inventory capabilities"),
  })
  .strict();

const listDeviceImagesOutputSchema = z.object({
  message: z.string(),
  images: z.array(configuredImageSchema),
  count: z.number(),
  platform: platformSchema,
  configuredInventory: z.unknown(),
});

const listDevicesOutputSchema = z.object({
  message: z.string(),
  devices: z.array(
    listDevicesEntrySchema.extend({ transportAliases: z.array(z.string()).optional() }),
  ),
  count: z.number(),
  discovery: z.unknown(),
  enrichment: z
    .object({
      complete: z.literal(false),
      missing: z.array(z.enum(["configuredImages", "provenance"])),
      retryable: z.boolean(),
      retryAfterMs: z.number().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  note: z.unknown(),
});

const provisionDeviceOutputSchema = z
  .object({
    operationId: z.string(),
    device: provisionedDeviceSchema,
    requestedSpec: z.unknown(),
    resolvedSpec: z.unknown(),
    displayCutout: z.unknown(),
    created: z.boolean(),
    adopted: z.boolean(),
    lifecycleState: z.enum(["ready", "created", "adopted"]),
    readiness: z.object({ mode: z.enum(["automation", "none"]), status: z.string() }),
    timing: z.unknown(),
  })
  .passthrough();

const startDeviceParametersSchema = z.object({
  platform: platformSchema,
  minOsVersion: z
    .string()
    .optional()
    .describe("Minimum OS version, inclusive (e.g., '14', '17.2')"),
  maxOsVersion: z
    .string()
    .optional()
    .describe("Maximum OS version, inclusive (e.g., '15', '18.0')"),
  name: z.string().optional().describe("Device name to match (e.g., 'iPhone 16e', 'Pixel_9_Pro')"),
  avdName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact Android Virtual Device name. Unlike name, this never selects a substring-matching AVD.",
    ),
  cameraPosterPath: z
    .string()
    .optional()
    .describe(
      "Host PNG/JPG/JPEG poster image for the Android emulator back camera wall; cold boot only",
    ),
  cameraPosterQr: z
    .object({
      text: z
        .string()
        .min(1)
        .max(1024)
        .describe("Payload the generated QR code encodes (UTF-8, at most ~213 bytes)"),
    })
    .strict()
    .optional()
    .describe(
      "Generate a QR code PNG and use it as the Android emulator back camera wall poster; cold boot only. Mutually exclusive with cameraPosterPath.",
    ),
  formFactor: z.enum(["phone", "tablet", "foldable"]).optional().describe("Device form factor"),
  requires: z
    .object({
      panels: z.number().int().positive().optional().describe("Minimum number of display panels"),
      posture: z
        .enum(["closed", "half_opened", "opened", "rear_display", "flipped", "tent", "unknown"])
        .optional()
        .describe("Supported device posture"),
    })
    .strict()
    .optional()
    .describe("Required display capabilities from device inventory"),
  screenSize: z
    .object({
      width: z.number().positive().finite().describe("Screen width in pixels"),
      height: z.number().positive().finite().describe("Screen height in pixels"),
    })
    .optional()
    .describe("Desired screen dimensions"),
  deviceId: z.string().optional(),
  preferRunning: z.boolean().optional().describe("Prefer already-booted device (default true)"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_DEVICE_READY_TIMEOUT_MS)
    .optional()
    .describe("Total device boot and automation-readiness timeout in ms"),
  runnerReadinessTimeoutMs: z
    .number()
    .int()
    .min(MIN_RUNNER_READINESS_TIMEOUT_MS)
    .max(MAX_RUNNER_READINESS_TIMEOUT_MS)
    .optional()
    .describe(
      "Runner-readiness budget in ms within timeoutMs; overrides the shared timeout " +
        `(${MIN_RUNNER_READINESS_TIMEOUT_MS}-${MAX_RUNNER_READINESS_TIMEOUT_MS})`,
    ),
  createIfMissing: z
    .boolean()
    .optional()
    .describe(
      `Create a device when nothing matches (CLI: --create-if-missing). Default off; ` +
        `${DEVICE_CREATE_ENV_VAR}=1 enables it when this flag is not supplied, and the flag wins.`,
    ),
  // startDevice mints a session just like getAndroid/getApple. Keep its
  // hidden compatibility surface capability-complete so a fresh/reconnected
  // client can declare the tools needed by its newly minted session.
  enableTools: enableToolsSchemaField,
});

export const startDeviceSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return input;
    }

    const parsed = input as Record<string, unknown>;
    const legacyDevice = parsed.device;
    if (!legacyDevice || typeof legacyDevice !== "object" || Array.isArray(legacyDevice)) {
      return input;
    }

    // Accept both the legacy { device: {...} } payload and the new top-level shape.
    // Top-level fields win so mixed callers can override nested values intentionally.
    return {
      ...(legacyDevice as Record<string, unknown>),
      ...parsed,
    };
  },
  startDeviceParametersSchema.superRefine((value, context) => {
    if (value.cameraPosterQr !== undefined && value.cameraPosterPath !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["cameraPosterQr"],
        message: "cameraPosterQr and cameraPosterPath are mutually exclusive",
      });
    }
    if (value.avdName !== undefined && value.platform !== "android") {
      context.addIssue({
        code: "custom",
        path: ["avdName"],
        message: "avdName is only supported for Android startDevice requests",
      });
    }
    if (value.avdName !== undefined && value.name !== undefined && value.avdName !== value.name) {
      context.addIssue({
        code: "custom",
        path: ["avdName"],
        message: "avdName and name must identify the same Android device when both are supplied",
      });
    }
  }),
);

const devicePreparationTimeoutSchema = z
  .object({
    bootTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_DEVICE_READY_TIMEOUT_MS)
      .optional()
      .describe(
        `Maximum time in ms to find, recover, or boot the device operating system (default ${DEFAULT_DEVICE_READY_TIMEOUT_MS}). ` +
          `bootTimeoutMs + automationReadyTimeoutMs must be <= ${MAX_DEVICE_READY_TIMEOUT_MS}, including defaults for omitted fields.`,
      ),
    automationReadyTimeoutMs: z
      .number()
      .int()
      .min(MIN_RUNNER_READINESS_TIMEOUT_MS)
      .max(MAX_DEVICE_READY_TIMEOUT_MS)
      .optional()
      .describe(
        `Maximum time in ms to install, update, start, and verify the automation runner (default ${DEFAULT_RUNNER_PROVISION_TIMEOUT_MS}). ` +
          `bootTimeoutMs + automationReadyTimeoutMs must be <= ${MAX_DEVICE_READY_TIMEOUT_MS}, including defaults for omitted fields; ` +
          `when bootTimeoutMs is omitted, this must be <= ${MAX_DEVICE_READY_TIMEOUT_MS - DEFAULT_DEVICE_READY_TIMEOUT_MS}.`,
      ),
  })
  .strict();

function validateDevicePreparationTimeout(
  value: { bootTimeoutMs?: number; automationReadyTimeoutMs?: number },
  context: z.RefinementCtx,
): void {
  const totalTimeoutMs =
    (value.bootTimeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS) +
    (value.automationReadyTimeoutMs ?? DEFAULT_RUNNER_PROVISION_TIMEOUT_MS);
  if (totalTimeoutMs > MAX_DEVICE_READY_TIMEOUT_MS) {
    context.addIssue({
      code: "custom",
      message: `bootTimeoutMs + automationReadyTimeoutMs must be <= ${MAX_DEVICE_READY_TIMEOUT_MS}`,
      path: ["bootTimeoutMs"],
    });
  }
}

// #5870: `deviceId` — the identifier at `runtime.deviceId` for booted resources
// or `identity.stableId` for configured resources — is
// accepted alongside the platform-native identifier. Either is sufficient; the
// refine names both sources when neither is given so the caller is never left
// guessing which field of which resource to read.
// The at-least-one rule lives in `.superRefine()` + a sourced error message, not
// in the advertised JSON Schema: a top-level `anyOf`/`oneOf` is exactly what
// `TopLevelUnionFlattener` strips (the Anthropic API rejects top-level
// combinators), so it cannot be advertised in the flat object schema.
export const getAndroidSchema = devicePreparationTimeoutSchema
  .extend({
    requires: startDeviceParametersSchema.shape.requires,
    avdName: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Configured Android Virtual Device name (the `name` field of automobile:devices/images/android)",
      ),
    deviceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Booted device serial, e.g. emulator-5554 (the `runtime.deviceId` field of automobile:devices/booted/android), or a defined AVD image name, which is cold-booted by name. Prefer avdName to boot or coordinate a named AVD.",
      ),
    // #6869 — declare the session's capabilities in the SAME call that acquires
    // the device, instead of one setToolEnabled round-trip per gated tool. The
    // grant is applied in src/server/index.ts against the session this call
    // mints; this handler ignores the field.
    enableTools: enableToolsSchemaField,
  })
  .superRefine(validateDevicePreparationTimeout)
  .superRefine((value, ctx) => {
    if (!value.avdName && !value.deviceId) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide avdName (the `name` field of automobile:devices/images/android) or deviceId (the `runtime.deviceId` field of automobile:devices/booted/android)",
        path: ["avdName"],
      });
    }
    // Both spellings are accepted together: `deviceId` takes a serial OR an
    // image name, so `avdName: "Pixel_A"` + that AVD's running serial names ONE
    // device and must not be rejected by the schema, which cannot know which
    // serial an AVD is running on. The pair is validated after discovery
    // instead (`validateRequestedAndroidSerial`), where a genuine disagreement
    // is reported with the same machine-readable `identifier_conflict` code.
    // Silently preferring `avdName` without that check would prepare a device
    // the caller did not name — the worst failure mode for a device-identity API.
  });

export const getAppleSchema = devicePreparationTimeoutSchema
  .extend({
    udid: z
      .string()
      .min(1)
      .optional()
      .describe(
        "iOS Simulator UDID (the `runtime.deviceId` field of automobile:devices/booted/ios or the `identity.stableId` field of automobile:devices/images/ios)",
      ),
    deviceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Booted device identifier (the `runtime.deviceId` field of automobile:devices/booted/ios); alias for udid",
      ),
    // See getAndroidSchema.enableTools (#6869).
    enableTools: enableToolsSchemaField,
  })
  .superRefine(validateDevicePreparationTimeout)
  .superRefine((value, ctx) => {
    if (!value.udid && !value.deviceId) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide udid or deviceId (the `runtime.deviceId` field of automobile:devices/booted/ios)",
        path: ["udid"],
      });
    }
    // `deviceId` is an alias for `udid` on iOS, so two different values name
    // two different simulators; resolving that to `udid` alone would prepare a
    // device the caller did not name.
    if (value.udid && value.deviceId && value.udid !== value.deviceId) {
      ctx.addIssue({
        code: "custom",
        message:
          `identifier_conflict: udid '${value.udid}' and deviceId '${value.deviceId}' are ` +
          "different simulator UDIDs. Pass only the identifier you mean.",
        path: ["deviceId"],
      });
    }
  });

const MODERN_PLAY_IMAGE_MIN_API_LEVEL = 30;
const CORE_SIMULATOR_IDENTIFIER_PREFIX = "com.apple.CoreSimulator.";
const ANDROID_SYSTEM_IMAGE_PREFIX = "system-images;";

function isModernPlayStoreRuntime(runtime: string): boolean {
  const parsedRuntime = parseAndroidSystemImageRuntime(runtime);
  return (
    parsedRuntime?.tag === "google_apis_playstore" &&
    parsedRuntime.apiLevel >= MODERN_PLAY_IMAGE_MIN_API_LEVEL
  );
}

const androidProvisionDeviceSpecSchema = z
  .object({
    runtime: z.string().min(1).describe("Installed Android system-image package identifier"),
    deviceType: z.string().min(1).describe("Android avdmanager device profile identifier"),
    displayCutout: z
      .enum(DISPLAY_CUTOUT_PREFERENCES)
      .optional()
      .describe(
        "Required display cutout class for the exact device type; 'any' accepts every class",
      ),
    configuration: androidAvdConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.runtime.startsWith(CORE_SIMULATOR_IDENTIFIER_PREFIX)) {
      context.addIssue({
        code: "custom",
        message: "Android runtime must be an Android system-image identifier",
        path: ["runtime"],
      });
    }
    if (spec.deviceType.startsWith(CORE_SIMULATOR_IDENTIFIER_PREFIX)) {
      context.addIssue({
        code: "custom",
        message: "Android deviceType must be an Android avdmanager device profile identifier",
        path: ["deviceType"],
      });
    }
    const memoryMb = spec.configuration?.memoryMb;
    if (
      memoryMb !== undefined &&
      memoryMb < MIN_AVD_RAM_MB &&
      isModernPlayStoreRuntime(spec.runtime)
    ) {
      context.addIssue({
        code: "custom",
        message:
          `memoryMb must be at least ${MIN_AVD_RAM_MB} for Android API ` +
          `${MODERN_PLAY_IMAGE_MIN_API_LEVEL}+ Play Store images`,
        path: ["configuration", "memoryMb"],
      });
    }
  });

const iosProvisionDeviceSpecSchema = z
  .object({
    runtime: z.string().min(1).describe("CoreSimulator runtime identifier"),
    deviceType: z.string().min(1).describe("CoreSimulator device-type identifier"),
    displayCutout: z
      .enum(DISPLAY_CUTOUT_PREFERENCES)
      .optional()
      .describe(
        "Required display cutout class for the exact device type; 'any' accepts every class",
      ),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.runtime.startsWith(ANDROID_SYSTEM_IMAGE_PREFIX)) {
      context.addIssue({
        code: "custom",
        message: "iOS runtime must be a CoreSimulator runtime identifier",
        path: ["runtime"],
      });
    }
    if (!spec.deviceType.startsWith(CORE_SIMULATOR_IDENTIFIER_PREFIX)) {
      context.addIssue({
        code: "custom",
        message: "iOS deviceType must be a CoreSimulator device-type identifier",
        path: ["deviceType"],
      });
    }
  });

export const provisionDeviceSchema = z
  .object({
    operationId: z.string().min(1).describe("Caller-generated idempotency key"),
    resources: deviceResourceConfigurationSchema
      .optional()
      .describe(
        "Resource settings applied after boot and before automation readiness. Requires boot=true; omitted resources stay unchanged.",
      ),
    device: withCanonicalDiscriminatedUnionJsonSchema(
      z.discriminatedUnion("platform", [
        z
          .object({
            platform: z.literal("android"),
            name: z.string().min(1).describe("Exact AVD name"),
            spec: androidProvisionDeviceSpecSchema,
          })
          .strict(),
        z
          .object({
            platform: z.literal("ios"),
            name: z.string().min(1).describe("Exact simulator name"),
            deviceId: z
              .string()
              .min(1)
              .optional()
              .describe("Exact simulator UDID; prevents same-named simulator selection"),
            spec: iosProvisionDeviceSpecSchema,
          })
          .strict(),
      ]),
    ),
    boot: z
      .boolean()
      .default(true)
      .optional()
      .describe("Boot the resolved device after creation or adoption"),
    readiness: z
      .enum(["automation", "none"])
      .default("automation")
      .optional()
      .describe("Whether to wait for the AutoMobile automation runner after device boot"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_PROVISION_DEVICE_TIMEOUT_MS)
      .optional()
      .describe("Total provision, boot, resource configuration, and readiness timeout in ms"),
    // See getAndroidSchema.enableTools (#6869). Requires boot=true: the
    // no-boot branch returns before a session exists (#6886 review).
    enableTools: enableToolsSchemaField.describe(
      `${enableToolsSchemaField.description} Requires boot=true.`,
    ),
  })
  .strict()
  .refine((args) => !args.resources || args.boot !== false, {
    path: ["resources"],
    message: "Resource configuration requires boot=true.",
  })
  // A boot=false provision returns before any session is minted, so there is
  // nothing to grant the declared capabilities against — accepting the
  // request would discard it silently (#6886 review). Reject it up front,
  // like the resources constraint above.
  .refine((args) => !args.enableTools || args.boot !== false, {
    path: ["enableTools"],
    message: "Capability declaration requires boot=true; boot=false mints no session.",
  });

// Wording shared by killDevice and deleteDevice so the two escape hatches cannot
// drift apart in what they promise (#6864).
const FORCE_SKIP_AVD_VERIFICATION_DESCRIPTION =
  "Drop every AVD-name comparison on the way to the kill -- the emulator-console probe that " +
  "confirms which AVD is running on this serial, and the platform kill's own check against a " +
  "fresh discovery -- and act on whatever occupies the serial. Use only when the console has " +
  "wedged and the normal call refuses because the AVD name cannot be confirmed. This does not " +
  "override the conflict check, it removes it: force means 'act on whatever emulator currently " +
  "occupies this serial', including a different AVD that took the serial over. It does NOT " +
  "select a different serial, and a serial with nothing running on it still refuses. Nor does " +
  "it override the refusal raised when this daemon's pool entry for the serial was retired and " +
  "replaced while the action was being prepared, or deleteDevice's refusal to delete a stopped " +
  "image while a booted emulator that cannot be identified at all is attached. Android " +
  "emulators only; accepted and ignored for iOS and physical devices.";

export const killDeviceSchema = z
  .object({
    device: z.object({
      name: z.string().describe("Device image name"),
      deviceId: z.string(),
      platform: platformSchema,
    }),
    force: z.boolean().default(false).describe(FORCE_SKIP_AVD_VERIFICATION_DESCRIPTION),
  })
  .strict();

const TEARDOWN_OPERATION_ID_JSON_SCHEMA_PATTERN =
  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$";

export const teardownDeviceSchema = addSessionUuidToSchema(
  z
    .object({
      operationId: withJsonSchemaOverride(
        z.string().uuid().describe("Caller-generated idempotency and diagnostic correlation ID"),
        (jsonSchema) => {
          // Zod's UUID JSON Schema pattern differs between platforms.
          jsonSchema.pattern = TEARDOWN_OPERATION_ID_JSON_SCHEMA_PATTERN;
        },
      ),
      target: z
        .object({
          platform: platformSchema.describe("Platform reported by automobile:devices/booted"),
          isVirtual: z
            .literal(true)
            .describe("Virtual-device flag reported by automobile:devices/booted"),
          stableId: z
            .string()
            .min(1)
            .describe("Stable platform device identity from automobile:devices/booted"),
          stableName: z
            .string()
            .min(1)
            .optional()
            .describe("Stable platform representation name when available"),
        })
        .strict(),
      mode: z
        .literal("destroy")
        .describe("Stop and permanently delete the platform device representation"),
      verifyAbsence: z
        .literal(true)
        .describe("Require a complete inventory observation proving durable absence"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_DEVICE_READY_TIMEOUT_MS)
        .optional()
        .describe("Total bounded teardown timeout in ms"),
      cancellationPolicy: z
        .literal("cancel-on-request-abort")
        .optional()
        .describe(
          "Cancel the accepted teardown if this MCP request is aborted. Use only for deadline-critical, caller-owned cleanup that must not continue in the background after its caller stops waiting.",
        ),
      force: z.boolean().default(false).describe(FORCE_SKIP_AVD_VERIFICATION_DESCRIPTION),
    })
    .strict(),
);

export const DEVICE_ALREADY_STOPPED_ERROR_CODE = "device_already_stopped";

// A successful platform shutdown command only confirms that the request was
// accepted. Keep the public killDevice result coupled to the observable device
// lifecycle, while bounding the wait so a wedged platform command is actionable.
export const DEVICE_SHUTDOWN_TIMEOUT_MS = 30_000;
export const TEARDOWN_OPERATION_RESULT_TTL_MS = 5 * 60 * 1_000;
// A live provisionDevice attempt can legitimately hold its operation row for as
// long as its own timeoutMs budget allows, capped at MAX_DEVICE_READY_TIMEOUT_MS
// (~14m50s). Give the stored row headroom beyond that ceiling so a still-live
// attempt is never mistaken for abandoned while genuinely within its own
// deadline, plus room afterward for idempotent replay before the row is pruned
// (#6652).
export const PROVISION_DEVICE_OPERATION_TTL_MS = MAX_DEVICE_READY_TIMEOUT_MS + 15 * 60 * 1_000;
export const PROVISION_DEVICE_FINALIZATION_TTL_REFRESH_MS = Math.floor(
  PROVISION_DEVICE_OPERATION_TTL_MS / 2,
);
export const PROVISION_DEVICE_SETTLEMENT_WAIT_MS = 5_000;
export const PROVISION_DEVICE_TTL_REFRESH_WAIT_MS = 1_000;

export async function waitForProvisionDeviceSettlement(
  operation: Promise<unknown>,
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = new Error("Provision device settlement wait timed out");
  try {
    return await raceWithDeadline(
      // Only settlement matters; the original lifecycle failure is handled by its owner.
      operation.then(
        () => true,
        () => true,
      ),
      {
        timer,
        timeoutMs,
        label: "Provision device settlement",
        timeoutError: () => deadline,
      },
    );
  } catch (error) {
    if (error === deadline) {
      return false;
    }
    throw error;
  }
}

// Terminal-but-retryable error code stamped on an operation row whose attempt
// was rejected by an in-flight MCP session recovery. Distinct from a genuine
// provisioning failure so the stored row says why the attempt never ran.
export const PROVISION_DEVICE_SESSION_RECOVERY_ERROR_CODE = "session_recovery_in_progress";

export function createToolErrorResponse(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: false, message, error: { code, message }, ...details }),
      },
    ],
  };
}

// Export interfaces for type safety
export interface StartDeviceArgs {
  cameraPosterPath?: string;
  cameraPosterQr?: { text: string };
  platform: "android" | "ios";
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  /** Exact Android AVD identity for callers that must never match a sibling by substring. */
  avdName?: string;
  formFactor?: FormFactor;
  requires?: DeviceMatchCriteria["requires"];
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
  runnerReadinessTimeoutMs?: number;
  createIfMissing?: boolean;
  __mcpSessionId?: string;
  /** Acceptance-only, non-mutating discovery presentation control. */
  presentationOrder?: "forward" | "reverse";
  /** Internal exact runtime identity used by getAndroid. */
  matchExactName?: boolean;
}

export interface GetAndroidArgs {
  avdName?: string;
  deviceId?: string;
  requires?: DeviceMatchCriteria["requires"];
  bootTimeoutMs?: number;
  automationReadyTimeoutMs?: number;
}

export interface GetAppleArgs {
  udid?: string;
  deviceId?: string;
  bootTimeoutMs?: number;
  automationReadyTimeoutMs?: number;
}

export interface ProvisionDeviceArgs {
  operationId: string;
  device: {
    platform: "android" | "ios";
    name: string;
    deviceId?: string;
    spec: ExactDeviceSpecification;
  };
  boot: boolean;
  readiness: "automation" | "none";
  resources?: DeviceResourceConfiguration;
  timeoutMs?: number;
  __mcpSessionId?: string;
  /** Daemon-provided remaining transport budget. */
  __mcpRequestTimeoutMs?: number;
  /** Daemon-provided absolute transport deadline. */
  __mcpRequestDeadlineMs?: number;
}

export interface KillDeviceArgs {
  device: BootedDevice;
  /**
   * Drop the AVD-name comparisons on the way to the kill -- the kill-time
   * emulator-console probe here, and the platform kill's own re-discovery check
   * in `AndroidEmulatorClient.killDevice` -- and act on whatever occupies the
   * serial (#6864). Defaults to false; see
   * {@link FORCE_SKIP_AVD_VERIFICATION_DESCRIPTION}.
   */
  force?: boolean;
}

export interface TeardownDeviceArgs {
  operationId: string;
  target: {
    platform: Platform;
    isVirtual: true;
    stableId: string;
    stableName?: string;
  };
  mode: "destroy";
  verifyAbsence: true;
  timeoutMs?: number;
  /**
   * Opt into cancellation of the accepted teardown on request abort. The
   * default preserves ordinary idempotent teardown continuation semantics.
   */
  cancellationPolicy?: "cancel-on-request-abort";
  /**
   * Drop the AVD-name comparisons on the way to the kill -- the kill-time
   * emulator-console probe here, and the platform kill's own re-discovery check
   * in `AndroidEmulatorClient.killDevice` -- and act on whatever occupies the
   * serial (#6864). Defaults to false; see
   * {@link FORCE_SKIP_AVD_VERIFICATION_DESCRIPTION}.
   */
  force?: boolean;
}

export interface StableDeviceTarget {
  platform: Platform;
  stableId: string;
}

type StableDeviceLifecycleTimeoutFactory = (detail: string) => Error;

/**
 * Shared deadline mapping for every lifecycle reservation, stable or selector:
 * a coordinator rejection at or after the deadline is contention, so it must
 * carry the caller's structured timeout error rather than surfacing as an
 * opaque platform failure. Kept synchronous so callers add no extra await hop.
 */
export function rethrowDeviceLifecycleReservationFailure(
  error: unknown,
  timer: Timer,
  deadlineMs: number,
  timeoutError: StableDeviceLifecycleTimeoutFactory,
  timeoutDetail: string,
): never {
  if (timer.now() >= deadlineMs) {
    throw timeoutError(timeoutDetail);
  }
  throw error;
}

export async function reserveStableDeviceLifecycle(
  target: StableDeviceTarget,
  deadlineDevice: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  {
    requestAbortSignal,
    timeoutError = (detail) => shutdownTimeoutError(deadlineDevice, detail),
    operation = "start",
    coordinator = getVirtualDeviceLifecycleCoordinator(),
  }: {
    requestAbortSignal: AbortSignal | undefined;
    timeoutError?: StableDeviceLifecycleTimeoutFactory;
    operation?: VirtualDeviceLifecycleOperation;
    coordinator?: VirtualDeviceLifecycleCoordinator;
  },
): Promise<VirtualDeviceLifecycleLease> {
  try {
    return await coordinator.reserve(
      {
        kind: "stable",
        platform: target.platform,
        stableId: target.stableId,
      },
      {
        operation,
        deadlineMs,
        signal: requestAbortSignal,
      },
    );
  } catch (error) {
    rethrowDeviceLifecycleReservationFailure(
      error,
      timer,
      deadlineMs,
      timeoutError,
      "waiting for stable device lifecycle reservation",
    );
  }
}

export function androidSourceImageWithBootedMetadata(
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
  admittedAndroidImage: DeviceInfo | undefined,
): DeviceInfo | undefined {
  if (device.platform !== "android") {
    return sourceImage;
  }
  if (!sourceImage && !admittedAndroidImage) {
    return undefined;
  }
  return {
    ...(sourceImage ?? admittedAndroidImage),
    name: sourceImage?.name ?? device.name,
    platform: "android",
    isRunning: true,
    apiLevel: [device.apiLevel, sourceImage?.apiLevel, admittedAndroidImage?.apiLevel].find(
      (value) => value !== undefined,
    ),
    osVersion: [device.osVersion, sourceImage?.osVersion, admittedAndroidImage?.osVersion].find(
      (value) => value !== undefined,
    ),
  };
}

export function deviceIdentityPayload(
  device: BootedDevice,
  sourceImage?: DeviceInfo,
): Record<string, unknown> {
  if (device.platform === "android") {
    return androidDeviceIdentityPayload(device, sourceImage);
  }

  const ctrlProxy = IOSCtrlProxyManager.getInstance(device);
  return {
    platform: "ios",
    simulatorUdid: device.deviceId,
    simulatorName: device.name,
    iosServicePort: ctrlProxy.getServicePort(),
    iosRunnerGeneration: ctrlProxy.getRunnerGeneration(),
  };
}

function androidDeviceIdentityPayload(
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
): Record<string, unknown> {
  const portMatch = /^emulator-(\d+)$/.exec(device.deviceId);
  const androidImage = sourceImage?.platform === "android" ? sourceImage : undefined;
  return {
    platform: "android",
    avdName: androidImage?.name ?? device.name,
    adbSerial: device.deviceId,
    emulatorConsolePort: portMatch ? Number(portMatch[1]) : null,
  };
}

export function listDevicePayloads(
  booted: BootedDevice[],
  devicePool: DevicePool | undefined,
  configuredImages: ReadonlyMap<string, StableConfiguredDeviceImage>,
  aliasesForDevice: (deviceId: string) => string[] = (deviceId) =>
    devicePool?.getAndroidTransportAliases(deviceId) ?? [],
  transportAvdNameForDevice: (deviceId: string) => string | undefined = (deviceId) =>
    devicePool?.getAndroidTransportAvdName(deviceId),
) {
  const sessionManager = DaemonState.getInstance().isInitialized()
    ? DaemonState.getInstance().getSessionManager()
    : undefined;
  const sessions = new Map(
    sessionManager?.getAllSessions().map((session) => [session.sessionId, session]),
  );
  return booted.map((device) => {
    const pooled = devicePool?.describesPooledRuntime(device)
      ? (devicePool.getDevice(device.deviceId) ?? undefined)
      : undefined;
    const session = pooled?.sessionId
      ? (sessions.get(pooled.sessionId) ?? { sessionId: pooled.sessionId })
      : undefined;
    const description = describeDevice({
      kind: "booted",
      device,
      pooled,
      unhealthy: pooled ? devicePool?.getDeviceHealthMarker(device.deviceId) : undefined,
      configured: configuredImageForBootedDevice(device, configuredImages),
      session,
      deviceSessionUuid: pooled ? initializedDeviceSessionUuid(device.deviceId) : undefined,
    });
    if (device.platform === "android") {
      return projectAndroidTransportDescription(
        description,
        aliasesForDevice(device.deviceId),
        transportAvdNameForDevice(device.deviceId),
      );
    }
    return projectListDevicesEntry(description);
  });
}

function projectAndroidTransportDescription(
  description: ReturnType<typeof describeDevice>,
  aliases: string[],
  avdName: string | undefined,
) {
  const projected = projectListDevicesEntry(
    avdName ? { ...description, isVirtual: true, identity: { stableId: avdName } } : description,
  );
  return { ...projected, ...(aliases.length ? { transportAliases: aliases } : {}) };
}

/**
 * The acquisition boot already resolved its selected image. Re-project that
 * known image rather than rediscovering the entire configured inventory while
 * returning the session response. Android provenance is optional cache-only
 * enrichment; a cold cache deliberately leaves the nullable image link empty.
 */
export function configuredImageForAcquiredDevice(
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
): StableConfiguredDeviceImage | undefined {
  if (sourceImage?.platform !== device.platform) {
    return undefined;
  }
  const image =
    device.platform === "ios" && !sourceImage.deviceId
      ? { ...sourceImage, deviceId: device.deviceId }
      : sourceImage;
  const configured = configuredImageForBootedDevice(
    device,
    configuredImagesByStableId(device.platform, {
      devices: [image],
      succeededPlatforms: new Set([device.platform]),
    }),
  );
  if (!configured || device.platform !== "android") {
    return configured;
  }
  const provenance = AndroidAvdProvenanceCache.getInstance()
    .getCachedByName()
    ?.get(configured.name);
  return provenance
    ? {
        ...configured,
        image: {
          path: provenance.path,
          target: provenance.target,
          basedOn: provenance.basedOn,
        },
      }
    : configured;
}

export function initializedDevicePool(): DevicePool | undefined {
  const daemonState = DaemonState.getInstance();
  return daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
}

function initializedDeviceSessionUuid(deviceId: string): string | undefined {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return undefined;
  }
  return daemonState.getDeviceSessionRegistry().getByDeviceId(deviceId)?.deviceSessionUuid;
}

export async function configuredImagesForBootedDevices(
  deviceManager: PlatformDeviceManager,
  avdManager: Pick<AvdManager, "listDeviceImages">,
  booted: readonly BootedDevice[],
  timer: Timer,
): Promise<{
  images: ReadonlyMap<string, StableConfiguredDeviceImage>;
  enrichment?: {
    complete: false;
    missing: Array<"configuredImages" | "provenance">;
    retryable: boolean;
    retryAfterMs?: number;
    reason?: string;
  };
}> {
  const images = new Map<string, StableConfiguredDeviceImage>();
  let incomplete = false;
  const platforms = [...new Set(booted.map((device) => device.platform))];
  await Promise.all(
    platforms.map(async (platform) => {
      const controller = new AbortController();
      try {
        const [discovery, androidProvenance] = await raceWithDeadline(
          Promise.all([
            deviceManager.getDeviceImagesDetailed(platform, {
              signal: controller.signal,
              coalesceInventoryEnrichment: true,
            }),
            platform === "android"
              ? AndroidAvdProvenanceCache.getInstance().getByName(avdManager, timer)
              : Promise.resolve(new Map()),
          ]),
          {
            timer,
            signal: controller.signal,
            label: "Configured image inventory",
            timeoutMs: CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS,
            onTimeout: () =>
              controller.abort(new Error("Configured image inventory caller budget elapsed")),
          },
        );
        if (!discovery.succeededPlatforms.has(platform)) {
          incomplete = true;
        }
        for (const [key, image] of configuredImagesByStableId(platform, discovery)) {
          const provenance = androidProvenance.get(image.name);
          images.set(
            key,
            provenance
              ? {
                  ...image,
                  image: {
                    path: provenance.path,
                    target: provenance.target,
                    basedOn: provenance.basedOn,
                  },
                }
              : image,
          );
        }
      } catch (error) {
        incomplete = true;
        logger.warn(
          `listDevices configured ${platform} image inventory failed: ${errorMessage(error)}`,
          error,
        );
      }
    }),
  );
  const provenance = platforms.includes("android")
    ? AndroidAvdProvenanceCache.getInstance().getStatus()
    : { state: "cached" as const };
  if (provenance.state === "failed") {
    return {
      images,
      enrichment: {
        complete: false,
        missing: ["provenance"],
        retryable: false,
        reason: `avdmanager unavailable: ${provenance.cause}`,
      },
    };
  }
  if (incomplete || provenance.state !== "cached") {
    return {
      images,
      enrichment: {
        complete: false,
        missing: ["configuredImages"],
        retryable: true,
        retryAfterMs: ANDROID_INVENTORY_RETRY_AFTER_MS,
      },
    };
  }
  return { images };
}

export interface ListDeviceImagesArgs {
  platform: Platform;
}

export interface ListDevicesArgs {
  platform?: "android" | "ios";
  requires?: DeviceMatchCriteria["requires"];
}

export function acceptancePresentationOrder(
  args: Record<string, unknown>,
): "forward" | "reverse" | undefined {
  const order = args[INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM];
  return order === "forward" || order === "reverse" ? order : undefined;
}

export function detailedDiscoveryOptions(
  presentationOrder: "forward" | "reverse" | undefined,
): BootedDeviceDiscoveryOptions {
  return presentationOrder === undefined ? {} : { presentationOrder };
}

export interface DeviceToolsDependencies {
  /** Renders `cameraPosterQr` payloads to a poster image; defaults to a file writer under the data dir. */
  cameraPosterQrWriter?: QrPosterWriter;
  androidAdbFactory: AdbClientFactory;
  env?: Environment;
  deviceResourceControllerFactory: () => DeviceResourceController;
  deviceResourceObserverFactory: () => DeviceResourceObserver;
  deviceManagerFactory: () => PlatformDeviceManager;
  avdManagerFactory: () => Pick<AvdManager, "listDeviceImages">;
  deviceMatcherFactory: () => DeviceMatcher;
  displayInventory: DisplayInventoryProvider;
  notifyResourcesChanged: () => Promise<void>;
  notifyDeviceInventoryResourcesChanged: (installedAppResourcesChanged: boolean) => Promise<void>;
  syncInstalledAppResourceRegistry: () => Promise<boolean>;
  ensureCtrlProxyReady?: (request: RunnerReadinessRequest) => Promise<void>;
  deviceCreationGateFactory: () => DeviceCreationGate;
  deviceProvisionerFactory: () => DeviceProvisioner;
  exactDeviceProvisionerFactory: (
    deviceManager: PlatformDeviceManager,
    deviceCreationGate: DeviceCreationGate,
  ) => ExactDeviceProvisioner;
  provisionDeviceOperationStoreFactory: () => ProvisionDeviceOperationStore;
  teardownDeviceOperationStoreFactory: () => DeviceTeardownOperationStore;
  clearInstalledAppsForDevice: (deviceId: string) => Promise<void>;
  stopPerformanceMonitoring: (deviceId: string) => void;
  stopAndroidObservers: (device: BootedDevice) => Promise<void>;
  idGenerator: IdGenerator;
  timer: Timer;
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
  /**
   * Re-resolve an emulator's AVD name from the RUNTIME rather than from any
   * host-side cache (`emu avd name`). Resolves to undefined when the emulator
   * console cannot answer inside `timeoutMs`, which is the caller's REMAINING
   * deadline, not an independent budget. See {@link confirmPooledAvdIdentity}.
   */
  resolveRunningAndroidAvdName: (
    device: BootedDevice,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
}

/**
 * In-flight provisionDevice operations, keyed by idempotency key, so several
 * callers of the same operationId share one lifecycle. `waiters` counts the
 * callers still listening for the result: the shared `controller` is aborted
 * when the LAST of them detaches, because past that point the lifecycle would
 * otherwise keep booting a device and binding a session that no client owns.
 * A caller that detaches while others are still waiting only detaches itself.
 */
export interface ActiveProvisionDeviceOperation {
  fingerprint: string;
  promise: Promise<Record<string, unknown>>;
  controller: AbortController;
  waiters: number;
}

export const activeProvisionDeviceOperations = new Map<string, ActiveProvisionDeviceOperation>();
executionTracker.setActiveProvisionDeviceQuery({
  hasActiveProvisionDeviceOperation: () => activeProvisionDeviceOperations.size > 0,
});

/**
 * Detach one caller from a shared operation. Returns true when this was the
 * last waiter and the still-running lifecycle was therefore cancelled.
 */
export function releaseProvisionDeviceWaiter(
  operationId: string,
  operation: ActiveProvisionDeviceOperation,
  cancellationReason?: unknown,
): boolean {
  operation.waiters -= 1;
  if (operation.waiters > 0) {
    return false;
  }
  if (activeProvisionDeviceOperations.get(operationId) !== operation) {
    // Already settled: its result is persisted and replayable, so there is
    // nothing left to cancel.
    return false;
  }
  // Retire the entry HERE, not when the abandoned promise finally settles: the
  // caller is told `operationContinues: false`, so a retry arriving while the
  // cancelled lifecycle is still unwinding must NOT join it (it would count as
  // a waiter from zero and inherit the cancellation failure). Dropping the
  // entry sends that retry through `executeProvisionDevice`, where the durable
  // operation row is the authority on whether the prior attempt is still live.
  // The settle handlers are identity-guarded, so this early delete is safe.
  activeProvisionDeviceOperations.delete(operationId);
  operation.controller.abort(
    cancellationReason ??
      new ActionableError(
        `provisionDevice operation '${operationId}' was cancelled: every caller waiting for it ` +
          "disconnected",
      ),
  );
  return true;
}

/**
 * The CEILING on how long the runtime gets to name itself before a destructive
 * action gives up on verification. Short on purpose: the caller is holding a
 * lifecycle lease and a wedged console must not turn a kill into a hang. It is a
 * ceiling and never a floor — the probe is bounded by whichever is smaller, this
 * or the caller's remaining teardown/kill deadline, and an unanswered probe
 * REFUSES the action (see {@link confirmPooledAvdIdentity}).
 */
const POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS = 3_000;

/**
 * Exported for tests only: the DEFAULT {@link
 * DeviceToolsDependencies.resolveRunningAndroidAvdName}. Production callers
 * reach it through `getDeviceToolsDependencies()`.
 */
export async function defaultResolveRunningAndroidAvdName(
  device: BootedDevice,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const { AndroidEmulatorClient } =
      await import("../utils/android-cmdline-tools/AndroidEmulatorClient");
    return await new AndroidEmulatorClient().resolveRunningAvdName(device, timeoutMs, signal);
  } catch (error) {
    if (signal?.aborted) {
      // Cancellation is not evidence about the runtime's identity, and reporting
      // it as "unresolved" would make killDevice raise an identity refusal --
      // and deleteDevice answer `target_identity_unresolved` -- for an action the
      // CALLER stopped. Propagate the cancellation instead (#6863 review).
      throw signal.reason ?? error;
    }
    // An unreachable console is one of the three expected outcomes of this
    // probe; "could not resolve" makes the caller REFUSE the destructive action,
    // so this is a warn-and-report-unresolved, never a swallow that proceeds.
    logger.warn(
      `[DeviceTools] Could not re-resolve the AVD name for ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return undefined;
  }
}

async function defaultNotifyDeviceInventoryResourcesChanged(
  installedAppResourcesChanged: boolean,
): Promise<void> {
  await notifyBootedDeviceResourcesUpdated();
  await notifyDeviceImageResourcesUpdated();
  if (installedAppResourcesChanged) {
    await notifyInstalledAppResourceListChanged();
  }
}

async function defaultNotifyResourcesChanged(): Promise<void> {
  await defaultNotifyDeviceInventoryResourcesChanged(false);
  await syncInstalledAppResources();
}

async function defaultClearInstalledAppsForDevice(deviceId: string): Promise<void> {
  const { InstalledAppsRepository } = await import("../db/installedAppsRepository");
  const repo = new InstalledAppsRepository();
  await getInstalledAppsCacheWriteCoordinator().invalidate(deviceId, () =>
    getDbWriteBarrier()
      .track(() => repo.clearDeviceSession(deviceId))
      .then(() => undefined),
  );
}

async function defaultStopAndroidObservers(device: BootedDevice): Promise<void> {
  // Resolve the per-device singleton through the statically-imported class rather
  // than a runtime `import()`. On Windows the dynamic specifier resolved to a
  // second module record with its own empty `instances` registry, so
  // getExistingInstance returned null and the observer was never detached
  // (issue #5452 CI failure). A static import shares one class identity with the
  // observe feature that created the singleton, matching the iOS CtrlProxy path.
  const observer = AndroidCtrlProxyClient.getExistingInstance(device.deviceId);
  if (!observer) {
    return;
  }
  try {
    // Detaching the per-device CtrlProxy singleton disables its auto-reconnect,
    // health-check, screenshot-backoff, and work-profile loops so they stop
    // re-referencing the emulator transport while it shuts down.
    await observer.close();
  } finally {
    // close() disables auto-reconnect permanently, so evict the detached client
    // rather than let a re-booted same-serial emulator reuse a stale one.
    AndroidCtrlProxyClient.removeInstance(device.deviceId);
  }
}

export async function notifyResourcesAfterShutdown(
  dependencies: DeviceToolsDependencies,
): Promise<void> {
  try {
    await dependencies.notifyResourcesChanged();
  } catch (error) {
    // The device is already stopped; resource subscriptions refresh on their next update.
    logger.warn(`[DeviceTools] Failed to notify resource changes after shutdown: ${error}`, error);
  }
}

/**
 * Resolves when `operation` settles or after `boundMs`, whichever comes first.
 * Never rejects: the caller only needs to know the wait is over.
 */
export async function settleWithin(
  operation: Promise<unknown>,
  timer: Timer,
  boundMs: number,
): Promise<void> {
  const deadline = new Error("Settlement wait timed out");
  try {
    await raceWithDeadline(
      operation.then(
        () => undefined,
        () => undefined,
      ),
      { timer, timeoutMs: boundMs, label: "Settlement wait", timeoutError: () => deadline },
    );
  } catch (error) {
    if (error !== deadline) {
      throw error;
    }
  }
}

export async function runWithinShutdownDeadline<T>(
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  detail: string,
  {
    requestAbortSignal,
    operation,
    timeoutMs,
    phase,
    onOrphan,
  }: {
    requestAbortSignal: AbortSignal | undefined;
    operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>;
    timeoutMs?: number;
    phase?: string;
    onOrphan?: (pending: Promise<unknown>) => void;
  },
): Promise<T> {
  const remainingMs = deadlineMs - timer.now();
  // The wait is always `remainingMs`; `timeoutMs` only names the caller's own
  // narrower budget for the message. Without one, quote the budget that
  // actually elapsed rather than the unrelated default shutdown budget.
  const reportedTimeoutMs = timeoutMs ?? Math.max(0, remainingMs);
  if (remainingMs <= 0) {
    throw shutdownTimeoutError(device, detail, reportedTimeoutMs, phase);
  }
  const deadlineController = new AbortController();
  const signal = requestAbortSignal
    ? AbortSignal.any([requestAbortSignal, deadlineController.signal])
    : deadlineController.signal;
  let timedOut = false;
  let operationSettled = false;
  const operationPromise = Promise.resolve()
    .then(() => runWithAbortSignal(signal, () => operation(signal, remainingMs)))
    .then(
      (result) => {
        operationSettled = true;
        return result;
      },
      (error) => {
        operationSettled = true;
        if (timedOut) {
          throw shutdownTimeoutError(device, detail, reportedTimeoutMs, phase);
        }
        throw error;
      },
    );
  // If the deadline wins while a platform command ignores abort, the race is
  // settled but the underlying promise remains observed rather than leaking an
  // unhandled rejection when it eventually completes.
  operationPromise.catch(() => undefined);
  try {
    return await raceWithDeadline(operationPromise, {
      timer,
      timeoutMs: remainingMs,
      signal: requestAbortSignal,
      label: "Device shutdown",
      relabelDefaultAbort: false,
      timeoutError: () => {
        timedOut = true;
        deadlineController.abort();
        return shutdownTimeoutError(device, detail, reportedTimeoutMs, phase);
      },
    });
  } catch (error) {
    if (!operationSettled) {
      onOrphan?.(operationPromise);
    }
    throw error;
  }
}

type TeardownFailurePhase = "precondition" | "stop" | "destroy" | "verification";

export type TeardownResolvedTarget =
  | {
      device: DeviceInfo;
      wasBooted: false;
    }
  | {
      device: DeviceInfo;
      wasBooted: true;
      bootedDevice: BootedDevice;
      /**
       * The pooled AVD label + epoch captured at preflight, when this target was
       * matched by a label the pool supplied rather than by a name the runtime
       * gave. Re-confirmed immediately before the platform kill (#6863 review).
       */
      pooledAvdCapture?: PooledAvdCapture;
    };

function isVirtualAndroidDevice(device: BootedDevice): boolean {
  return device.platform === "android" && isAndroidEmulatorSerial(device.deviceId);
}

export function resolveKillDeviceStableTarget(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
): StableDeviceTarget | undefined {
  if (device.platform === "ios") {
    return { platform: "ios", stableId: device.deviceId };
  }
  if (!isVirtualAndroidDevice(device)) {
    return undefined;
  }
  if (!isUnknownAndroidRuntimeName(device)) {
    return { platform: "android", stableId: device.name };
  }
  const pooledAvdName = getValidatedPooledAndroidAvdName(device, devicePool);
  return pooledAvdName ? { platform: "android", stableId: pooledAvdName } : undefined;
}

/**
 * The AVD name the pool holds for an emulator whose runtime name could not be
 * read (`Unknown (<serial>)`), or undefined when the pool cannot vouch for one.
 *
 * The rule, now that the identity model has no ADB transport id:
 *  1. the serial must be an emulator serial (`isAndroidEmulatorSerial`) — a
 *     handset's name is `ro.product.model` and there is no AVD to substitute;
 *  2. the pool must still hold a LIVE entry for that serial. The pool evicts an
 *     entry the moment discovery observes the serial disappear and re-adds it
 *     under a fresh `incarnation`, so a surviving entry is the pool's statement
 *     that it has observed no boundary for this serial — the only continuity
 *     evidence left;
 *  3. that entry must not be QUARANTINED. Once a discovery sweep observes the
 *     `Unknown (<serial>)` placeholder on a live entry, the pool flags it
 *     `identityUnresolved` (`DevicePool.isPooledIdentityUnresolved`) and its
 *     label stops standing for the runtime: the serial may have been taken over
 *     by a different AVD that simply cannot name itself either. Returning the
 *     cached label there is what let a teardown of the NEW AVD miss the booted
 *     runtime and fall through to the stopped-image inventory path. The one
 *     caller that must still SEE a quarantined entry is the destructive
 *     identity check, which reads it through
 *     {@link getPooledAndroidEntryForIdentityCheck} and turns it into a
 *     `quarantined` capture whose runtime confirmation is mandatory;
 *  4. that entry must carry an `avdName`, which the pool writes only from the
 *     AVD it itself started (`recordSourceAndroidAvd`), never from discovery.
 *
 * This is a best-effort LABEL, never proof of identity: a same-serial restart
 * faster than one discovery interval never reaches the pool, so the cached name
 * can belong to the previous occupant of the serial. Every DESTRUCTIVE caller
 * (killDevice, deleteDevice) must therefore run {@link
 * capturePooledAvdIdentity} at preflight and {@link confirmPooledAvdIdentity}
 * immediately before the platform kill, which re-resolves the name from the
 * runtime and fails closed on a mismatch -- and on a probe that does not
 * answer.
 */
function getValidatedPooledAndroidEntry(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
): PooledDevice | undefined {
  if (devicePool?.isPooledIdentityUnresolved(device.deviceId)) {
    return undefined;
  }
  return getPooledAndroidEntryForIdentityCheck(device, devicePool);
}

/**
 * The same lookup WITHOUT rule 3, for the one caller that must still see a
 * QUARANTINED entry: the destructive identity check.
 *
 * Every other consumer reads a quarantined entry as "no label" and stops there,
 * which is right for routing, publishing and matching. A kill cannot stop
 * there: dropping the entry also dropped the CONFIRMATION the label exists to
 * trigger, so the quarantined emulator fell back to the same unchecked path as
 * a runtime that named itself and a sessionless `killDevice` carrying
 * `Unknown (<serial>)` reached `AndroidEmulatorClient.killDevice` on nothing
 * but that placeholder. Quarantine is the state in which the runtime MUST be
 * made to name itself, so the check takes the entry and
 * {@link capturePooledAvdIdentity} marks the capture `quarantined`
 * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
 */
function getPooledAndroidEntryForIdentityCheck(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
): PooledDevice | undefined {
  if (device.platform !== "android" || !isUnknownAndroidRuntimeName(device)) {
    return undefined;
  }
  if (!isAndroidEmulatorSerial(device.deviceId)) {
    // A handset's name is `ro.product.model`, not an AVD; there is nothing to
    // substitute and nothing that would make a pooled label trustworthy.
    return undefined;
  }
  return devicePool?.getDevice(device.deviceId) ?? undefined;
}

function getValidatedPooledAndroidAvdName(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
): string | undefined {
  return getValidatedPooledAndroidEntry(device, devicePool)?.avdName;
}

type PooledAvdNameRefusal =
  | { reason: "conflict"; pooledAvdName: string; runtimeAvdName: string }
  | { reason: "unresolved"; pooledAvdName: string }
  | { reason: "moved"; pooledAvdName: string };

/**
 * The pooled AVD label a destructive action would otherwise act on, pinned to
 * the pool INCARNATION that label belongs to.
 *
 * Captured at PREFLIGHT and re-confirmed immediately before the platform kill.
 * `reserveDeviceForShutdown` protects the captured entry from pool eviction,
 * but it cannot stop the emulator behind the serial from disappearing and being
 * replaced before discovery notices, so the epoch is re-read at the last
 * possible moment and the runtime is asked to name itself there rather than at
 * preflight (#6863 review).
 */
interface PooledAvdCapture {
  avdName: string;
  incarnation: number;
  /**
   * The pooled entry was QUARANTINED at capture time
   * (`DevicePool.isPooledIdentityUnresolved`), so the label is not the pool's
   * statement about the runtime -- it is only the last name this daemon saw on
   * the serial. The confirmation is therefore mandatory rather than merely
   * corroborating: without a name from the runtime there is no identity at all.
   */
  quarantined?: true;
}

type PooledAvdCaptureResult =
  | { kind: "none" }
  | { kind: "capture"; capture: PooledAvdCapture }
  | { kind: "quarantined"; capture: PooledAvdCapture }
  | { kind: "refusal"; refusal: PooledAvdNameRefusal };

/**
 * The kill-time identity check `shutdownDevice` must run, carried from the
 * preflight that pinned it: the captured label + epoch, and whether the caller
 * asked to skip the console probe (#6864).
 *
 * `force` rides WITH the capture rather than beside it because the two are one
 * decision taken at one moment: whether this daemon is going to establish an
 * identity for the serial before killing it. `capture` is absent where there is
 * nothing to confirm -- an iOS target, a handset, an emulator that named itself
 * -- but `force` still travels, because it also governs the PLATFORM kill's own
 * name comparison ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874)
 * review).
 */
export interface PooledAvdKillIdentity {
  capture?: PooledAvdCapture;
  force: boolean;
}

/**
 * Outcome of the kill-time identity check.
 *
 * `skipped` is not `confirmed` with a different name: nothing was confirmed, so
 * the caller must keep the target exactly as the caller gave it rather than
 * rewrite it to a label no probe stood behind (#6864).
 */
type PooledAvdConfirmation =
  | { kind: "confirmed"; confirmedAvdName: string }
  | { kind: "skipped" }
  | { kind: "refusal"; refusal: PooledAvdNameRefusal };

/**
 * The capture a destructive action must carry into
 * {@link confirmPooledAvdIdentity}, for the two kinds that require the runtime
 * to name itself before the platform kill. `none` -- a runtime that named
 * itself, and every physical handset -- carries nothing.
 */
function pooledAvdCaptureRequiringConfirmation(
  result: PooledAvdCaptureResult,
): PooledAvdCapture | undefined {
  return result.kind === "capture" || result.kind === "quarantined" ? result.capture : undefined;
}

/**
 * The same capture, paired with the caller's `force` flag, in the shape
 * `shutdownDevice` carries into its execute step (#6864).
 */
export function pooledAvdKillIdentity(
  result: PooledAvdCaptureResult,
  force: boolean,
): PooledAvdKillIdentity {
  return { capture: pooledAvdCaptureRequiringConfirmation(result), force };
}

/**
 * An identity refusal raised from inside the shutdown path. It is an
 * {@link ActionableError} so it travels through `rethrowShutdownFailure`
 * unwrapped, and its own type lets `deleteDevice` report it as
 * `target_identity_unresolved` instead of a generic operation failure.
 */
export class PooledAvdIdentityError extends ActionableError {}

/**
 * The caller's own deadline for the destructive action, which the verification
 * probe borrows rather than starting a timer of its own.
 */
interface PooledAvdNameProbeBudget {
  timer: Timer;
  deadlineMs: number;
  signal?: AbortSignal;
}

/**
 * PREFLIGHT half of the identity check: pin the pooled label to its epoch.
 *
 * Returns `none` for every target whose name did NOT come from the pool -- a
 * runtime that named itself, and every physical handset, because
 * `ro.product.model` is not an AVD name and is not unique.
 *
 * A budget that is already spent refuses right here: with no time left the
 * runtime can never be asked to name itself, so the label can never be tied to
 * the emulator running on the serial, and refusing with the identity message is
 * strictly more actionable than the shutdown timeout that would otherwise
 * follow.
 */
export function capturePooledAvdIdentity(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
  budget: PooledAvdNameProbeBudget,
): PooledAvdCaptureResult {
  const pooled = getPooledAndroidEntryForIdentityCheck(device, devicePool);
  const avdName = pooled?.avdName;
  if (!pooled || !avdName) {
    return { kind: "none" };
  }
  if (budget.deadlineMs - budget.timer.now() <= 0) {
    return { kind: "refusal", refusal: { reason: "unresolved", pooledAvdName: avdName } };
  }
  const quarantined = devicePool?.isPooledIdentityUnresolved(device.deviceId) === true;
  return quarantined
    ? {
        kind: "quarantined",
        capture: { avdName, incarnation: pooled.incarnation, quarantined: true },
      }
    : { kind: "capture", capture: { avdName, incarnation: pooled.incarnation } };
}

/**
 * KILL-TIME half of the identity check, run immediately before the platform
 * kill on an emulator whose discovered name is `Unknown (<serial>)` and whose
 * AVD name therefore comes from the pool -- including a pool entry that is
 * QUARANTINED, where the label is not the pool's statement about the runtime
 * and this probe is the only identity evidence there is.
 *
 * Two things must still hold:
 *  - the pool must still hold the CAPTURED incarnation under that label. A new
 *    incarnation means the serial was re-allocated while this shutdown was
 *    being set up, so the captured label no longer describes the target;
 *  - the runtime must name the SAME AVD. A different AVD can take over a reused
 *    serial before discovery observes the previous one disappear, leaving the
 *    pool holding the OLD label -- and a kill issued against that label would
 *    stop the NEW emulator (#6863 review).
 *
 * Returns the CONFIRMED name so the caller can put it in the kill target:
 * `AndroidEmulatorClient.killDevice` re-discovers the serial and refuses a
 * target whose name differs from the discovered one, so handing it the
 * `Unknown (<serial>)` placeholder would throw away the proof this probe just
 * obtained.
 *
 * There is no fail-open branch. `Unknown (<serial>)` means "no information", and
 * a probe that does not answer leaves it that way -- acting anyway would be
 * acting on a label this daemon cannot tie to the runtime. The message names
 * `adb -s <serial> emu kill` as the manual escape for a wedged console.
 *
 * `force` is the TOOL-level escape from that same dead end (#6864), for a client
 * with no shell access. It skips the console probe and NOTHING else, which makes
 * the shape of what it can and cannot clear exact:
 *  - it does not override the `conflict` refusal, it removes the evidence a
 *    conflict is detected from. With no probe there is nothing to compare, so
 *    the whole contract becomes "kill whatever emulator currently occupies this
 *    serial", including a different AVD that took the serial over. The caller is
 *    told so at warn, naming the serial and the label being left unconfirmed;
 *  - it does NOT clear the `moved` refusal above, which is checked first and is
 *    not a probe failure at all: the pool RETIRED the captured epoch under this
 *    daemon's own eyes, so the target the caller named no longer exists and
 *    "act on the serial as given" would be acting on a target the caller never
 *    asked about. Re-resolving is the only correct response;
 *  - it does not reach the preflight refusal in {@link capturePooledAvdIdentity}
 *    either. That one fires only when the action's deadline is ALREADY spent, in
 *    which case nothing downstream of it can finish either.
 *
 * It DOES clear the mandatory confirmation a QUARANTINED capture otherwise
 * carries. That case is the wedged-console kill this flag exists for: the pool
 * cannot name the serial either, so the probe is still the only identity
 * evidence there is -- and when it does not answer, the quarantined kill is
 * exactly as stuck as the unquarantined one. Skipping it leaves the caller's own
 * target (the `Unknown (<serial>)` placeholder) in place, which is what the
 * serial-scoped `emu kill` needs.
 *
 * `force` never reaches here at all where there is no pooled label to skip
 * verifying -- an iOS target, a handset, or an emulator that named itself --
 * because none of those produce a capture. It is accepted and changes nothing.
 *
 * The probe is bounded by whichever is smaller, the verification ceiling or the
 * caller's REMAINING deadline: it runs inside a lifecycle lease that is already
 * on the clock, so it must never start an independent timer that can outlast it.
 */
export async function confirmPooledAvdIdentity(
  device: BootedDevice,
  capture: PooledAvdCapture,
  devicePool: DevicePool | undefined,
  resolveRunningAvdName: DeviceToolsDependencies["resolveRunningAndroidAvdName"],
  budget: PooledAvdNameProbeBudget,
  force: boolean,
): Promise<PooledAvdConfirmation> {
  const pooledAvdName = capture.avdName;
  const pooled = devicePool?.getDevice(device.deviceId);
  if (!pooled || pooled.incarnation !== capture.incarnation || pooled.avdName !== pooledAvdName) {
    logger.warn(
      `[DeviceTools] The pool no longer holds incarnation ${capture.incarnation} of ` +
        `${device.deviceId} under AVD '${pooledAvdName}'; refusing the destructive action.`,
    );
    return { kind: "refusal", refusal: { reason: "moved", pooledAvdName } };
  }
  if (force) {
    logger.warn(
      `[DeviceTools] force=true: skipping AVD-name verification for Android emulator ` +
        `'${device.deviceId}', which this daemon has recorded as AVD '${pooledAvdName}'. ` +
        "The emulator console was not asked which AVD is running there, so this acts on " +
        `whatever now occupies '${device.deviceId}' -- including a different AVD that took ` +
        "the serial over.",
    );
    return { kind: "skipped" };
  }
  if (capture.quarantined) {
    // Not an extra check, a louder one: for a quarantined entry the probe is the
    // ONLY identity evidence there is, and a refusal here is the fail-closed
    // outcome rather than a surprising one (#6863 review).
    logger.warn(
      `[DeviceTools] The pooled identity of ${device.deviceId} is quarantined; the runtime must ` +
        `name itself before this action may act on '${pooledAvdName}'.`,
    );
  }
  const remainingMs = budget.deadlineMs - budget.timer.now();
  if (remainingMs <= 0) {
    return { kind: "refusal", refusal: { reason: "unresolved", pooledAvdName } };
  }
  const runtimeAvdName = await resolveRunningAvdName(
    device,
    Math.min(POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS, remainingMs),
    budget.signal,
  );
  if (runtimeAvdName === undefined) {
    logger.warn(
      `[DeviceTools] Could not confirm that ${device.deviceId} is still AVD '${pooledAvdName}': ` +
        "the emulator console did not report a name.",
    );
    return { kind: "refusal", refusal: { reason: "unresolved", pooledAvdName } };
  }
  return runtimeAvdName === pooledAvdName
    ? { kind: "confirmed", confirmedAvdName: runtimeAvdName }
    : { kind: "refusal", refusal: { reason: "conflict", pooledAvdName, runtimeAvdName } };
}

export function pooledAvdNameRefusalMessage(
  device: BootedDevice,
  refusal: PooledAvdNameRefusal,
): string {
  if (refusal.reason === "moved") {
    return (
      `Refusing to act on Android emulator '${device.deviceId}': this daemon had it recorded as ` +
      `AVD '${refusal.pooledAvdName}', but that connection epoch was retired while this action ` +
      "was being prepared, so the emulator now on that serial is a different run. Re-resolve " +
      "the target and retry."
    );
  }
  if (refusal.reason === "conflict") {
    return (
      `Refusing to act on Android emulator '${device.deviceId}': this daemon has it recorded as ` +
      `AVD '${refusal.pooledAvdName}', but the emulator now running on that serial reports ` +
      `AVD '${refusal.runtimeAvdName}'. The serial was reused by a different AVD; re-resolve ` +
      "the target and retry."
    );
  }
  return (
    `Refusing to act on Android emulator '${device.deviceId}': this daemon has it recorded as ` +
    `AVD '${refusal.pooledAvdName}', but the emulator console on that serial did not answer, so ` +
    "the AVD actually running there could not be confirmed. Acting on the recorded name could " +
    "stop a different emulator that took the serial. Resolve the target and retry, or stop it " +
    `by hand with \`adb -s ${device.deviceId} emu kill\`.`
  );
}

/**
 * The stable AVD label a booted emulator is matched and acted on by: the name
 * the runtime gave, or the pool's label when the runtime could not name itself.
 *
 * This is the NON-DESTRUCTIVE reading: a quarantined entry reads as "no
 * label" -- rule 3 of {@link getValidatedPooledAndroidEntry} -- which is right
 * for every consumer that only needs a display name, not a target to act on.
 * The destructive teardown path uses {@link getBootedAndroidTeardownStableName}
 * instead, which sees through the quarantine.
 */
function getBootedAndroidStableName(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
): string {
  const pooledAvdName = getValidatedPooledAndroidAvdName(device, devicePool);
  return pooledAvdName ?? device.name;
}

/**
 * The same stable name for the DESTRUCTIVE path, which sees through the
 * quarantine.
 *
 * FUNNEL 1 folds a teardown's own discovery into the pool before this runs, so a
 * runtime that answers `Unknown (<serial>)` is quarantined BY THAT OBSERVATION --
 * which is the state in which every other consumer must read the pooled label as
 * "no label". Reading it that way HERE would mean a teardown could never match
 * the emulator by its pooled label at all, and the mandatory runtime
 * confirmation that exists precisely for this case
 * ({@link capturePooledAvdIdentity} -> {@link confirmPooledAvdIdentity}) would
 * become unreachable: the teardown would instead fall through to the
 * stopped-image inventory path, the failure the confirmation was built to
 * prevent.
 *
 * So the destructive path matches on the quarantine-visible label and then makes
 * the runtime name itself before the platform kill -- a strictly stronger gate
 * than refusing on the quarantine flag would be
 * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
 */
function getBootedAndroidTeardownStableName(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
): string {
  return getPooledAndroidEntryForIdentityCheck(device, devicePool)?.avdName ?? device.name;
}

// iOS `deleteDevice` targets are frequently expressed by name (the identifier
// `provisionDevice` echoes back), not by UDID. Matching only on `deviceId`
// leaves a name-based lookup unresolved even though the simulator is present,
// which upstream callers treat as proof of absence (#6250). Match on either
// the UDID or the display name so name-based delete resolves to the real
// device, and only a lookup that matches neither is treated as "not found".
function matchesIosTeardownIdentity(device: { deviceId?: string; name: string }, stableId: string) {
  return device.deviceId === stableId || device.name === stableId;
}

function matchesTeardownStableId(
  device: BootedDevice,
  stableId: string,
  devicePool: DevicePool | undefined,
): boolean {
  // The name-or-UDID fallback is an iOS-only concern (#6250 delete-by-name).
  // Branching explicitly on platform keeps a physical Android device whose
  // `name` happens to collide with an unrelated target's stableId from being
  // captured by that fallback; Android keeps matching by stable AVD name /
  // deviceId only.
  if (device.platform === "ios") {
    return matchesIosTeardownIdentity(device, stableId);
  }
  return isVirtualAndroidDevice(device)
    ? getBootedAndroidTeardownStableName(device, devicePool) === stableId
    : device.deviceId === stableId;
}

export function teardownDeadlineDevice(args: TeardownDeviceArgs): BootedDevice {
  return {
    platform: args.target.platform,
    name: args.target.stableId,
    deviceId: args.target.stableId,
  };
}

function createTeardownResponse(
  args: TeardownDeviceArgs,
  state: "destroyed" | "already_absent",
  command: { stop: "accepted" | "not_required"; destroy: "accepted" | "not_required" },
  verification: { notRunning: "confirmed"; inventory: "complete_absence_confirmed" },
  resolved?: DeviceInfo,
  timing?: unknown,
) {
  return createStructuredToolResponse({
    operationId: args.operationId,
    mode: args.mode,
    state,
    target: {
      stableId: args.target.stableId,
      stableName: args.target.stableName,
      platform: resolved?.platform ?? args.target.platform,
      isVirtual: args.target.isVirtual,
    },
    command,
    verification,
    timing,
  });
}

export function createTeardownFailureResponse(
  args: TeardownDeviceArgs,
  phase: TeardownFailurePhase,
  code: string,
  message: string,
  resolved?: DeviceInfo,
) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: message,
          operationId: args.operationId,
          mode: args.mode,
          state: "failed",
          target: {
            stableId: args.target.stableId,
            stableName: args.target.stableName,
            platform: resolved?.platform ?? args.target.platform,
            isVirtual: args.target.isVirtual,
          },
          failure: { code, phase, message },
        }),
      },
    ],
  };
}

function findMatchingBootedTeardownDevices(
  discovery: BootedDeviceDiscovery,
  args: TeardownDeviceArgs,
  devicePool: DevicePool | undefined,
): BootedDevice[] {
  return discovery.devices.filter(
    (device) =>
      device.platform === args.target.platform &&
      matchesTeardownStableId(device, args.target.stableId, devicePool),
  );
}

function createBootedTeardownTarget(
  device: BootedDevice,
  args: TeardownDeviceArgs,
  devicePool: DevicePool | undefined,
): { target?: TeardownResolvedTarget; conflict?: string; unsupported?: string } {
  const stableName =
    device.platform === "android"
      ? getBootedAndroidTeardownStableName(device, devicePool)
      : device.name;
  if (args.target.stableName && args.target.stableName !== stableName) {
    return { conflict: "The requested stable name does not match the booted device identity." };
  }
  if (device.platform === "android" && !isVirtualAndroidDevice(device)) {
    return {
      unsupported:
        "Physical Android devices do not have a deletable platform device representation.",
    };
  }
  return {
    target: {
      device: {
        ...device,
        name: stableName,
        isRunning: true,
      },
      wasBooted: true,
      bootedDevice: {
        ...device,
        name: stableName,
      },
    },
  };
}

function findBootedTeardownTarget(
  discovery: BootedDeviceDiscovery,
  args: TeardownDeviceArgs,
  devicePool: DevicePool | undefined,
): { target?: TeardownResolvedTarget; conflict?: string; unsupported?: string } {
  const matchingId = findMatchingBootedTeardownDevices(discovery, args, devicePool);
  if (matchingId.length > 1) {
    return { conflict: "Multiple booted devices matched the requested stable ID." };
  }
  const device = matchingId[0];
  if (device) {
    if (
      device.platform === "android" &&
      isUnknownAndroidRuntimeName(device) &&
      !devicePool?.getDevice(device.deviceId)?.avdName
    ) {
      return {
        unsupported:
          "Cannot safely identify the requested booted Android AVD because its runtime name is unknown.",
      };
    }
    return createBootedTeardownTarget(device, args, devicePool);
  }
  return {};
}

function findInventoryTeardownTarget(
  discovery: DeviceImageDiscovery,
  args: TeardownDeviceArgs,
): { target?: TeardownResolvedTarget; conflict?: string } {
  const matches = discovery.devices.filter(
    (device) =>
      device.platform === args.target.platform &&
      (device.platform === "ios"
        ? matchesIosTeardownIdentity(device, args.target.stableId)
        : device.name === args.target.stableId),
  );
  if (matches.length > 1) {
    return {
      conflict: "Multiple platform device representations matched the requested stable ID.",
    };
  }
  const device = matches[0];
  if (device && args.target.stableName && args.target.stableName !== device.name) {
    return { conflict: "The requested stable name does not match the platform device identity." };
  }
  return device ? { target: { device: { ...device, isRunning: false }, wasBooted: false } } : {};
}

function inventoryContainsTarget(
  discovery: DeviceImageDiscovery,
  target: TeardownResolvedTarget,
): boolean {
  return discovery.devices.some(
    (device) =>
      device.platform === target.device.platform &&
      (device.platform === "ios"
        ? device.deviceId === target.device.deviceId
        : device.name === target.device.name),
  );
}

function completedInventoryFor(
  discovery: { succeededPlatforms: Set<SomePlatform> },
  platform: SomePlatform,
): boolean {
  return discovery.succeededPlatforms.has(platform);
}

export type TeardownToolResponse =
  | ReturnType<typeof createTeardownResponse>
  | ReturnType<typeof createTeardownFailureResponse>;

export interface ProvisionDeviceCleanup {
  status: "succeeded" | "failed";
  operationId: string;
  target: TeardownDeviceArgs["target"];
  state?: string;
  failure?: {
    code: string;
    phase: string;
    message: string;
  };
}

export type RecordProvisionDeviceLifecycle = (
  lifecycle: ProvisionDeviceLifecycleOutcome,
) => Promise<void>;

const provisionDeviceLifecycleByError = new WeakMap<object, ProvisionDeviceLifecycleOutcome>();

export function attachProvisionDeviceLifecycle<T extends object>(
  error: T,
  lifecycle: ProvisionDeviceLifecycleOutcome,
): T {
  provisionDeviceLifecycleByError.set(error, lifecycle);
  return error;
}

function lifecycleForProvisionDeviceError(
  error: unknown,
): ProvisionDeviceLifecycleOutcome | undefined {
  return typeof error === "object" && error !== null
    ? provisionDeviceLifecycleByError.get(error)
    : undefined;
}

export function lifecycleForProvisionResponseError(
  error: unknown,
): ProvisionDeviceLifecycleOutcome | undefined {
  if (error instanceof ProvisionDeviceOperationFailedError) {
    return error.lifecycle;
  }
  if (error instanceof ProvisionDeviceOperationInProgressError) {
    return error.lifecycle;
  }
  return lifecycleForProvisionDeviceError(error);
}

export function lifecycleStateForCleanup(
  cleanup: ProvisionDeviceCleanup,
): ProvisionDeviceLifecycleOutcome["state"] {
  if (cleanup.status === "succeeded") {
    return "removed";
  }
  return cleanup.failure?.code === "mutation_settlement_timeout"
    ? "cleanup_in_progress"
    : "retained";
}

export function lifecycleCleanupStatus(
  cleanup: ProvisionDeviceCleanup,
): NonNullable<ProvisionDeviceLifecycleOutcome["cleanup"]>["status"] {
  if (cleanup.status === "succeeded") {
    return "succeeded";
  }
  return cleanup.failure?.code === "mutation_settlement_timeout" ? "in_progress" : "failed";
}

type AdmittedProvisionDeviceOperation = Extract<
  ProvisionDeviceOperationBeginResult,
  { reconcileExistingConfiguration: boolean }
>;

export function assertProvisionDeviceOperationAdmitted(
  operation: ProvisionDeviceOperationBeginResult,
  operationId: string,
): asserts operation is AdmittedProvisionDeviceOperation {
  if ("inProgress" in operation) {
    throw new ProvisionDeviceOperationInProgressError(operationId, operation.lifecycle);
  }
  if ("failed" in operation) {
    throw new ProvisionDeviceOperationFailedError(
      operationId,
      operation.errorCode,
      operation.message,
      operation.lifecycle,
    );
  }
}

export class ProvisionDeviceRollbackError extends ProvisionDeviceError {
  constructor(
    readonly provisionFailure: ProvisionDeviceError,
    readonly cleanup: ProvisionDeviceCleanup,
  ) {
    super(
      cleanup.status === "failed" ? "cleanup_failed" : provisionFailure.code,
      cleanup.status === "failed"
        ? `${provisionFailure.message} Cleanup of the newly created device also failed: ${
            cleanup.failure?.message ?? "unknown cleanup failure"
          }`
        : provisionFailure.message,
      // Retry risks an identity collision while the failed-rollback device may still exist.
      cleanup.status === "failed" ? false : provisionFailure.retryable,
      provisionFailure.diagnostics,
    );
    this.name = "ProvisionDeviceRollbackError";
  }
}

// Exported for direct testing: a reused `operationId` is an idempotent replay
// only when this string matches EXACTLY
// (`DeviceTeardownOperationRepository.resolveExisting` compares the persisted
// text), so the fingerprint's stability across daemon versions is a contract in
// its own right.
export function teardownOperationFingerprint(args: TeardownDeviceArgs): string {
  return stableStringify({
    target: args.target,
    mode: args.mode,
    verifyAbsence: args.verifyAbsence,
    timeoutMs: args.timeoutMs,
    cancellationPolicy: args.cancellationPolicy,
    // A forced teardown is a materially different request from a verified one,
    // so reusing an operationId across the two is a fingerprint mismatch rather
    // than an idempotent replay of the other (#6864).
    //
    // Present ONLY when true. `stableStringify` is `JSON.stringify`, which drops
    // `undefined` fields, so an unforced request still serializes to the exact
    // bytes a pre-`force` daemon wrote. Spelling it `force: false` instead would
    // make every teardown row persisted before the upgrade -- and still inside
    // its five-minute result TTL when the daemon restarts -- fail to match the
    // identical unforced retry, turning a replay into `operation_id_conflict`
    // ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review).
    ...(args.force ? { force: true } : {}),
  });
}

export function isTeardownFailure(response: TeardownToolResponse): boolean {
  return "isError" in response && response.isError === true;
}

let deviceTeardownService: DeviceTeardownService | undefined;

export function getDeviceTeardownService(
  dependencies: DeviceToolsDependencies,
): DeviceTeardownService {
  deviceTeardownService ??= new DeviceTeardownService({
    lifecycleCoordinator: dependencies.lifecycleCoordinator,
    operationStore: dependencies.teardownDeviceOperationStoreFactory(),
    timer: dependencies.timer,
    resultTtlMs: TEARDOWN_OPERATION_RESULT_TTL_MS,
  });
  return deviceTeardownService;
}

type TeardownResolution = { target: TeardownResolvedTarget } | { response: TeardownToolResponse };

export interface TeardownContext {
  args: TeardownDeviceArgs;
  dependencies: DeviceToolsDependencies;
  deviceManager: PlatformDeviceManager;
  requestAbortSignal: AbortSignal | undefined;
  deadlineDevice: BootedDevice;
  deadlineMs: number;
  timeoutMs: number;
  cancelOnRequestAbort: boolean;
  lifecycleLease?: VirtualDeviceLifecycleLease;
  /** Android runtime and pool state captured by the first teardown booted scan. */
  initialScan: TeardownInitialAndroidScan;
  /**
   * `force` exists to escape wedged emulator consoles, so every Android
   * discovery run for THIS teardown must stay serial-only rather than
   * re-probing consoles one call site at a time (#6946). Computed once at
   * context construction so a new discovery added to this flow inherits the
   * mode automatically instead of silently reintroducing a name-aware scan.
   */
  mode: "named" | "serial-only";
}

interface TeardownInitialAndroidScan {
  serials: Set<string>;
  pooledEntries: PooledDevice[];
}

function teardownProbeBudget(context: TeardownContext): {
  signal: AbortSignal | undefined;
  remainingMs: number;
} {
  return {
    signal: context.requestAbortSignal,
    remainingMs: Math.min(
      POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS,
      context.deadlineMs - context.dependencies.timer.now(),
    ),
  };
}

function captureTeardownInitialAndroidScan(
  booted: BootedDeviceDiscovery,
  devicePool: DevicePool | undefined,
): TeardownInitialAndroidScan {
  return {
    serials: new Set(
      booted.devices
        .filter((device) => device.platform === "android")
        .map((device) => device.deviceId),
    ),
    pooledEntries:
      devicePool?.getAllDevices().filter((device) => device.platform === "android") ?? [],
  };
}

export async function stopSegmentedVideoRecordingsBeforeDestroy(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<void> {
  await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    "segmented video recording teardown did not complete",
    {
      requestAbortSignal: context.requestAbortSignal,
      operation: async () => await stopSegmentedVideoRecordingsForDevice(target.device),
      timeoutMs: context.timeoutMs,
    },
  );
}

async function readTeardownBootedDiscovery(
  context: TeardownContext,
  detail = "booted-device precondition discovery did not complete",
  discoveryMode: "context" | "name-aware" = "context",
): Promise<BootedDeviceDiscovery> {
  const skipAndroidNameEnrichment = discoveryMode === "context" && context.mode === "serial-only";
  return await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    detail,
    {
      requestAbortSignal: context.requestAbortSignal,
      operation: async () => {
        const discovery = await context.deviceManager.getBootedDevicesDetailed(
          context.args.target.platform,
          {
            bypassAndroidDeviceListCache: true,
            ...(skipAndroidNameEnrichment ? { skipAndroidNameEnrichment: true } : {}),
          },
        );
        // FUNNEL 1: teardown reads pooled entries (`findAbsentTeardownPooledDevices`)
        // against this observation (#6863 review).
        await reconcileDiscoveryObservation(discovery.devices, "teardown-precondition", {
          // Same exemption as the shutdown preflight: a `deleteDevice` cancelled
          // by its own observation returns `operation_cancelled` while its
          // accepted teardown carries on
          // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
          excludeExecutionId: getShutdownInitiatingExecutionId(),
          namesResolved: !skipAndroidNameEnrichment,
        });
        return discovery;
      },
      timeoutMs: context.timeoutMs,
    },
  );
}

/**
 * The booted scan target RESOLUTION reads, which for a forced teardown must not
 * be the name-aware one.
 *
 * Normal discovery enriches every attached emulator with `emu avd name`,
 * sequentially, budgeting 2s each. That happens BEFORE the forced branch in
 * `AndroidEmulatorClient.killDevice` can skip its own probe, so three wedged
 * consoles spend 6s of a 5s forced teardown inside discovery and `emu kill` is
 * never dispatched -- the flag times out in the exact state it exists for
 * ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review). Forced, the
 * first scan therefore lists serials and asks nothing; the pool supplies the AVD
 * label for an emulator this daemon started, including a quarantined one.
 *
 * It is a FAST PATH, not a replacement. An emulator the pool never started has
 * no label to supply, and a serial-only scan can only answer the placeholder for
 * it, so when the cheap scan matches nothing the name-aware scan still runs on
 * the remaining deadline and resolution is unchanged. `force` must not become
 * the one call that cannot find a healthy, name-addressed AVD.
 */
async function readTeardownTargetDiscovery(
  context: TeardownContext,
  devicePool: DevicePool | undefined,
): Promise<BootedDeviceDiscovery> {
  if (context.mode !== "serial-only" || context.args.target.platform !== "android") {
    return await readTeardownBootedDiscovery(context);
  }
  const serialOnly = await readTeardownBootedDiscovery(context);
  return findMatchingBootedTeardownDevices(serialOnly, context.args, devicePool).length > 0
    ? serialOnly
    : await readTeardownBootedDiscovery(context, undefined, "name-aware");
}

interface TeardownInventoryDiscovery extends DeviceImageDiscovery {
  androidSources?: {
    emulatorAvdNames: Set<string>;
    avdManagerAvdNames: Set<string>;
    incompleteSources: string[];
  };
}

async function readTeardownInventory(
  context: TeardownContext,
  platform: SomePlatform,
  detail: string,
): Promise<TeardownInventoryDiscovery> {
  return await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    detail,
    {
      requestAbortSignal: context.requestAbortSignal,
      operation: async (signal) => {
        const platformInventory = await context.deviceManager.getDeviceImagesDetailed(platform, {
          bypassIosDeviceListCache: true,
          signal,
        });
        if (platform !== "android") {
          return platformInventory;
        }

        const avdManagerResult = await Promise.allSettled([
          context.dependencies.avdManagerFactory().listDeviceImages(signal),
        ]);
        const [avdManagerInventory] = avdManagerResult;
        if (avdManagerInventory.status === "rejected") {
          signal.throwIfAborted();
          const message = `avdmanager list avd failed: ${errorMessage(avdManagerInventory.reason)}`;
          logger.warn(`[DeviceTools] ${message}`, avdManagerInventory.reason);
          const succeededPlatforms = new Set(platformInventory.succeededPlatforms);
          succeededPlatforms.delete("android");
          const incompleteSources = platformInventory.succeededPlatforms.has("android")
            ? []
            : ["emulator -list-avds"];
          const existingAndroidError = platformInventory.discoveryErrors?.android;
          return {
            ...platformInventory,
            succeededPlatforms,
            discoveryErrors: {
              ...platformInventory.discoveryErrors,
              android: existingAndroidError
                ? {
                    ...existingAndroidError,
                    message: `${existingAndroidError.message} ${message}`,
                  }
                : { code: "failed", message },
            },
            androidSources: {
              emulatorAvdNames: new Set(
                platformInventory.devices
                  .filter((device) => device.platform === "android")
                  .map((device) => device.name),
              ),
              avdManagerAvdNames: new Set(),
              incompleteSources: [...incompleteSources, "avdmanager list avd"],
            },
          };
        }

        const emulatorAvdNames = new Set(
          platformInventory.devices
            .filter((device) => device.platform === "android")
            .map((device) => device.name),
        );
        const avdManagerAvdNames = new Set(avdManagerInventory.value.map((avd) => avd.name));
        const devices = [...platformInventory.devices];
        for (const avd of avdManagerInventory.value) {
          if (!emulatorAvdNames.has(avd.name)) {
            devices.push({ platform: "android", name: avd.name, isRunning: false });
          }
        }
        return {
          ...platformInventory,
          devices,
          androidSources: {
            emulatorAvdNames,
            avdManagerAvdNames,
            incompleteSources: platformInventory.succeededPlatforms.has("android")
              ? []
              : ["emulator -list-avds"],
          },
        };
      },
      timeoutMs: context.timeoutMs,
    },
  );
}

async function evictTeardownManagers(context: TeardownContext, runtimeId?: string): Promise<void> {
  const { platform, stableId } = context.args.target;
  if (platform === "ios") {
    if (runtimeId) {
      await IOSCtrlProxyManager.evict(runtimeId, context.dependencies.timer, context.deadlineMs);
    } else {
      await IOSCtrlProxyManager.evict(stableId, context.dependencies.timer, context.deadlineMs);
      await IOSCtrlProxyManager.evictSimulatorByName(
        stableId,
        context.dependencies.timer,
        context.deadlineMs,
      );
    }
  } else {
    AndroidCtrlProxyManager.evict(runtimeId ?? stableId, stableId);
  }
}

export async function finalizeTeardownEviction(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  androidManager: AndroidCtrlProxyManager | undefined,
): Promise<void> {
  unregisterDirectSessionsForStableIdentity(
    target.device.platform,
    target.device.platform === "android"
      ? target.device.name
      : (target.device.deviceId ?? context.args.target.stableId),
  );
  if (androidManager) {
    AndroidCtrlProxyManager.evictInstance(androidManager);
  } else {
    await evictTeardownManagers(context, target.device.deviceId);
  }
}

async function resolveAbsentTeardownTarget(
  context: TeardownContext,
  booted: BootedDeviceDiscovery,
  inventory: DeviceImageDiscovery,
): Promise<TeardownResolution> {
  const bootedComplete = completedInventoryFor(booted, context.args.target.platform);
  const inventoryComplete = completedInventoryFor(inventory, context.args.target.platform);
  if (!bootedComplete || !inventoryComplete) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "inventory_incomplete",
        "Cannot prove the target is absent because one or more platform inventories did not complete.",
      ),
    };
  }
  const daemonState = DaemonState.getInstance();
  const runtimeId = daemonState.isInitialized()
    ? findAbsentTeardownPooledDevices(daemonState.getDevicePool(), context.args.target)[0]?.id
    : undefined;
  const androidManager =
    context.args.target.platform === "android" && runtimeId
      ? AndroidCtrlProxyManager.getExistingInstance(runtimeId)
      : undefined;
  await retireAbsentTeardownOwnership(context);
  if (androidManager) {
    AndroidCtrlProxyManager.evictInstance(androidManager);
  } else {
    await evictTeardownManagers(context, runtimeId);
  }
  unregisterDirectSessionsForStableIdentity(
    context.args.target.platform,
    context.args.target.stableId,
  );
  void notifyResourcesAfterShutdown(context.dependencies);
  return {
    response: createTeardownResponse(
      context.args,
      "already_absent",
      { stop: "not_required", destroy: "not_required" },
      { notRunning: "confirmed", inventory: "complete_absence_confirmed" },
    ),
  };
}

async function resolveInventoryTeardownTarget(
  context: TeardownContext,
  booted: BootedDeviceDiscovery,
  inventory: DeviceImageDiscovery,
): Promise<TeardownResolution> {
  const resolution = findInventoryTeardownTarget(inventory, context.args);
  if (resolution.conflict) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_conflict",
        resolution.conflict,
      ),
    };
  }
  const target = resolution.target;
  if (!target) {
    return await resolveAbsentTeardownTarget(context, booted, inventory);
  }
  if (!completedInventoryFor(booted, target.device.platform)) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "booted_inventory_incomplete",
        `Cannot confirm ${target.device.platform} target '${target.device.name}' is not running.`,
        target.device,
      ),
    };
  }
  // findInventoryTeardownTarget already deduped this match against the
  // complete iOS inventory, so only the UDID rebind remains here.
  await rebindIosTeardownLease(context, target);
  return { target };
}

/**
 * A booted-device match found via the iOS name fallback only checked the
 * *booted* device list, so a name that also matches a distinct *stopped*
 * simulator was never detected as ambiguous (#6250 review). Re-check the
 * requested name against the complete iOS inventory (booted + stopped)
 * before committing to it, and rebind the teardown lifecycle lease to the
 * resolved UDID so it shares the same keyspace as start/provision leases.
 */
async function finalizeIosNameResolvedTeardownTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<TeardownResolution> {
  if (target.device.platform !== "ios" || context.args.target.stableId === target.device.deviceId) {
    return { target };
  }
  const inventory = await readTeardownInventory(
    context,
    "ios",
    "platform inventory precondition did not complete",
  );
  if (!completedInventoryFor(inventory, "ios")) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "inventory_incomplete",
        "Cannot resolve the requested iOS device name against the complete inventory because platform discovery did not complete.",
        target.device,
      ),
    };
  }
  const matches = inventory.devices.filter(
    (device) =>
      device.platform === "ios" && matchesIosTeardownIdentity(device, context.args.target.stableId),
  );
  if (matches.length > 1) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_conflict",
        "Multiple iOS devices matched the requested stable name; refusing to guess which one to delete.",
        target.device,
      ),
    };
  }
  await rebindIosTeardownLease(context, target);
  return { target };
}

/**
 * Delete-by-name reserves the teardown lease under the supplied display
 * name, but iOS start/provision paths reserve the same simulator by UDID
 * (#6250 review). Rebind to the resolved UDID once the name has resolved to
 * a real device so the lease actually shares a keyspace with — and mutually
 * excludes — a concurrent start/provision of that simulator.
 */
async function rebindIosTeardownLease(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<void> {
  const resolvedUdid = target.device.deviceId;
  if (
    target.device.platform !== "ios" ||
    !resolvedUdid ||
    context.args.target.stableId === resolvedUdid ||
    !context.lifecycleLease
  ) {
    return;
  }
  await context.lifecycleLease.bindCanonicalIdentity({
    platform: "ios",
    stableId: resolvedUdid,
  });
}

export async function resolveTeardownTarget(context: TeardownContext): Promise<TeardownResolution> {
  const daemonState = DaemonState.getInstance();
  const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
  const booted = await readTeardownTargetDiscovery(context, devicePool);
  context.initialScan = captureTeardownInitialAndroidScan(booted, devicePool);
  // A booted emulator only matches this teardown by its POOLED AVD name when its
  // runtime name is unknown. Pin that label to its epoch here; the runtime is
  // made to confirm it immediately before the stop's platform kill, which is
  // also where `createBootedTeardownTarget` has already rewritten the target's
  // name to the pooled label (#6863 review).
  const [matchedBootedCandidate] = findMatchingBootedTeardownDevices(
    booted,
    context.args,
    devicePool,
  );
  const pooledAvdCapture: PooledAvdCaptureResult = matchedBootedCandidate
    ? capturePooledAvdIdentity(matchedBootedCandidate, devicePool, {
        timer: context.dependencies.timer,
        deadlineMs: context.deadlineMs,
        signal: context.requestAbortSignal,
      })
    : { kind: "none" };
  if (matchedBootedCandidate && pooledAvdCapture.kind === "refusal") {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_unresolved",
        pooledAvdNameRefusalMessage(matchedBootedCandidate, pooledAvdCapture.refusal),
      ),
    };
  }
  const bootedTarget = findBootedTeardownTarget(booted, context.args, devicePool);
  if (bootedTarget.conflict) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_conflict",
        bootedTarget.conflict,
      ),
    };
  }
  if (bootedTarget.unsupported) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_not_destroyable",
        bootedTarget.unsupported,
      ),
    };
  }
  if (bootedTarget.target) {
    const captureRequiringConfirmation = pooledAvdCaptureRequiringConfirmation(pooledAvdCapture);
    const resolvedTarget: TeardownResolvedTarget =
      bootedTarget.target.wasBooted && captureRequiringConfirmation
        ? { ...bootedTarget.target, pooledAvdCapture: captureRequiringConfirmation }
        : bootedTarget.target;
    return await finalizeIosNameResolvedTeardownTarget(context, resolvedTarget);
  }
  // Nothing booted matched this teardown, so the next step is the STOPPED-image
  // inventory path -- and a booted emulator that could not name itself may be
  // the very AVD whose image is about to be destroyed.
  //
  // The question is answered from THIS discovery, not from the pool. The pool's
  // quarantine encodes exactly this observation, but only from the sweep that
  // FOLLOWS it: on the first discovery after a different AVD takes a pooled
  // serial, the pool still holds the previous occupant's label and reading it
  // here would treat the placeholder as resolved -- which is what let a
  // teardown of the new AVD miss the booted runtime and destroy its image while
  // it was running. The teardown's own observation is the newer evidence of the
  // two, so it decides ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863)
  // review).
  const unresolvedAndroidRuntime = booted.devices.find(
    (device) =>
      device.platform === "android" &&
      isVirtualAndroidDevice(device) &&
      isUnknownAndroidRuntimeName(device),
  );
  if (unresolvedAndroidRuntime) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_unresolved",
        `Android emulator runtime '${unresolvedAndroidRuntime.deviceId}' has no resolvable AVD name; refusing deletion.`,
      ),
    };
  }
  const inventory = await readTeardownInventory(
    context,
    context.args.target.platform,
    "platform inventory precondition did not complete",
  );
  return await resolveInventoryTeardownTarget(context, booted, inventory);
}

function findStoppedTeardownPooledDevices(
  devicePool: DevicePool,
  target: TeardownResolvedTarget,
): PooledDevice[] {
  return devicePool
    .getAllDevices()
    .filter(
      (device) =>
        device.platform === target.device.platform &&
        (device.platform === "ios"
          ? device.id === target.device.deviceId
          : (device.avdName ?? device.name) === target.device.name),
    );
}

function findAbsentTeardownPooledDevices(
  devicePool: DevicePool,
  target: TeardownDeviceArgs["target"],
): PooledDevice[] {
  return devicePool
    .getAllDevices()
    .filter(
      (device) =>
        device.platform === target.platform &&
        (device.platform === "ios"
          ? device.id === target.stableId
          : (device.avdName ?? device.name) === target.stableId),
    );
}

async function retireTeardownPooledOwnership(
  context: TeardownContext,
  expectedPooledDevice: PooledDevice,
  name: string,
): Promise<void> {
  const devicePool = DaemonState.getInstance().getDevicePool();
  const reservation = await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    "stopped-device ownership reservation did not complete",
    {
      requestAbortSignal: context.requestAbortSignal,
      operation: async (signal) =>
        await devicePool.reserveDeviceForShutdown(expectedPooledDevice.id, signal),
      timeoutMs: context.timeoutMs,
    },
  );
  const releaseReservation = async (): Promise<void> => {
    try {
      await reservation?.release();
    } catch (error) {
      // Release is best-effort cleanup and must not replace the shutdown outcome.
      logger.warn(
        `[DeviceTools] Failed to release teardown shutdown reservation for ${expectedPooledDevice.id}: ${errorMessage(error)}`,
        error,
      );
    }
  };
  if (!reservation || reservation.device !== expectedPooledDevice) {
    await releaseReservation();
    return;
  }

  let retainsReservation = false;
  const retainReservationUntil = (retirement: Promise<unknown>): void => {
    retainsReservation = true;
    void retirement.then(releaseReservation, (error) => {
      // A failed retirement has not proved disappearance. Keep this exact
      // pooled incarnation unavailable until a later explicit recovery.
      logger.warn(
        `[DeviceTools] Retaining teardown shutdown reservation for ${expectedPooledDevice.id}: ${error}`,
      );
    });
  };
  const retirementDevice: BootedDevice = {
    platform: expectedPooledDevice.platform,
    name,
    deviceId: expectedPooledDevice.id,
  };
  try {
    await stopVideoRecordingsBeforeShutdown(
      {
        device: retirementDevice,
        timer: context.dependencies.timer,
        deadlineMs: context.deadlineMs,
        timeoutMs: context.timeoutMs,
        requestAbortSignal: context.requestAbortSignal,
        retainReservationUntil,
      },
      createPerformanceTracker(true),
    );
    await retireShutdownOwnership(
      {
        device: retirementDevice,
        expectedPooledDevice,
        expectedSession: reservation.session,
        deviceManager: context.deviceManager,
        timer: context.dependencies.timer,
        deadlineMs: context.deadlineMs,
        requestAbortSignal: context.requestAbortSignal,
        stopPerformanceMonitoring: context.dependencies.stopPerformanceMonitoring,
        retainReservationUntil,
      },
      undefined,
      false,
      {
        retryAfterDiscoveryFailure: false,
        strictDeadline: true,
        timeoutMs: context.timeoutMs,
        terminalReleaseRetriesRemaining: DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
        skipAndroidNameEnrichment: context.args.force ?? false,
      },
    );
  } finally {
    if (!retainsReservation) {
      await releaseReservation();
    }
  }
}

export async function retireStoppedTeardownOwnership(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<void> {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const expectedPooledDevices = findStoppedTeardownPooledDevices(
    daemonState.getDevicePool(),
    target,
  );
  for (const expectedPooledDevice of expectedPooledDevices) {
    await retireTeardownPooledOwnership(context, expectedPooledDevice, target.device.name);
  }
}

async function retireAbsentTeardownOwnership(context: TeardownContext): Promise<void> {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const expectedPooledDevices = findAbsentTeardownPooledDevices(
    daemonState.getDevicePool(),
    context.args.target,
  );
  for (const expectedPooledDevice of expectedPooledDevices) {
    await retireTeardownPooledOwnership(
      context,
      expectedPooledDevice,
      expectedPooledDevice.platform === "android"
        ? (expectedPooledDevice.avdName ?? expectedPooledDevice.name)
        : expectedPooledDevice.name,
    );
  }
}

export async function destroyTeardownTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  retainStableLifecycleUntil: (operation: Promise<unknown>) => void,
  markDestructionStarted: () => void,
  onLateSuccess: () => void,
): Promise<void> {
  const deadlineTarget: BootedDevice = {
    name: target.device.name,
    platform: target.device.platform,
    deviceId: target.device.deviceId ?? context.args.target.stableId,
  };
  let destroy: Promise<void> | undefined;
  try {
    await runWithinShutdownDeadline(
      deadlineTarget,
      context.dependencies.timer,
      context.deadlineMs,
      "platform deletion command did not complete",
      {
        requestAbortSignal: context.requestAbortSignal,
        operation: async (signal, timeoutMs) => {
          markDestructionStarted();
          destroy = context.deviceManager.destroyDevice(target.device, {
            signal,
            timeoutMs,
            lifecycleLease: context.lifecycleLease,
          });
          return await destroy;
        },
        timeoutMs: context.timeoutMs,
      },
    );
  } catch (error) {
    if (destroy) {
      retainStableLifecycleUntil(destroy);
      if (!context.cancelOnRequestAbort || target.device.platform === "ios") {
        void destroy.then(
          () => onLateSuccess(),
          () => {
            // A rejected late destroy did not remove the platform device, so no eviction is safe.
            logger.debug("[DeviceTools] Late platform deletion rejected; retaining teardown state");
          },
        );
      } else {
        // A deadline-critical Android teardown keeps the identity reservation
        // until the command settles, but a late completion cannot safely evict a
        // later AVD incarnation with the same replaceable name. iOS uses an
        // immutable UDID, so its late-success path still finalizes stale state.
        void destroy.catch(() => undefined);
      }
    }
    throw error;
  }
}

export async function checkForRestartedTeardownTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  phase: "stop" | "verification",
): Promise<TeardownToolResponse | undefined> {
  if (target.device.platform !== "android") {
    return undefined;
  }
  const booted = await readTeardownBootedDiscovery(
    context,
    phase === "stop"
      ? "post-shutdown booted-device discovery did not complete"
      : "post-delete booted-device discovery did not complete",
  );
  if (!completedInventoryFor(booted, target.device.platform)) {
    return createTeardownFailureResponse(
      context.args,
      phase,
      "booted_inventory_incomplete",
      "Cannot confirm the Android AVD is not running.",
      target.device,
    );
  }
  const daemonState = DaemonState.getInstance();
  const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
  const newlyAppearedUnresolvedRuntime = booted.devices.find(
    (device) =>
      device.platform === "android" &&
      isVirtualAndroidDevice(device) &&
      isUnknownAndroidRuntimeName(device) &&
      !getValidatedPooledAndroidAvdName(device, devicePool) &&
      (!context.initialScan.serials.has(device.deviceId) ||
        (target.wasBooted && device.deviceId === target.bootedDevice.deviceId)),
  );
  if (newlyAppearedUnresolvedRuntime) {
    return createTeardownFailureResponse(
      context.args,
      phase,
      "target_identity_unresolved",
      `A new Android emulator runtime '${newlyAppearedUnresolvedRuntime.deviceId}' appeared ` +
        "without a resolvable AVD name; refusing deletion.",
      target.device,
    );
  }
  const serialOnlyRestart = await checkForSerialOnlyAndroidTeardownRestart(
    context,
    target,
    booted,
    phase,
  );
  if (serialOnlyRestart) {
    return serialOnlyRestart;
  }
  const replacement = findMatchingBootedTeardownDevices(booted, context.args, devicePool)[0];
  if (!replacement) {
    return undefined;
  }
  return createTeardownFailureResponse(
    context.args,
    phase,
    phase === "stop" ? "target_restarted" : "target_still_running",
    phase === "stop"
      ? "The Android AVD restarted after shutdown confirmation; refusing deletion."
      : "The Android AVD is still running after deletion.",
    target.device,
  );
}

async function checkForSerialOnlyAndroidTeardownRestart(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  booted: BootedDeviceDiscovery,
  phase: "stop" | "verification",
): Promise<TeardownToolResponse | undefined> {
  if (context.mode !== "serial-only" || target.device.platform !== "android") {
    return undefined;
  }
  const targetOriginalSerial = target.wasBooted ? target.bootedDevice.deviceId : undefined;
  if (!targetOriginalSerial) {
    return undefined;
  }
  if (
    targetOriginalSerial &&
    booted.devices.some((device) => device.deviceId === targetOriginalSerial)
  ) {
    return undefined;
  }
  const suspectPeers = booted.devices.filter(
    (device) =>
      device.platform === "android" &&
      isVirtualAndroidDevice(device) &&
      isUnknownAndroidRuntimeName(device) &&
      device.deviceId !== targetOriginalSerial &&
      (context.initialScan.serials.has(device.deviceId) ||
        (context.initialScan.pooledEntries.some((pooled) => pooled.id === device.deviceId) &&
          !context.initialScan.serials.has(device.deviceId))),
  );
  for (const suspect of suspectPeers) {
    const probeBudget = teardownProbeBudget(context);
    if (probeBudget.remainingMs <= 0) {
      break;
    }
    const probedName = await context.dependencies.resolveRunningAndroidAvdName(
      suspect,
      probeBudget.remainingMs,
      probeBudget.signal,
    );
    const refusal = serialOnlyAndroidTeardownRestartFailure(
      context,
      target,
      phase,
      suspect,
      probedName,
    );
    if (refusal) {
      return refusal;
    }
  }
  return undefined;
}

function serialOnlyAndroidTeardownRestartFailure(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  phase: "stop" | "verification",
  suspect: BootedDevice,
  probedName: string | undefined,
): TeardownToolResponse | undefined {
  if (probedName === undefined) {
    return createTeardownFailureResponse(
      context.args,
      phase,
      phase === "stop" ? "target_restarted" : "target_still_running",
      phase === "stop"
        ? `Android peer emulator '${suspect.deviceId}' could not identify its AVD while the target's ` +
            "original serial disappeared; refusing deletion rather than assuming the target did not restart there."
        : `The Android AVD may have reappeared on peer emulator '${suspect.deviceId}' after deletion, ` +
            "but its AVD name could not be resolved; refusing to report success rather than assuming inventory absence is durable.",
      target.device,
    );
  }
  if (probedName !== context.args.target.stableId) {
    return undefined;
  }
  return createTeardownFailureResponse(
    context.args,
    phase,
    phase === "stop" ? "target_restarted" : "target_still_running",
    phase === "stop"
      ? "The Android AVD restarted after shutdown confirmation; refusing deletion."
      : `The Android AVD reappeared on peer emulator '${suspect.deviceId}' after deletion; ` +
          "refusing to report success rather than assuming inventory absence is durable.",
    target.device,
  );
}

function androidInventorySourcesListingTarget(
  inventory: TeardownInventoryDiscovery,
  targetName: string,
): string[] {
  const sources = inventory.androidSources;
  if (!sources) {
    return [];
  }
  return [
    ...(sources.emulatorAvdNames.has(targetName) ? ["emulator -list-avds"] : []),
    ...(sources.avdManagerAvdNames.has(targetName) ? ["avdmanager list avd"] : []),
  ];
}

function teardownInventoryVerificationFailure(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  inventory: TeardownInventoryDiscovery,
): TeardownToolResponse | undefined {
  const targetName = target.device.name;
  const listedBy = androidInventorySourcesListingTarget(inventory, targetName);
  if (!completedInventoryFor(inventory, target.device.platform)) {
    const incompleteSources = inventory.androidSources?.incompleteSources ?? [];
    const sourceDetail =
      incompleteSources.length > 0 ? ` Incomplete checks: ${incompleteSources.join(", ")}.` : "";
    const diagnosticDetail = inventory.discoveryErrors?.[target.device.platform]?.message
      ? ` ${inventory.discoveryErrors[target.device.platform]?.message}`
      : "";
    const presenceDetail =
      listedBy.length > 0
        ? ` Target '${targetName}' remained listed by ${listedBy.join(" and ")}.`
        : "";
    return createTeardownFailureResponse(
      context.args,
      "verification",
      "inventory_incomplete",
      "The platform deletion command completed, but durable absence could not be verified." +
        sourceDetail +
        diagnosticDetail +
        presenceDetail,
      target.device,
    );
  }
  if (!inventoryContainsTarget(inventory, target)) {
    return undefined;
  }
  const sourceDetail =
    listedBy.length > 0 ? ` It remained listed by ${listedBy.join(" and ")}.` : "";
  return createTeardownFailureResponse(
    context.args,
    "verification",
    "target_still_present",
    `The platform deletion command completed, but target '${targetName}' is still present in inventory.${sourceDetail}`,
    target.device,
  );
}

async function readTeardownAbsenceFailure(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<TeardownToolResponse | undefined> {
  const restarted = await checkForRestartedTeardownTarget(context, target, "verification");
  if (restarted) {
    return restarted;
  }
  const inventory = await readTeardownInventory(
    context,
    target.device.platform,
    "post-delete platform inventory did not complete",
  );
  return teardownInventoryVerificationFailure(context, target, inventory);
}

export function createTeardownVerificationDeadlineFailure(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  lastFailure?: TeardownToolResponse,
): TeardownToolResponse {
  const lastFailureMessage = lastFailure
    ? (
        JSON.parse(lastFailure.content[0].text) as {
          failure?: { message?: string };
        }
      ).failure?.message
    : undefined;
  const message =
    "The teardown deadline elapsed before durable target absence could be verified." +
    (lastFailureMessage ? ` ${lastFailureMessage}` : "");
  return createTeardownFailureResponse(
    context.args,
    "verification",
    "verification_deadline_exceeded",
    message,
    target.device,
  );
}

/**
 * Sleep for `delay` ms, racing against `signal` for prompt cancellation.
 * Mirrors RetryExecutor.sleepUnlessAborted's cleanup pattern so neither the
 * timer handle nor the abort listener remains registered after the race.
 */
async function sleepUnlessAborted(
  timer: Timer,
  delay: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) {
    await timer.sleep(delay);
    return false;
  }
  if (signal.aborted) {
    return true;
  }
  let onAbort: (() => void) | undefined;
  let handle: NodeJS.Timeout | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      handle = timer.setTimeout(() => resolve(false), delay);
      if (signal.aborted) {
        resolve(true);
        return;
      }
      onAbort = () => resolve(true);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (handle !== undefined) {
      timer.clearTimeout(handle);
    }
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function clearDeletedAndroidAvdRebootBudget(target: TeardownResolvedTarget): void {
  if (target.device.platform !== "android") {
    return;
  }
  const daemonState = DaemonState.getInstance();
  if (daemonState.isInitialized()) {
    daemonState.getDevicePool().clearAndroidRebootBudgetForDeletedAvd(target.device);
  }
}

export async function verifyTeardownAbsence(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  stop: "accepted" | "not_required",
  onFailure?: (failure: TeardownToolResponse) => void,
): Promise<TeardownToolResponse> {
  let lastFailure: TeardownToolResponse | undefined;
  for (;;) {
    context.requestAbortSignal?.throwIfAborted();
    if (context.dependencies.timer.now() >= context.deadlineMs) {
      return createTeardownVerificationDeadlineFailure(context, target, lastFailure);
    }

    let failure: TeardownToolResponse | undefined;
    try {
      failure = await readTeardownAbsenceFailure(context, target);
    } catch (error) {
      if (context.requestAbortSignal?.aborted || !isShutdownTimeoutError(error)) {
        throw error;
      }
      logger.warn("[DeviceTools] Teardown verification read reached the shutdown deadline", error);
      return createTeardownVerificationDeadlineFailure(context, target, lastFailure);
    }
    if (!failure) {
      // Clear the name-keyed crash budget only after deletion and durable
      // absence are both confirmed. Pool re-adds and failed teardowns retain it.
      clearDeletedAndroidAvdRebootBudget(target);
      void notifyResourcesAfterShutdown(context.dependencies);
      return createTeardownResponse(
        context.args,
        "destroyed",
        { stop, destroy: "accepted" },
        { notRunning: "confirmed", inventory: "complete_absence_confirmed" },
        target.device,
      );
    }
    lastFailure = failure;
    onFailure?.(failure);

    const remainingMs = context.deadlineMs - context.dependencies.timer.now();
    if (remainingMs <= 0) {
      return createTeardownVerificationDeadlineFailure(context, target, lastFailure);
    }
    await sleepUnlessAborted(
      context.dependencies.timer,
      Math.min(DEVICE_SHUTDOWN_POLL_INTERVAL_MS, remainingMs),
      context.requestAbortSignal,
    );
  }
}

let moduleDependencies: DeviceToolsDependencies | null = null;

export function getDeviceToolsDependencies(): DeviceToolsDependencies {
  if (!moduleDependencies) {
    moduleDependencies = {
      androidAdbFactory: unadmittedAdbClientFactory,
      deviceResourceControllerFactory: () => new DefaultDeviceResourceController(),
      deviceResourceObserverFactory: () =>
        new DefaultDeviceResourceObserver({ timer: getDeviceToolsDependencies().timer }),
      deviceManagerFactory: () => new MultiPlatformDeviceManager(),
      avdManagerFactory: () => new AvdManagerService(),
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      displayInventory: defaultDisplayInventoryProvider,
      notifyResourcesChanged: defaultNotifyResourcesChanged,
      notifyDeviceInventoryResourcesChanged: defaultNotifyDeviceInventoryResourcesChanged,
      syncInstalledAppResourceRegistry,
      deviceCreationGateFactory: () => getDeviceCreationGate(),
      deviceProvisionerFactory: () => createDefaultDeviceProvisioner(),
      exactDeviceProvisionerFactory: (deviceManager, deviceCreationGate) =>
        createDefaultExactDeviceProvisioner(deviceManager, deviceCreationGate),
      provisionDeviceOperationStoreFactory: () => new ProvisionDeviceOperationRepository(),
      teardownDeviceOperationStoreFactory: () => new DeviceTeardownOperationRepository(),
      clearInstalledAppsForDevice: defaultClearInstalledAppsForDevice,
      stopPerformanceMonitoring: (deviceId) => getPerformanceMonitor().stopMonitoring(deviceId),
      stopAndroidObservers: defaultStopAndroidObservers,
      idGenerator: defaultIdGenerator,
      timer: defaultTimer,
      lifecycleCoordinator: getVirtualDeviceLifecycleCoordinator(),
      resolveRunningAndroidAvdName: defaultResolveRunningAndroidAvdName,
    };
  }
  return moduleDependencies;
}

function provisionDeviceDependencyOverrides(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
): Pick<
  DeviceToolsDependencies,
  "exactDeviceProvisionerFactory" | "provisionDeviceOperationStoreFactory"
> {
  return {
    exactDeviceProvisionerFactory:
      deps.exactDeviceProvisionerFactory ?? currentDeps.exactDeviceProvisionerFactory,
    provisionDeviceOperationStoreFactory:
      deps.provisionDeviceOperationStoreFactory ?? currentDeps.provisionDeviceOperationStoreFactory,
  };
}

function resourceNotificationDependencyOverrides(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
): Pick<
  DeviceToolsDependencies,
  | "notifyResourcesChanged"
  | "notifyDeviceInventoryResourcesChanged"
  | "syncInstalledAppResourceRegistry"
> {
  return {
    notifyResourcesChanged: deps.notifyResourcesChanged ?? currentDeps.notifyResourcesChanged,
    notifyDeviceInventoryResourcesChanged:
      deps.notifyDeviceInventoryResourcesChanged ??
      currentDeps.notifyDeviceInventoryResourcesChanged,
    syncInstalledAppResourceRegistry:
      deps.syncInstalledAppResourceRegistry ?? currentDeps.syncInstalledAppResourceRegistry,
  };
}

function resolveDeviceToolsLifecycleCoordinator(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
): VirtualDeviceLifecycleCoordinator {
  if (deps.lifecycleCoordinator) {
    return deps.lifecycleCoordinator;
  }
  return deps.timer
    ? new InMemoryVirtualDeviceLifecycleCoordinator(deps.timer)
    : currentDeps.lifecycleCoordinator;
}

// The override merger intentionally keeps all dependency seams in one place.
// oxlint-disable-next-line complexity
export function setDeviceToolsDependencies(deps: Partial<DeviceToolsDependencies>): void {
  const currentDeps = getDeviceToolsDependencies();
  moduleDependencies = {
    androidAdbFactory: deps.androidAdbFactory ?? currentDeps.androidAdbFactory,
    cameraPosterQrWriter: deps.cameraPosterQrWriter ?? currentDeps.cameraPosterQrWriter,
    env: deps.env ?? currentDeps.env,
    deviceResourceObserverFactory:
      deps.deviceResourceObserverFactory ?? currentDeps.deviceResourceObserverFactory,
    deviceResourceControllerFactory:
      deps.deviceResourceControllerFactory ?? currentDeps.deviceResourceControllerFactory,
    deviceManagerFactory: deps.deviceManagerFactory ?? currentDeps.deviceManagerFactory,
    avdManagerFactory: deps.avdManagerFactory ?? currentDeps.avdManagerFactory,
    deviceMatcherFactory: deps.deviceMatcherFactory ?? currentDeps.deviceMatcherFactory,
    displayInventory: deps.displayInventory ?? currentDeps.displayInventory,
    ...resourceNotificationDependencyOverrides(deps, currentDeps),
    ensureCtrlProxyReady: deps.ensureCtrlProxyReady ?? currentDeps.ensureCtrlProxyReady,
    deviceCreationGateFactory:
      deps.deviceCreationGateFactory ?? currentDeps.deviceCreationGateFactory,
    deviceProvisionerFactory: deps.deviceProvisionerFactory ?? currentDeps.deviceProvisionerFactory,
    ...provisionDeviceDependencyOverrides(deps, currentDeps),
    teardownDeviceOperationStoreFactory:
      deps.teardownDeviceOperationStoreFactory ?? currentDeps.teardownDeviceOperationStoreFactory,
    clearInstalledAppsForDevice:
      deps.clearInstalledAppsForDevice ?? currentDeps.clearInstalledAppsForDevice,
    stopPerformanceMonitoring:
      deps.stopPerformanceMonitoring ?? currentDeps.stopPerformanceMonitoring,
    stopAndroidObservers: deps.stopAndroidObservers ?? currentDeps.stopAndroidObservers,
    idGenerator: deps.idGenerator ?? currentDeps.idGenerator,
    timer: deps.timer ?? currentDeps.timer,
    lifecycleCoordinator: resolveDeviceToolsLifecycleCoordinator(deps, currentDeps),
    resolveRunningAndroidAvdName:
      deps.resolveRunningAndroidAvdName ?? currentDeps.resolveRunningAndroidAvdName,
  };
}

export function resetDeviceToolsDependencies(): void {
  deviceTeardownService?.dispose();
  deviceTeardownService = undefined;
  moduleDependencies = null;
  activeProvisionDeviceOperations.clear();
}

export function describeStartDeviceRequest(args: StartDeviceArgs): string {
  return [
    `platform=${args.platform}`,
    args.deviceId ? `deviceId=${args.deviceId}` : undefined,
    args.name ? `name=${args.name}` : undefined,
    args.minOsVersion ? `minOsVersion=${args.minOsVersion}` : undefined,
    args.maxOsVersion ? `maxOsVersion=${args.maxOsVersion}` : undefined,
    args.formFactor ? `formFactor=${args.formFactor}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

export function resolveRunnerReadinessTimeoutMs(args: StartDeviceArgs): number {
  return (
    args.runnerReadinessTimeoutMs ?? args.timeoutMs ?? serverConfig.getRunnerReadinessTimeoutMs()
  );
}

// Exported for property-based testing: the idempotency-key fingerprint is the
// contract that decides whether a reused operationId is the SAME request, so its
// determinism and field sensitivity are worth exercising directly.
export function provisionDeviceFingerprint(args: ProvisionDeviceArgs): string {
  return createHash("sha256")
    .update(
      stableStringify({
        device: args.device,
        boot: args.boot,
        readiness: args.readiness,
        timeoutMs: args.timeoutMs,
        ...(args.resources ? { resources: args.resources } : {}),
      }),
    )
    .digest("hex");
}

export function parseProvisionDeviceArgs(input: ProvisionDeviceArgs): ProvisionDeviceArgs {
  const __mcpSessionId = input.__mcpSessionId;
  const __mcpRequestDeadlineMs = input.__mcpRequestDeadlineMs;
  const publicInput: Record<string, unknown> = { ...input };
  // `provisionDeviceSchema` is `.strict()`, so EVERY internal param the daemon
  // may inject has to go before re-parsing -- hence the canonical shared list
  // rather than a hand-maintained copy that silently falls behind (a missing
  // `__mcpLiveDeadlineKey` made this tool unusable for any caller sending a
  // progress token).
  deleteInternalToolParams(publicInput);
  const parsed = provisionDeviceSchema.parse(publicInput);
  return {
    ...parsed,
    boot: parsed.boot ?? true,
    readiness: parsed.readiness ?? "automation",
    __mcpSessionId,
    __mcpRequestDeadlineMs,
  };
}

// Exported for property-based testing: the absolute deadline arithmetic clamps
// the requested budget against the transport deadline minus reserved rollback
// time, and those clamping invariants are worth exercising directly.
export function provisionDeviceDeadlineMs(
  args: ProvisionDeviceArgs,
  timer: Pick<Timer, "now">,
  reserveRollbackTime: boolean,
): number {
  const requestedDeadlineMs = timer.now() + (args.timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
  if (!reserveRollbackTime || args.__mcpRequestDeadlineMs === undefined) {
    return requestedDeadlineMs;
  }
  return Math.min(
    requestedDeadlineMs,
    args.__mcpRequestDeadlineMs -
      DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS -
      START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
  );
}

export function provisionDeviceTimeoutError(phase: string): ProvisionDeviceError {
  return new ProvisionDeviceError(
    "timeout",
    `provisionDevice timeout exhausted while ${phase}; remainingBudgetMs=0`,
  );
}

export class FinalizedProvisionDeviceCompletionError extends Error {
  constructor(readonly completionError: unknown) {
    super(errorMessage(completionError));
    this.name = "FinalizedProvisionDeviceCompletionError";
  }
}

export async function runProvisionDeviceWithinDeadline<T>(
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  totalDeadlineMs: number,
  requestSignal: AbortSignal | undefined,
  phase: string,
  operation: (signal: AbortSignal) => Promise<T>,
  onPendingSettlement?: (settlement: Promise<unknown>) => void,
): Promise<T> {
  return await runOperationWithinDeadline(
    timer,
    totalDeadlineMs,
    requestSignal,
    () => provisionDeviceTimeoutError(phase),
    operation,
    onPendingSettlement,
  );
}

export async function awaitProvisionDeviceOperationBegin<T>(
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  totalDeadlineMs: number,
  requestSignal: AbortSignal | undefined,
  begin: Promise<T>,
): Promise<T> {
  const remainingMs = Math.floor(totalDeadlineMs - timer.now());
  if (remainingMs <= 0) {
    throw provisionDeviceTimeoutError("starting provision operation");
  }
  return await raceWithDeadline(begin, {
    timer,
    timeoutMs: remainingMs,
    signal: requestSignal,
    label: "starting provision operation",
    relabelDefaultAbort: false,
    timeoutError: () => provisionDeviceTimeoutError("starting provision operation"),
  });
}

export async function runOperationWithinDeadline<T>(
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  totalDeadlineMs: number,
  requestSignal: AbortSignal | undefined,
  timeoutError: () => Error,
  operation: (signal: AbortSignal) => Promise<T>,
  onOrphan?: (pending: Promise<unknown>) => void,
): Promise<T> {
  const remainingMs = Math.floor(totalDeadlineMs - timer.now());
  if (remainingMs <= 0) {
    throw timeoutError();
  }

  const controller = new AbortController();
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, controller.signal])
    : controller.signal;
  let operationSettled = false;
  const operationPromise = runWithAbortSignal(signal, () => operation(signal)).finally(() => {
    operationSettled = true;
  });
  void operationPromise.catch((error) => {
    // The deadline race owns the failure; this observer also handles late abort rejection.
    logger.debug(`Provision operation rejection observed: ${errorMessage(error)}`);
  });

  try {
    return await raceWithDeadline(operationPromise, {
      timer,
      timeoutMs: remainingMs,
      signal: requestSignal,
      label: "Provision operation",
      timeoutError: () => {
        const error = timeoutError();
        controller.abort(error);
        return error;
      },
    });
  } catch (error) {
    if (!operationSettled) {
      onOrphan?.(operationPromise);
    }
    throw error;
  }
}

export async function waitForSharedOperation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return await promise;
  }
  if (signal.aborted) {
    throw signal.reason;
  }

  return await raceWithDeadline(promise, {
    timer: defaultTimer,
    signal,
    label: "Shared provision operation",
    relabelDefaultAbort: false,
  });
}

/**
 * Distinguish "the caller went away" from a provisioning failure.
 * `waitForSharedOperation` rejects with the caller signal's own reason, which
 * is a `DOMException(AbortError)` unless the caller supplied one.
 */
export function isProvisionDeviceCallerAbort(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted && error === signal.reason) {
    return true;
  }
  return error instanceof DOMException && error.name === "AbortError";
}

export function createProvisionDeviceResponse(result: Record<string, unknown>) {
  const device = result.device as { name: string; platform: string };
  const resources = result.resources as DeviceResourceConfigurationResult | undefined;
  const resourceFailure = resources?.success === false;
  const sessionId = typeof result.sessionId === "string" ? result.sessionId : undefined;
  return {
    ...createStructuredToolResponse({
      message: `${device.platform} '${device.name}' provisioned (${result.lifecycleState})${resourceFailure ? "; requested resource configuration was not fully applied" : ""}`,
      ...result,
      // `sessionId` remains the persisted daemon-internal handle for replay and
      // recovery. Canonical readers use `runtime.session.sessionUuid` or this
      // `sessionId`; the former top-level `sessionUuid` alias was unused.
      ...(sessionId ? { sessionId } : {}),
      ...(resources ? { success: resources.success } : {}),
    }),
    ...(resourceFailure ? { isError: true } : {}),
  };
}

/**
 * True when the running device resolved for `args.deviceId` is not the device
 * the caller named. On Android `deviceId` doubles as an AVD image name (see
 * `getAndroidSchema`), so a serial that necessarily differs from the requested
 * string is still the requested device when the AVD name matches.
 */
export function isMismatchedBootedDeviceId(
  args: StartDeviceArgs,
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
): boolean {
  if (!args.deviceId || device.deviceId === args.deviceId) {
    return false;
  }
  return !(
    device.platform === "android" &&
    (device.name === args.deviceId || sourceImage?.name === args.deviceId)
  );
}

export function validateBootIdentity(
  args: StartDeviceArgs,
  device: BootedDevice,
  source: "booted" | "cold-boot",
  sourceImage?: DeviceInfo,
): void {
  const requested = describeStartDeviceRequest(args);
  const resolved = `${device.platform} ${device.name} (${device.deviceId})`;
  if (device.platform !== args.platform) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requested}] resolved=[${resolved}] ` +
        "phase=pool-match: resolved platform differs from requested platform",
    );
  }
  if (args.platform === "android" && args.avdName && device.name !== args.avdName) {
    throw new ActionableError(
      `target_identity_mismatch: Requested Android AVD '${args.avdName}' ` +
        `resolved to '${device.name}' (${device.deviceId}).`,
    );
  }
  if (source === "booted" && isMismatchedBootedDeviceId(args, device, sourceImage)) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requested}] resolved=[${resolved}] ` +
        "phase=pool-match: running device ID differs from the requested device ID",
    );
  }
  if (
    source === "cold-boot" &&
    device.platform === "ios" &&
    sourceImage?.deviceId &&
    sourceImage.deviceId !== device.deviceId
  ) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requested}] selected=[${sourceImage.name} ` +
        `(${sourceImage.deviceId})] resolved=[${resolved}] phase=pool-match: ` +
        "iOS runtime UDID differs from the selected simulator UDID",
    );
  }
}

/**
 * getAndroid accepts `avdName` and `deviceId` together (see `getAndroidSchema`).
 * `deviceId` is a serial OR an image name, so the pair identifies one device
 * whenever the resolved device carries the requested serial — or is that image.
 * Anything else is a genuine `identifier_conflict`, reportable only here,
 * because the mapping from AVD name to serial is not known until discovery.
 */
/**
 * Reject a contradictory `avdName` + `deviceId` pair BEFORE any boot.
 * `validateRequestedAndroidSerial` is the post-boot authority, but by the time
 * it runs a stopped AVD has already been cold-booted and then killed just to
 * report the conflict (Codex thread on #6833). A configured AVD name can be
 * resolved from the image inventory, and a running-emulator serial can be
 * resolved from one booted-device discovery sweep, without booting anything.
 *
 * A non-serial `deviceId` remains deferred unless it is itself a configured AVD
 * name. Anything ambiguous — inventory discovery unavailable, an unknown
 * non-serial identifier, or a running device whose runtime name is still
 * `Unknown (<serial>)` — likewise defers, so this check only ever rejects a
 * pair it can positively contradict.
 */
async function validateRequestedAndroidConfiguredAvdPairBeforeBoot(
  pair: { avdName: string; deviceId: string },
  deviceUtils: PlatformDeviceManager,
  bootDeadlineMs: number,
  timer: Timer,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const { avdName, deviceId } = pair;
  if (isAndroidEmulatorSerial(deviceId)) {
    return false;
  }
  const inventory = await runWithinShutdownDeadline(
    { name: avdName, platform: "android", deviceId },
    timer,
    bootDeadlineMs,
    "Android pre-boot AVD identity validation did not complete",
    {
      requestAbortSignal: signal,
      operation: async (signal) =>
        await deviceUtils.getDeviceImagesDetailed("android", {
          signal,
        }),
      timeoutMs: undefined,
      phase: "pre-boot AVD identity validation",
    },
  );
  if (!inventory.succeededPlatforms.has("android")) {
    return true;
  }
  const configuredAvdNames = new Set(
    inventory.devices
      .filter((device) => device.platform === "android")
      .map((device) => device.name),
  );
  if (configuredAvdNames.has(avdName) && configuredAvdNames.has(deviceId)) {
    throw new ActionableError(
      `identifier_conflict: avdName '${avdName}' and deviceId '${deviceId}' name ` +
        "different configured AVDs. Pass only the identifier you mean.",
    );
  }
  return true;
}

export async function validateRequestedAndroidIdentifiersBeforeBoot(
  pair: { avdName: string; deviceId: string } | undefined,
  deviceUtils: PlatformDeviceManager,
  bootDeadlineMs: number,
  timer: Timer,
  signal: AbortSignal | undefined,
  collectPendingSettlement?: ColdBootSettlementCollector,
): Promise<void> {
  if (!pair) {
    return;
  }
  const { avdName, deviceId } = pair;
  if (!avdName || avdName === deviceId) {
    return;
  }
  if (
    await validateRequestedAndroidConfiguredAvdPairBeforeBoot(
      pair,
      deviceUtils,
      bootDeadlineMs,
      timer,
      signal,
    )
  ) {
    return;
  }
  const discovery = await runWithinShutdownDeadline(
    { name: avdName, platform: "android", deviceId },
    timer,
    bootDeadlineMs,
    "Android pre-boot serial validation did not complete",
    {
      requestAbortSignal: signal,
      operation: async (signal) => {
        const discovery = await deviceUtils.getBootedDevicesDetailed("android", {
          bypassAndroidDeviceListCache: true,
          signal,
        });
        if (signal.aborted) {
          // The deadline/abort already settled prepareDevice and released its
          // lifecycle lease. Dropping this stale snapshot is safe: the post-boot
          // recheck for the next acquisition will observe with current context.
          logger.debug(
            `[DeviceTools] Dropping stale pre-boot serial validation discovery after deadline/abort for avdName=${avdName}`,
          );
          return discovery;
        }
        // FUNNEL 1: the post-boot recheck this defers to decides with pool/incarnation
        // context, so the pool must have seen this observation (#6863 review).
        await reconcileDiscoveryObservation(discovery.devices, "pre-boot-serial-validation", {
          signal,
        });
        return discovery;
      },
      timeoutMs: undefined,
      phase: "pre-boot serial validation",
      onOrphan: (pending) => {
        collectPendingSettlement?.(
          pending.then(
            () => undefined,
            () => undefined,
          ),
        );
      },
    },
  );
  if (!discovery.succeededPlatforms.has("android")) {
    // Discovery was unavailable this sweep; a pair we cannot yet contradict is
    // deferred to the post-boot recheck rather than rejected on missing data.
    return;
  }
  const running = discovery.devices.find(
    (device) => device.platform === "android" && device.deviceId === deviceId,
  );
  if (running && isUnknownAndroidRuntimeName(running)) {
    // The serial is running but its AVD name is not resolvable yet; the
    // post-boot recheck decides with pool/incarnation context.
    return;
  }
  if (running && running.name === avdName) {
    return;
  }
  throw new ActionableError(
    `identifier_conflict: avdName '${avdName}' and deviceId '${deviceId}' name ` +
      `different devices — '${deviceId}' ` +
      (running ? `is running AVD '${running.name}'` : "is not running") +
      `. Pass only the identifier you mean.`,
  );
}

export function validateRequestedAndroidSerial(
  pair: { avdName: string; deviceId: string } | undefined,
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
): void {
  if (!pair) {
    return;
  }
  const requested = pair.deviceId;
  if (isAndroidEmulatorSerial(requested) && device.deviceId === requested) {
    if (device.name === pair.avdName) {
      return;
    }
    throw new ActionableError(
      `identifier_conflict: avdName '${pair.avdName}' resolved to ` +
        `${device.name} (${device.deviceId}), which is not the requested AVD. ` +
        "Pass only the identifier you mean.",
    );
  }
  if (
    device.deviceId === requested ||
    device.name === requested ||
    sourceImage?.name === requested
  ) {
    return;
  }
  throw new ActionableError(
    `identifier_conflict: avdName '${pair.avdName}' resolved to ` +
      `${device.name} (${device.deviceId}), which is not the requested deviceId ` +
      `'${requested}'. Pass only the identifier you mean.`,
  );
}

export function validatePooledDeviceMapping(device: BootedDevice, requestedIdentity: string): void {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const pooled = daemonState.getDevicePool().getDevice(device.deviceId);
  // A physical iPhone's display name is mutable metadata, not identity, so a
  // rename must not read as a stale pool entry here either (#5690). The pool
  // itself tolerates it in matchesRuntimeIdentity(); both consult the same
  // predicate so this validator cannot reject what the pool would accept.
  const nameIsIdentity = !hasMutableDisplayName(device.platform, device.deviceId);
  if (
    pooled &&
    (pooled.platform !== device.platform || (nameIsIdentity && pooled.name !== device.name))
  ) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requestedIdentity}] ` +
        `resolved=[${device.name} (${device.deviceId}) platform=${device.platform}] ` +
        `pooled=[${pooled.name} (${pooled.id}) platform=${pooled.platform}] ` +
        "phase=pool-match: stale pool identity conflicts with the resolved runtime",
    );
  }
}

/**
 * Collects the process-exit settlements of cold boots this request cancelled but
 * never owned. `prepareDevice` defers its lifecycle-lease release onto every one
 * of them, so an AVD's stable key is not handed to the next request while an
 * emulator this one only signalled is still running.
 */
export type ColdBootSettlementCollector = (settlement: Promise<void> | undefined) => void;

export function cancelUnownedColdBoot(
  boot: DeviceBootResult | undefined,
): Promise<void> | undefined {
  if (boot?.source !== "cold-boot" || !boot.processHandle) {
    return undefined;
  }
  const daemonState = DaemonState.getInstance();
  if (
    daemonState.isInitialized() &&
    daemonState.getDevicePool().hasStartedDeviceProcess(boot.device.deviceId, boot.processHandle)
  ) {
    logger.info(
      `[DeviceTools] Cold boot ${boot.device.deviceId} process ownership transferred before cleanup`,
    );
    return undefined;
  }
  const termination = terminateColdBootProcess(
    boot.processHandle,
    boot.device.deviceId,
    getDeviceToolsDependencies().timer,
  );
  return termination.confirmed.then((confirmed) => {
    if (!confirmed) {
      logger.warn(
        `[DeviceTools] Unowned cold boot ${boot.device.deviceId} still running after SIGKILL; ` +
          "releasing its deferred resources anyway",
      );
    }
  });
}

export function clearColdBootShutdownMarker(
  source: "booted" | "cold-boot",
  deviceId: string,
): void {
  const daemonState = DaemonState.getInstance();
  if (source === "cold-boot" && daemonState.isInitialized()) {
    daemonState.getDevicePool().clearIntentionalShutdown(deviceId);
  }
}

export function publishWarmDeviceReady(source: "booted" | "cold-boot", deviceId: string): void {
  const daemonState = DaemonState.getInstance();
  if (source === "booted" && daemonState.isInitialized()) {
    daemonState.getDevicePool().notifyDeviceReady(deviceId);
  }
}

export function isUnknownAndroidRuntimeName(device: BootedDevice): boolean {
  return device.name === `Unknown (${device.deviceId})`;
}

export async function validatePreservedSystemUiAnrRecoverySession(
  preservedSessionId: string | undefined,
  validatePreservedSession: (() => Promise<void>) | undefined,
  retireReplacement: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!preservedSessionId) {
    return;
  }
  try {
    await validatePreservedSession?.();
  } catch (error) {
    try {
      await retireReplacement?.();
    } catch (retireError) {
      logger.warn(
        `[DeviceTools] Failed to retire stale System UI recovery replacement: ${retireError}`,
        retireError,
      );
    }
    throw error;
  }
}

async function ensureRunnerReadyWithSystemUiAnrRecovery(
  boot: DeviceBootResult,
  ensureRunnerReady: (candidate: DeviceBootResult) => Promise<void>,
  rebootAfterSystemUiAnr: (candidate: DeviceBootResult) => Promise<SystemUiAnrRecoveryResult>,
): Promise<SystemUiAnrRecoveryResult & { recovered: boolean }> {
  try {
    await ensureRunnerReady(boot);
    return { boot, recovered: false };
  } catch (error) {
    if (
      !(error instanceof SystemUiAnrRecoveryRequiredError) ||
      boot.device.platform !== "android"
    ) {
      throw error;
    }
    const recovery = await rebootAfterSystemUiAnr(boot);
    try {
      await ensureRunnerReady(recovery.boot);
    } catch (readinessError) {
      try {
        await recovery.retireReplacement?.();
      } catch (retireError) {
        logger.warn(
          `[DeviceTools] Failed to retire System UI recovery replacement: ${retireError}`,
          retireError,
        );
      }
      try {
        // rebootAfterSystemUiAnr retained the readiness reservation for the
        // replacement, but it only reaches the caller's ordered cleanup once this
        // returns. Release it here so a failed second readiness check does not
        // strand the recovered AVD out of general allocation forever.
        await recovery.releaseReadinessReservation?.();
      } catch (releaseError) {
        logger.warn(
          `[DeviceTools] Failed to release System UI recovery readiness reservation: ${releaseError}`,
          releaseError,
        );
      }
      recovery.releaseRecoveryRouteLease?.();
      throw readinessError;
    }
    return { ...recovery, recovered: true };
  }
}

async function reserveRecoveredDeviceForReadiness(
  devicePool: DevicePool | undefined,
  boot: DeviceBootResult,
  args: StartDeviceArgs,
  requestedIdentity: string,
  releaseReadinessReservations: DeviceReadinessReservation[],
): Promise<void> {
  validateBootIdentity(args, boot.device, boot.source, boot.sourceImage);
  validatePooledDeviceMapping(boot.device, requestedIdentity);
  if (devicePool) {
    releaseReadinessReservations.push(
      await devicePool.reserveDeviceForReadiness(
        boot.device.deviceId,
        boot.device,
        boot.sourceImage?.name ?? boot.device.name,
        undefined,
        undefined,
        boot.device.platform === "android",
      ),
    );
  }
  clearColdBootShutdownMarker(boot.source, boot.device.deviceId);
}

export async function reserveInitialDeviceForReadiness(
  daemonState: DaemonState,
  boot: DeviceBootResult,
  releaseReadinessReservations: DeviceReadinessReservation[],
  mcpSessionId: string | undefined,
): Promise<void> {
  const devicePool = getStartDevicePool(daemonState);
  if (!devicePool) {
    return;
  }
  releaseReadinessReservations.push(
    await devicePool.reserveDeviceForReadiness(
      boot.device.deviceId,
      boot.device,
      boot.sourceImage?.name ?? boot.device.name,
      undefined,
      mcpSessionId ? { mcpSessionId } : undefined,
      true,
    ),
  );
}

function deviceInventoryChangedAfterBoot(boot: DeviceBootResult): boolean {
  return boot.source === "cold-boot" || boot.provisioned;
}

export function refreshResourcesAfterCommittedBoot(
  boot: DeviceBootResult,
  dependencies: Pick<
    DeviceToolsDependencies,
    "notifyDeviceInventoryResourcesChanged" | "syncInstalledAppResourceRegistry"
  >,
): void {
  if (!deviceInventoryChangedAfterBoot(boot)) {
    return;
  }
  // Session ownership is already committed, so resource refresh and transport
  // delivery are advisory: neither may withhold the acquired session.
  void (async () => {
    let installedAppResourcesChanged = false;
    try {
      installedAppResourcesChanged = await dependencies.syncInstalledAppResourceRegistry();
    } catch (error) {
      logger.warn(
        `[DeviceTools] Installed-app resource sync after device boot failed: ${errorMessage(error)}`,
        error,
      );
    }
    try {
      await dependencies.notifyDeviceInventoryResourcesChanged(installedAppResourcesChanged);
    } catch (error) {
      logger.warn(
        `[DeviceTools] Resource notification after device boot failed: ${errorMessage(error)}`,
        error,
      );
    }
  })();
}

interface StartDeviceRunnerReadinessInput {
  autolockEnabled?: boolean;
  boot: DeviceBootResult;
  args: StartDeviceArgs;
  operationName: string;
  bootService: DeviceBootService;
  deviceUtils: PlatformDeviceManager;
  daemonState: DaemonState;
  totalDeadlineMs: number;
  readinessTimeoutMs: number;
  timer: Timer;
  signal: AbortSignal | undefined;
  progress: ProgressCallback | undefined;
  perf: ReturnType<typeof createPerformanceTracker>;
  requestedIdentity: string;
  ensureCtrlProxyReady: (request: RunnerReadinessRequest) => Promise<void>;
  releaseReadinessReservations: DeviceReadinessReservation[];
  publishRecoveredReadinessMarker?: (device: BootedDevice) => void;
  collectColdBootSettlement: ColdBootSettlementCollector;
}

export async function prepareStartDeviceRunnerReadiness(
  input: StartDeviceRunnerReadinessInput,
): Promise<SystemUiAnrRecoveryResult & { recovered: boolean }> {
  const devicePool = getStartDevicePool(input.daemonState);
  const recoveryAutolockClient =
    (input.autolockEnabled ?? captureAutolockPolicy(getDeviceToolsDependencies().env)) && devicePool
      ? {
          mcpSessionId: input.args.__mcpSessionId,
          expectedSessionId: devicePool.captureAutolockSessionForMcpSession(
            input.args.__mcpSessionId,
          ),
        }
      : undefined;
  const readinessResult = await ensureRunnerReadyWithSystemUiAnrRecovery(
    input.boot,
    createRunnerReadinessAttempt(input),
    createSystemUiAnrRebooter(input, devicePool, recoveryAutolockClient),
  );
  if (readinessResult.recovered) {
    try {
      await prepareRecoveredDeviceForRunnerReadiness(input, devicePool, readinessResult);
    } catch (error) {
      readinessResult.releaseRecoveryRouteLease?.();
      try {
        await readinessResult.retireReplacement?.();
      } catch (cleanupError) {
        logger.warn(
          `[DeviceTools] Failed to retire replacement after recovered readiness reservation failed: ${cleanupError}`,
          cleanupError,
        );
      }
      throw error;
    }
  }
  return readinessResult;
}

export function getStartDevicePool(daemonState: DaemonState): DevicePool | undefined {
  return daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
}

export function assertAndroidBootDidNotEnterRecovery(
  args: StartDeviceArgs,
  boot: DeviceBootResult,
): void {
  if (args.platform !== "android") {
    return;
  }
  const recoveryTargets = getStartDevicePool(
    DaemonState.getInstance(),
  )?.getRecoveringAndroidTargets();
  if (
    recoveryTargets?.serials.has(boot.device.deviceId) ||
    recoveryTargets?.names.has(boot.device.name)
  ) {
    throw new ActionableError(
      `Android device '${boot.device.name}' entered recovery while booting; retry the request.`,
    );
  }
}

function createRunnerReadinessAttempt(
  input: StartDeviceRunnerReadinessInput,
): (candidate: DeviceBootResult) => Promise<void> {
  return async (candidate) =>
    await input.ensureCtrlProxyReady({
      device: candidate.device,
      requestedIdentity: input.requestedIdentity,
      operationName: input.operationName,
      totalDeadlineMs: input.totalDeadlineMs,
      readinessTimeoutMs: input.readinessTimeoutMs,
      skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
      perf: input.perf,
      signal: input.signal,
    });
}

function createSystemUiAnrRebooter(
  input: StartDeviceRunnerReadinessInput,
  devicePool: DevicePool | undefined,
  recoveryAutolockClient: { mcpSessionId?: string; expectedSessionId?: string } | undefined,
): (candidate: DeviceBootResult) => Promise<SystemUiAnrRecoveryResult> {
  return async (candidate) =>
    await rebootAndroidAfterSystemUiAnr({
      boot: candidate,
      args: input.args,
      bootService: input.bootService,
      deviceManager: input.deviceUtils,
      devicePool,
      totalDeadlineMs: input.totalDeadlineMs,
      timer: input.timer,
      signal: input.signal,
      progress: input.progress ? { report: input.progress } : undefined,
      recoveryAutolockClient,
      collectColdBootSettlement: input.collectColdBootSettlement,
      publishReplacementReadinessMarker: (replacement) =>
        input.publishRecoveredReadinessMarker?.(replacement),
      operations: {
        deviceShutdownTimeoutMs: DEVICE_SHUTDOWN_TIMEOUT_MS,
        runWithinShutdownDeadline,
        waitForDeviceShutdown,
        shouldClearIntentionalShutdownAfterFailure,
        cancelUnownedColdBoot,
        isUnknownAndroidRuntimeName,
      },
    });
}

async function prepareRecoveredDeviceForRunnerReadiness(
  input: StartDeviceRunnerReadinessInput,
  devicePool: DevicePool | undefined,
  recovery: SystemUiAnrRecoveryResult,
): Promise<void> {
  if (recovery.releaseReadinessReservation) {
    input.releaseReadinessReservations.push(recovery.releaseReadinessReservation);
  }
  await reserveRecoveredDeviceForReadiness(
    devicePool,
    recovery.boot,
    input.args,
    input.requestedIdentity,
    input.releaseReadinessReservations,
  );
}

export function getVerifiedWarmAndroidAvdIdentity(
  boot: DeviceBootResult,
  sourceImage: DeviceInfo | undefined,
): DeviceInfo | undefined {
  if (boot.source === "booted" && sourceImage?.platform === "android") {
    return sourceImage;
  }
  return undefined;
}

// This checked discovery is the pre-allocation refresh for a serial selector.
// Use the same outcome as pool refresh before lifecycle resolution can mask its cause.
function assertAndroidLifecycleDiscovery(
  discovery: BootedDeviceDiscovery,
  matchCount: number,
): void {
  if (matchCount === 0) {
    const outcome = discoveryRefreshOutcome(discovery, 0);
    if (outcome.failure !== undefined) {
      throw new ActionableError(deviceListRefreshFailureMessage(outcome.failure));
    }
  }
}

export async function resolveAndroidStartStableDeviceLifecycleTarget(
  deviceId: string,
  deadlineMs: number,
  deviceUtils: PlatformDeviceManager,
  timer: Timer,
  signal: AbortSignal | undefined,
): Promise<StableDeviceTarget | undefined> {
  const bootedDiscovery = await runWithinShutdownDeadline(
    { name: deviceId, platform: "android", deviceId },
    timer,
    deadlineMs,
    "Android booted-device identity discovery did not complete",
    {
      requestAbortSignal: signal,
      operation: async () => {
        const discovery = await deviceUtils.getBootedDevicesDetailed("android", {
          bypassAndroidDeviceListCache: true,
        });
        // FUNNEL 1: lifecycle coordination resolves the AVD behind a serial, which
        // is exactly what the quarantine puts in doubt (#6863 review).
        await reconcileDiscoveryObservation(discovery.devices, "android-start-lifecycle-target");
        return discovery;
      },
    },
  );
  const bootedMatches = bootedDiscovery.devices.filter(
    (device) => device.platform === "android" && device.deviceId === deviceId,
  );
  if (bootedMatches.length > 1) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  assertAndroidLifecycleDiscovery(bootedDiscovery, bootedMatches.length);
  const bootedMatch = bootedMatches[0];
  if (bootedMatch && !isVirtualAndroidDevice(bootedMatch)) {
    // Physical devices have no AVD representation; coordinate by the request selector.
    return undefined;
  }

  const imageDiscovery = await runWithinShutdownDeadline(
    { name: deviceId, platform: "android", deviceId },
    timer,
    deadlineMs,
    "Android AVD identity discovery did not complete",
    {
      requestAbortSignal: signal,
      operation: async () => await deviceUtils.getDeviceImagesDetailed("android"),
    },
  );
  if (!imageDiscovery.succeededPlatforms.has("android")) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  const imageMatches = imageDiscovery.devices.filter(
    (device) =>
      device.platform === "android" && (device.deviceId === deviceId || device.name === deviceId),
  );
  if (imageMatches.length > 1) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  if (imageMatches.length === 1) {
    return { platform: "android", stableId: imageMatches[0].name };
  }

  const daemonState = DaemonState.getInstance();
  const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
  const stableIds = new Set(
    bootedMatches.map((device) => getBootedAndroidStableName(device, devicePool)),
  );
  if (stableIds.size === 0) {
    if (!bootedDiscovery.succeededPlatforms.has("android")) {
      throw new ActionableError(
        `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
      );
    }
    return undefined;
  }
  if (
    stableIds.size !== 1 ||
    bootedMatches.some(
      (device) =>
        isUnknownAndroidRuntimeName(device) &&
        !getValidatedPooledAndroidAvdName(device, devicePool),
    )
  ) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  return { platform: "android", stableId: [...stableIds][0] };
}

export function availableDeviceResourceNote() {
  const listedResourceUris = new Set(
    ResourceRegistry.getResourceDefinitions().map((resource) => resource.uri),
  );
  const resourceUris = [
    BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
    `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/android`,
    `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/ios`,
    DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/android`,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/ios`,
  ];
  const availableResourceUris = resourceUris.filter((uri) => listedResourceUris.has(uri));
  return {
    message:
      "Acquire a booted device with getAndroid { deviceId } or getApple { deviceId }. " +
      (availableResourceUris.length > 0
        ? "For available images and richer per-device detail, read these MCP resources:"
        : "Refresh resources/list to discover available images and richer per-device detail."),
    resources: availableResourceUris,
    uriPrefix:
      "All resource URIs use the 'automobile:' prefix. URIs like 'android://devices' are not supported.",
  };
}

export async function androidProvenanceByAvdName(
  avdManager: Pick<AvdManager, "listDeviceImages">,
  timer: Timer,
): Promise<ReadonlyMap<string, AvdInfo>> {
  return AndroidAvdProvenanceCache.getInstance().getByName(avdManager, timer);
}

export type DevicePreparationBudgets = {
  bootTimeoutMs: number;
  automationReadyTimeoutMs: number;
  automationDeadlineMs: number;
  operationName: string;
  androidAvdName?: string;
  stableTarget?: StableDeviceTarget;
  /** Android `avdName` + `deviceId` pair, validated before and after discovery. */
  requestedAndroidIdentifierPair?: { avdName: string; deviceId: string };
  /** Running preparation stage, named when the acquisition deadline backstop fires (#6034). */
  stage?: AcquisitionStage;
};

/** Mutable holder for the acquisition stage currently in flight. */
export type AcquisitionStage = { current: string };

export function setAcquisitionStage(budgets: DevicePreparationBudgets, stage: string): void {
  if (budgets.stage) {
    budgets.stage.current = stage;
  }
}

/**
 * Acquisition-phase timeout. `reserveStableDeviceLifecycle` defaults to the
 * killDevice-shaped `shutdownTimeoutError`, which on a start path reports the
 * device as failing to *disappear*, quotes `DEVICE_SHUTDOWN_TIMEOUT_MS`
 * instead of the caller's budget, and tells the user to verify the shutdown
 * state. Mirror the phase-labeled style `DeviceBootService` already emits.
 */
export const acquisitionLifecycleTimeoutError = (
  budgets: DevicePreparationBudgets,
  describedTarget: string,
  detail: string,
): ActionableError =>
  new ActionableError(
    `${budgets.operationName} timeout exhausted while ${detail}; ` +
      `budgetMs=${budgets.bootTimeoutMs + budgets.automationReadyTimeoutMs}; ` +
      `target=${describedTarget}; origin=virtualDeviceLifecycleCoordinator`,
  );

export function registerDeviceTools() {
  const { listDeviceImagesHandler, listDevicesHandler } = createListingHandlers();

  let startDeviceHandlers: ReturnType<typeof createStartDeviceHandlers> | undefined = undefined;
  const acquisitionHandlers = createAcquisitionHandlers({
    getBootAndPrepareDevice: () => startDeviceHandlers!.bootAndPrepareDevice,
  });
  startDeviceHandlers = createStartDeviceHandlers({
    prepareDevice: acquisitionHandlers.prepareDevice,
    stripInternalAcquisitionParams: acquisitionHandlers.stripInternalAcquisitionParams,
  });
  const {
    startDeviceHandler,
    bindBootedDeviceSession,
    recordAcquiredSessionReadiness,
    ensureCtrlProxyReady,
  } = startDeviceHandlers;
  const { getAndroidHandler, getAppleHandler } = acquisitionHandlers;

  const { killDeviceHandler, executeDeleteDevice, deleteDeviceHandler } = createLifecycleHandlers();

  const provisionDeviceHandler = createProvisionDeviceHandler({
    bindBootedDeviceSession,
    recordAcquiredSessionReadiness,
    ensureCtrlProxyReady,
    executeDeleteDevice,
  });

  // Register with the tool registry
  registerDeviceResourceTools(getDeviceToolsDependencies);
  ToolRegistry.register(
    "listDeviceImages",
    "List device images",
    listDeviceImagesSchema,
    listDeviceImagesHandler,
    { defaultEnabled: true, outputSchema: listDeviceImagesOutputSchema },
  );

  ToolRegistry.register(
    "listDevices",
    "List booted devices; pending configured-image enrichment includes retry hints and failed provenance includes a non-retryable reason; resource pointers for images and detail in the note",
    listDevicesSchema,
    listDevicesHandler,
    { defaultEnabled: true, outputSchema: listDevicesOutputSchema },
  );

  ToolRegistry.register(
    "getAndroid",
    "Find or recover an Android AVD and prepare it for automation. See the automobile:tools resource for every tool's default enabled/gated state before acquiring a device.",
    getAndroidSchema,
    getAndroidHandler,
    { defaultEnabled: true, supportsProgress: true, transportRecovery: "connect" },
  );

  ToolRegistry.register(
    "getApple",
    "Find or recover an iOS Simulator and prepare it for automation. See the automobile:tools resource for every tool's default enabled/gated state before acquiring a device.",
    getAppleSchema,
    getAppleHandler,
    { defaultEnabled: true, supportsProgress: true, transportRecovery: "connect" },
  );

  ToolRegistry.register("startDevice", "Start device", startDeviceSchema, startDeviceHandler, {
    outputSchema: startDeviceOutputSchema,
    defaultEnabled: true,
    supportsProgress: true,
    hidden: true,
    transportRecovery: "connect",
  });

  ToolRegistry.register(
    "provisionDevice",
    "Provision exact virtual device",
    provisionDeviceSchema,
    provisionDeviceHandler,
    {
      defaultEnabled: false,
      outputSchema: provisionDeviceOutputSchema,
      transportRecovery: "connect",
    },
  );

  ToolRegistry.register("killDevice", "Kill device", killDeviceSchema, killDeviceHandler, {
    defaultEnabled: true,
    transportRecovery: "connect",
  });

  ToolRegistry.register(
    "deleteDevice",
    "Stop and permanently delete a device, with verified platform-inventory absence",
    teardownDeviceSchema,
    deleteDeviceHandler,
    { defaultEnabled: false, transportRecovery: "connect" },
  );
}
