import { promises as fs } from "node:fs";
import { z } from "zod/v4";
import {
  CompareScreenshot,
  type CompareScreenshotOutcome,
  type VisualRegion,
} from "../features/visual/CompareScreenshot";
import {
  captureDeviceVisualScreen,
  defaultDisplaySettingsReader,
  readVisualDeviceProfile,
  type DeviceVisualScreenDependencies,
  type DisplaySettingsReader,
} from "../features/visual/DeviceVisualScreen";
import {
  FileVisualBaselineStore,
  type VisualBaselineStore,
} from "../features/visual/VisualBaselineStore";
import type { BootedDevice } from "../models";
import type { ImageBackend } from "../utils/image/backend/ImageBackend";
import { resolveImageBackend } from "../utils/image/backend/resolveImageBackend";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { compareScreenshotResultSchema } from "./compareScreenshotToolOutputSchemas";
import { defineDeviceTool, type DeviceToolSchema } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const finite = z.number().finite();
const rectSchema = z
  .object({ left: finite, top: finite, right: finite, bottom: finite })
  .strict()
  .describe("Platform-native screen rectangle: Android pixels, iOS points");
const regionSchema = z
  .object({
    elementId: z.string().min(1).optional().describe("Unique exposed element ID"),
    rect: rectSchema.optional(),
  })
  .strict()
  .refine((region) => (region.elementId === undefined) !== (region.rect === undefined), {
    message: "Provide exactly one of elementId or rect",
  });

const compareScreenshotInput = z.object({
  baseline: z
    .string()
    .min(1)
    .describe("Baseline name; letters, digits, '.', '_' or '-' (host-side, per device profile)"),
  mode: z
    .enum(["compare", "record", "recordIfMissing"])
    .describe("compare against, (re)record, or record only when this profile has none"),
  target: regionSchema.optional().describe("Region to compare; default the full screen"),
  mask: z
    .array(regionSchema)
    .max(64)
    .optional()
    .describe("Regions to ignore, e.g. a clock, avatar or ad"),
  ignoreSystemBars: z
    .boolean()
    .optional()
    .describe("Ignore the status and navigation bars (default true)"),
  threshold: z
    .object({
      pixelRatio: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Largest share of compared pixels that may differ (default 0)"),
      perPixelDelta: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Per-pixel colour distance treated as equal (default 0.1)"),
    })
    .strict()
    .optional(),
});

export type CompareScreenshotArgs = z.output<DeviceToolSchema<typeof compareScreenshotInput>>;

export interface CompareScreenshotToolDependencies extends DeviceVisualScreenDependencies {
  store?: VisualBaselineStore;
  imageBackend?: ImageBackend;
  readSettings?: DisplaySettingsReader;
  writeFile?: (filePath: string, data: Buffer) => Promise<void>;
  now?: () => string;
}

function messageFor(outcome: CompareScreenshotOutcome): string {
  switch (outcome.status) {
    case "recorded":
      return `Recorded baseline "${outcome.baseline}"`;
    case "compared":
      return outcome.match
        ? `Screen matches baseline "${outcome.baseline}"`
        : `Screen differs from baseline "${outcome.baseline}" (${(outcome.diffRatio * 100).toFixed(2)}% of compared pixels)`;
    default:
      return outcome.error;
  }
}

function region(value: { elementId?: string; rect?: VisualRegion["rect"] }): VisualRegion {
  return value.elementId === undefined ? { rect: value.rect } : { elementId: value.elementId };
}

export function createCompareScreenshotHandler(deps: CompareScreenshotToolDependencies = {}) {
  const store = deps.store ?? new FileVisualBaselineStore();
  return async (device: BootedDevice, args: CompareScreenshotArgs) => {
    const backend = deps.imageBackend ?? resolveImageBackend();
    const compare = new CompareScreenshot({
      capture: () => captureDeviceVisualScreen(device, deps),
      profile: (screen) =>
        readVisualDeviceProfile(
          device,
          screen,
          backend,
          deps.readSettings ?? defaultDisplaySettingsReader,
        ),
      store,
      backend,
      writeFile:
        deps.writeFile ?? ((filePath, data) => fs.writeFile(filePath, data, { mode: 0o600 })),
      now: deps.now ?? (() => new Date().toISOString()),
    });
    const outcome = await compare.execute({
      baseline: args.baseline,
      mode: args.mode,
      target: args.target ? region(args.target) : undefined,
      mask: args.mask?.map(region),
      ignoreSystemBars: args.ignoreSystemBars,
      threshold: args.threshold,
    });
    const response = createStructuredToolResponse({
      message: messageFor(outcome),
      success: outcome.status !== "failed",
      deviceId: device.deviceId,
      ...outcome,
    });
    return outcome.status === "failed" ? { ...response, isError: true as const } : response;
  };
}

const compareScreenshotTool = defineDeviceTool({
  name: "compareScreenshot",
  description:
    "Visual regression: record a named screenshot baseline (per device profile) or compare the current screen, an element, or a rectangle against it, ignoring masked regions and system bars. Returns match, diffRatio and a diff image path on mismatch.",
  input: compareScreenshotInput,
  options: {
    // A plan step that asserts the screen still looks the way it did.
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    // A fresh capture plus host-side files; nothing on the device changes (#10965).
    deviceReadOnly: true,
    outputSchema: compareScreenshotResultSchema,
  },
});

export function registerCompareScreenshotTools(deps: CompareScreenshotToolDependencies = {}): void {
  compareScreenshotTool.register(undefined, createCompareScreenshotHandler(deps));
}
