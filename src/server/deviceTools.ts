import { z } from "zod/v4";
import { startDeviceOutputSchema } from "./toolOutputSchemas";
import { ToolRegistry } from "./toolRegistry";
import { registerDeviceResourceTools } from "./deviceResourceTools";
import {
  listDevicesEntrySchema,
  provisionedDeviceSchema,
  configuredImageSchema,
} from "./deviceDescription";
import { platformSchema, addSessionUuidToSchema } from "./toolSchemaHelpers";
import { acquireUndoneIfUndelivered } from "./undeliveredAcquisition";
import { MAX_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { createProvisionDeviceHandlers } from "./deviceToolsProvisioning";
import { createAcquisitionHandlers } from "./deviceToolsAcquisition";
import { createStartDeviceHandlers } from "./deviceToolsStartDevice";
import { createLifecycleHandlers } from "./deviceToolsLifecycle";
import { createListingHandlers } from "./deviceToolsListing";
import {
  TeardownDeviceArgs,
  TeardownToolResponse,
  getAndroidSchema,
  getAppleSchema,
  getDeviceTeardownService,
  getDeviceToolsDependencies,
  provisionDeviceSchema,
  startDeviceSchema,
} from "../features/deviceLifecycle/deviceLifecycleCore";
export * from "../features/deviceLifecycle/deviceLifecycleCore";

export { reserveAndroidStartupLease } from "./deviceToolsStartupLease";

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

const bootCapacitySchema = z.object({
  limit: z.number(),
  booted: z.number(),
  inFlight: z.number(),
});

const androidBootCapacitySchema = bootCapacitySchema.extend({
  processTable: z
    .object({
      unavailable: z.boolean(),
      reason: z.string(),
      detail: z.string(),
      attempts: z.number(),
      admissionsWithoutProcessTable: z.number(),
      lastAdmissionWithoutProcessTableAtMs: z.number().optional(),
    })
    .optional(),
});

/** iOS also reports host pressure (#11209), which is reported only and never gates a boot. */
const iosBootCapacitySchema = bootCapacitySchema.extend({
  hostPressure: z
    .object({
      sustained: z.boolean(),
      consecutiveSamples: z.number(),
      memoryPressure: z.string(),
    })
    .optional(),
});

export const listDevicesOutputSchema = z.object({
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
  capacity: z
    .object({
      android: androidBootCapacitySchema.optional(),
      ios: iosBootCapacitySchema.optional(),
    })
    .optional()
    .describe(
      "Boot admission capacity per gated platform: booted-device limit, booted devices (including ones started outside AutoMobile), and admitted boots in flight",
    ),
  note: z.unknown(),
});

const provisionDeviceOutputSchema = z
  .object({
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
  "emulators only; accepted and ignored for iOS and physical devices. Separately, on any " +
  "platform, force also stops a device another session holds, which is otherwise refused.";

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

export const teardownDeviceSchema = addSessionUuidToSchema(
  z
    .object({
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

/** Runs the verified `deleteDevice` workflow (stop, destroy, verify absence) on the daemon's behalf. */
export type DaemonDeviceDeletion = (
  args: TeardownDeviceArgs,
  signal?: AbortSignal,
) => Promise<TeardownToolResponse>;

let daemonDeviceDeletion: DaemonDeviceDeletion | undefined;

/** The daemon's delete workflow, once the device tools are registered in this process. */
export function getDaemonDeviceDeletion(): DaemonDeviceDeletion | undefined {
  return daemonDeviceDeletion;
}

export function registerDeviceTools() {
  const { listDeviceImagesHandler, listDevicesHandler } = createListingHandlers();

  let startDeviceHandlers: ReturnType<typeof createStartDeviceHandlers> | undefined = undefined;
  const acquisitionHandlers = createAcquisitionHandlers({
    getBootAndPrepareDevice: () => startDeviceHandlers!.bootAndPrepareDevice,
  });
  let provisionHandlers: ReturnType<typeof createProvisionDeviceHandlers> | undefined = undefined;
  startDeviceHandlers = createStartDeviceHandlers({
    prepareDevice: acquisitionHandlers.prepareDevice,
    stripInternalAcquisitionParams: acquisitionHandlers.stripInternalAcquisitionParams,
    // createIfMissing rolls back through provisionDevice's cleanup (#11100).
    rollbackCreatedDevice: (device, failure, options) =>
      provisionHandlers!.rollbackCreatedDevice(device, failure, options),
  });
  const { startDeviceHandler, bindBootedDeviceSession, ensureCtrlProxyReady } = startDeviceHandlers;
  const { getAndroidHandler, getAppleHandler } = acquisitionHandlers;

  const { killDeviceHandler, executeDeleteDevice, deleteDeviceHandler } = createLifecycleHandlers();
  // The daemon's own deletions (abandoned broker bindings, #11174) run the same verified workflow with
  // no caller: the broker binding and session-holder refusals guard callers, not the daemon itself.
  daemonDeviceDeletion = (args, signal) => {
    const deps = getDeviceToolsDependencies();
    return executeDeleteDevice(args, deps, signal, getDeviceTeardownService(deps));
  };

  provisionHandlers = createProvisionDeviceHandlers({
    bindBootedDeviceSession,
    ensureCtrlProxyReady,
    executeDeleteDevice,
  });
  const { provisionDeviceHandler } = provisionHandlers;

  // Register with the tool registry
  registerDeviceResourceTools(getDeviceToolsDependencies);
  ToolRegistry.register(
    "listDeviceImages",
    "List device images",
    listDeviceImagesSchema,
    listDeviceImagesHandler,
    { defaultEnabled: true, outputSchema: listDeviceImagesOutputSchema, readOnly: true },
  );

  ToolRegistry.register(
    "listDevices",
    "List booted devices; pending configured-image enrichment includes retry hints and failed provenance includes a non-retryable reason; resource pointers for images and detail in the note",
    listDevicesSchema,
    listDevicesHandler,
    { defaultEnabled: true, outputSchema: listDevicesOutputSchema, readOnly: true },
  );

  // The acquiring tools are registered as the request-level race sees them: a call whose client
  // cancelled before the handler answers is undone and fails with the cancellation (#11593).
  // provisionDevice does the same inside its handler, where its typed cancellation is built.
  ToolRegistry.register(
    "getAndroid",
    "Find or recover an Android AVD and prepare it for automation. See the automobile:tools resource for every tool's default enabled/gated state before acquiring a device.",
    getAndroidSchema,
    (args, progress, signal) =>
      acquireUndoneIfUndelivered(signal, () => getAndroidHandler(args, progress, signal)),
    { defaultEnabled: true, supportsProgress: true, transportRecovery: "connect" },
  );

  ToolRegistry.register(
    "getApple",
    "Find or recover an iOS Simulator and prepare it for automation. See the automobile:tools resource for every tool's default enabled/gated state before acquiring a device.",
    getAppleSchema,
    (args, progress, signal) =>
      acquireUndoneIfUndelivered(signal, () => getAppleHandler(args, progress, signal)),
    { defaultEnabled: true, supportsProgress: true, transportRecovery: "connect" },
  );

  ToolRegistry.register(
    "startDevice",
    "Start device",
    startDeviceSchema,
    (args, progress, signal) =>
      acquireUndoneIfUndelivered(signal, () => startDeviceHandler(args, progress, signal)),
    {
      outputSchema: startDeviceOutputSchema,
      defaultEnabled: true,
      supportsProgress: true,
      hidden: true,
      transportRecovery: "connect",
    },
  );

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
