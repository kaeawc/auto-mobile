import { z } from "zod/v4";

const uuid = z
  .string()
  .regex(
    /^(?:[0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
const value = z
  .object({
    value: z.string().max(1024),
    encoding: z.enum(["utf8", "hex"]).default("utf8"),
  })
  .strict()
  .refine(
    (v) => v.encoding !== "hex" || /^(?:[0-9a-f]{2})*$/i.test(v.value),
    "Hex values need pairs of hexadecimal digits",
  );

const blePeripheralInput = z
  .object({
    action: z.enum(["start", "stop", "notify", "status"]),
    name: z
      .string()
      .min(1)
      .max(20)
      .optional()
      .describe("Advertised local name (at most 20 UTF-8 bytes)"),
    address: z
      .string()
      .regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i)
      .optional()
      .describe("Default F0:F1:F2:F3:F4:F5; use distinct addresses for simultaneous peripherals"),
    presets: z
      .array(z.enum(["battery", "heartRate", "custom"]))
      .min(1)
      .max(3)
      .optional(),
    services: z
      .array(
        z
          .object({
            uuid,
            characteristics: z
              .array(
                z
                  .object({
                    uuid,
                    properties: z
                      .array(z.enum(["read", "notify"]))
                      .min(1)
                      .max(2),
                    initialValue: value.optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .optional()
      .describe("Required with the custom preset"),
    deviceId: z
      .string()
      .min(1)
      .optional()
      .describe("Android emulator serial; defaults to the session's device"),
    transport: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("Explicit Bumble transport URL; overrides device netsim discovery"),
    handle: z
      .string()
      .min(1)
      .optional()
      .describe("Session-owned handle returned by start; required for stop/notify/status"),
    characteristic: z
      .string()
      .min(1)
      .optional()
      .describe("battery, heartRate, or a configured custom characteristic UUID"),
    level: z.number().int().min(0).max(100).optional(),
    bpm: z.number().int().min(0).max(65535).optional(),
    value: value.optional().describe("Custom notification bytes as UTF-8 or hex"),
    sessionUuid: z.string().min(1).optional().describe("Calling device session"),
  })
  .strict();

export type BlePeripheralArgs = z.infer<typeof blePeripheralInput>;

function validateStart(args: BlePeripheralArgs, invalid: (message: string) => void): void {
  if (!args.name || !args.presets) {
    invalid("start requires name and presets");
  }
  if (args.name && Buffer.byteLength(args.name) > 20) {
    invalid("name exceeds 20 UTF-8 bytes");
  }
  if (args.presets?.includes("custom") !== Boolean(args.services)) {
    invalid("custom preset requires services, and services require the custom preset");
  }
  if (args.presets && new Set(args.presets).size !== args.presets.length) {
    invalid("presets must be unique");
  }
  const ids =
    args.services?.flatMap((s) => [
      s.uuid.toLowerCase(),
      ...s.characteristics.map((c) => c.uuid.toLowerCase()),
    ]) ?? [];
  if (new Set(ids).size !== ids.length) {
    invalid("custom service and characteristic UUIDs must be unique");
  }
}

function validateNotification(args: BlePeripheralArgs, invalid: (message: string) => void): void {
  if (!args.characteristic) {
    invalid("notify requires characteristic");
  } else if (args.characteristic === "battery" && args.level === undefined) {
    invalid("battery requires level (0-100)");
  } else if (args.characteristic === "heartRate" && args.bpm === undefined) {
    invalid("heartRate requires bpm");
  } else if (
    !["battery", "heartRate"].includes(args.characteristic) &&
    (!uuid.safeParse(args.characteristic).success || !args.value)
  ) {
    invalid("custom notifications require a characteristic UUID and value");
  }
}

export const blePeripheralSchema = blePeripheralInput.superRefine((args, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (args.action === "start") {
    validateStart(args, invalid);
  } else if (!args.handle) {
    invalid(`${args.action} requires handle`);
  }
  if (args.action === "notify") {
    validateNotification(args, invalid);
  }
});

export type BlePeripheralConfig = Required<
  Pick<BlePeripheralArgs, "name" | "address" | "presets">
> &
  Pick<BlePeripheralArgs, "services"> & { transport: string };
export type BleNotification = Pick<BlePeripheralArgs, "characteristic" | "level" | "bpm" | "value">;

export const bleSidecarStatusSchema = z.object({
  running: z.boolean(),
  advertising: z.boolean(),
  connected: z.array(z.string()),
  subscribed: z.array(z.string()),
  pythonReady: z.boolean(),
  bumbleReady: z.boolean(),
});
export type BleSidecarStatus = z.infer<typeof bleSidecarStatusSchema>;

export const blePeripheralOutputSchema = bleSidecarStatusSchema.extend({
  handle: z.string(),
  name: z.string(),
  address: z.string(),
  presets: z.array(z.enum(["battery", "heartRate", "custom"])),
  transport: z.string(),
});
