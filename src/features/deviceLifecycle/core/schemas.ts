import { z } from "zod/v4";
import {
  platformSchema,
  withCanonicalDiscriminatedUnionJsonSchema,
} from "../../../utils/schemaHelpers";
import {
  MAX_DEVICE_READY_TIMEOUT_MS,
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  MAX_PROVISION_DEVICE_TIMEOUT_MS,
} from "../../../utils/deviceTimeouts";
import {
  MIN_RUNNER_READINESS_TIMEOUT_MS,
  MAX_RUNNER_READINESS_TIMEOUT_MS,
  DEFAULT_RUNNER_PROVISION_TIMEOUT_MS,
} from "../../../utils/runnerReadinessConfig";
import { DEVICE_CREATE_ENV_VAR } from "../../../devices/deviceCreationGate";
import { enableToolsSchemaField } from "../../toolSelection/enableToolsSchemaField";
import { deviceResourceConfigurationSchema } from "../../../utils/deviceResourceSchemas";
import {
  androidProvisionDeviceSpecFields,
  iosProvisionDeviceSpecSchema,
  refineAndroidSpec,
} from "../../../utils/provisionDeviceSpecSchemas";
import { NON_EMULATABLE_CAPABILITY_IDS, OEM_PERSONA_IDS } from "../../utility/OemPersonas";

/**
 * An OEM manufacturer profile applied to the device after boot and automation readiness
 * (#14058). It simulates effects (keyboard, display, background kills), not firmware, and is
 * not the AVD hardware profile (`deviceType`) nor a pool identity.
 */
export const provisionDeviceProfileSchema = z
  .object({
    manufacturerProfile: z
      .enum(OEM_PERSONA_IDS)
      .describe("Manufacturer profile id, as listed by the manufacturerProfile tool"),
    requires: z
      .array(z.enum(NON_EMULATABLE_CAPABILITY_IDS))
      .optional()
      .describe(
        "OEM capabilities the task needs; one the manufacturer profile cannot emulate refuses with requires_real_device before anything is created",
      ),
  })
  .strict()
  .describe(
    "Android: OEM manufacturer profile applied after automation readiness and reset when the session is released; the kill facet is deferred until an app is known (apply it with killProfile). Not the hardware deviceType. Requires boot=true and readiness=automation.",
  );

export type ProvisionDeviceProfile = z.output<typeof provisionDeviceProfileSchema>;

const androidProvisionDeviceRequestSpecSchema = z
  .object({
    ...androidProvisionDeviceSpecFields,
    deviceProfile: provisionDeviceProfileSchema.optional(),
  })
  .strict()
  .superRefine(refineAndroidSpec);

export const startDeviceParametersSchema = z.object({
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
  formFactor: z
    .enum(["phone", "tablet", "foldable", "tv", "watch", "automotive"])
    .optional()
    .describe("Device form factor"),
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

export const devicePreparationTimeoutSchema = z
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

export function validateDevicePreparationTimeout(
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

export const provisionDeviceSchema = z
  .object({
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
            spec: androidProvisionDeviceRequestSpecSchema,
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
  })
  // A manufacturer profile is applied to the bound session's ready device (#14058).
  .refine(
    (args) =>
      args.device.platform !== "android" ||
      !args.device.spec.deviceProfile ||
      (args.boot !== false && args.readiness !== "none"),
    {
      path: ["device", "spec", "deviceProfile"],
      message: "A manufacturer profile requires boot=true and readiness=automation.",
    },
  );
