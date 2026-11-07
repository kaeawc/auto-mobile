import { disabledResourcesSchema } from "../../../utils/deviceResourceSchemas";
import { z } from "zod/v4";
import {
  listDevicesEntrySchema,
  provisionedDeviceSchema,
  configuredImageSchema,
} from "../../../daemon/deviceDescription";
import {
  platformSchema,
  addSessionUuidToSchema,
  watchAwarePlatformSchema,
} from "../../../utils/schemaHelpers";
import { MAX_DEVICE_READY_TIMEOUT_MS } from "../../../utils/deviceTimeouts";

export const listDeviceImagesSchema = z
  .object({
    platform: platformSchema,
    sessionUuid: z.string().optional().describe("Session used for inventory admission"),
    detail: z
      .enum(["compact", "full"])
      .optional()
      .describe(
        "compact (default): host-scoped capabilities once under `host`, shared `capabilityProfiles`, null fields omitted; full: every image carries its own `capabilityInventory` and null fields",
      ),
  })
  .strict();

export const listDevicesSchema = z
  .object({
    platform: watchAwarePlatformSchema(),
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

const configuredImageShape = configuredImageSchema.shape;
const capabilityInventorySchema = configuredImageShape.capabilityInventory.unwrap();

/**
 * One `images` entry: the full description (`detail: "full"`), or the compact entry that omits
 * null fields and refers to a shared `capabilityProfiles` entry by key (#17256).
 */
const listDeviceImagesEntrySchema = configuredImageSchema.extend({
  source: configuredImageShape.source.optional(),
  deviceType: configuredImageShape.deviceType.optional(),
  model: configuredImageShape.model.optional(),
  architecture: configuredImageShape.architecture.optional(),
  osVersion: configuredImageShape.osVersion.optional(),
  apiLevel: configuredImageShape.apiLevel.optional(),
  runtimeId: configuredImageShape.runtimeId.optional(),
  runtime: configuredImageShape.runtime.partial({
    deviceId: true,
    connectionId: true,
    deviceSessionUuid: true,
    poolStatus: true,
    session: true,
    serviceStatus: true,
    locked: true,
    orientation: true,
  }),
  display: configuredImageShape.display.optional(),
  image: configuredImageShape.image.optional(),
  capabilityInventory: configuredImageShape.capabilityInventory.optional(),
  availabilityError: configuredImageShape.availabilityError.optional(),
  capabilityProfile: z
    .string()
    .optional()
    .describe("Key into `capabilityProfiles`; the image's capabilities, plus `host.capabilities`"),
});

export const listDeviceImagesOutputSchema = z
  .object({
    message: z.string(),
    images: z.array(listDeviceImagesEntrySchema),
    count: z
      .number()
      .describe("Total configured images; equals images.length unless `truncated` is true"),
    platform: platformSchema,
    configuredInventory: z.unknown(),
    capabilityProfiles: z
      .record(z.string(), capabilityInventorySchema)
      .optional()
      .describe("Compact detail: capability inventories shared by images, by `capabilityProfile`"),
    host: z
      .object({ capabilities: capabilityInventorySchema.shape.capabilities })
      .optional()
      .describe(
        "Compact detail: host-scoped capabilities (host audio) that apply to every image with a `capabilityProfile`",
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        "Present only when the response was spilled to `artifact`: true when `images` holds fewer than `count` entries; read `artifact.resourceUri` (or the resource_link) for the full list",
      ),
    imagesReturned: z
      .number()
      .optional()
      .describe("Present only when spilled: number of entries inline in `images`"),
  })
  .describe(
    "A response over 64 KiB is spilled: the full result goes to `artifact` and a resource_link, and the inline result keeps count, configuredInventory, capabilityProfiles, host, truncated and imagesReturned",
  );

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
  admissionsByReason: z
    .object({ reset: z.number(), create: z.number(), restart: z.number() })
    .optional(),
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

export const provisionDeviceOutputSchema = z
  .object({
    // Its own platform enum: provisionDevice provisions Apple Watch simulators too (#15882).
    device: provisionedDeviceSchema.extend({
      platform: z.enum(["android", "ios", "watchos", "tvos", "visionos"]),
    }),
    disabledResources: disabledResourcesSchema.optional(),
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
      // Its own enum: killDevice stops Apple Watch simulators too (#14908). tvos is accepted
      // and refused by name (#15886).
      platform: z.enum(["android", "ios", "watchos", "tvos", "visionos"]),
    }),
    force: z.boolean().default(false).describe(FORCE_SKIP_AVD_VERIFICATION_DESCRIPTION),
  })
  .strict();

/** deleteDevice's request; the target's platform enum is the only part that varies. */
function teardownSchemaFor<P extends z.ZodType<string>>(platform: P) {
  return addSessionUuidToSchema(
    z
      .object({
        target: z
          .object({
            platform: platform.describe("Platform reported by automobile:devices/booted"),
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
}

export const teardownDeviceSchema = teardownSchemaFor(platformSchema);

/**
 * deleteDevice as registered: its own platform enum, because it deletes Apple Watch simulators too
 * (#15882). The Android and iOS workflow keeps {@link teardownDeviceSchema}'s narrower type.
 */
export const teardownDeviceRegistrationSchema = teardownSchemaFor(
  z.enum(["android", "ios", "watchos", "tvos", "visionos"]),
);
