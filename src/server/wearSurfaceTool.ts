import { z } from "zod/v4";
import { ActionableError, type BootedDevice } from "../models";
import {
  AdbWearSurface,
  BROADCAST_OUTCOMES,
  TILE_COMPONENT_PATTERN,
  WEAR_SURFACE_ACTIONS,
  type SurfaceObserver,
  type TileTarget,
  type WearSurface,
  type WearSurfaceResult,
} from "../features/wear/WearSurface";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultDeviceTraits } from "../utils/android-cmdline-tools/deviceTraits";
import { defaultTimer } from "../utils/SystemTimer";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { requireWatch, traitsFormFactorRead, type FormFactorRead } from "./requireWatch";
import { screenFingerprint } from "./rotaryScrollTool";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const wearSurfaceInput = z.strictObject({
  action: z
    .enum(WEAR_SURFACE_ACTIONS)
    .describe(
      "addTile and removeTile need component; showTile needs component (index resolved right before showing) or index",
    ),
  component: z
    .string()
    .regex(TILE_COMPONENT_PATTERN, "component must be <package>/<service>")
    .optional()
    .describe("Tile provider service as <package>/<service>"),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("showTile only: carousel position; indexes shift when tiles are added"),
});

type WearSurfaceArgs = z.output<typeof wearSurfaceInput>;

const broadcastSchema = z.object({
  code: z.number().nullable(),
  data: z.string().optional(),
  outcome: z.enum(BROADCAST_OUTCOMES),
  index: z.number().optional(),
  operation: z.string().optional(),
});

export const wearSurfaceResultSchema = z.object({
  success: z.boolean(),
  action: z.enum(WEAR_SURFACE_ACTIONS),
  requested: z.object({ component: z.string().optional(), index: z.number().optional() }),
  broadcastResult: broadcastSchema,
  indexResolution: broadcastSchema.optional(),
  index: z.number().optional(),
  verified: z.boolean().describe("True only when an observe after the action confirmed it"),
  message: z.string(),
  reason: z.string().optional(),
});

export type WearSurfaceFactory = (device: BootedDevice) => WearSurface;

/** Hierarchy plus foreground app; the screenshot is not needed to tell the screen changed. */
function deviceObserver(device: BootedDevice): SurfaceObserver {
  return async (signal) => {
    const observation = await new RealObserveScreen(device, undefined, {
      deviceReadOnly: true,
    }).execute({
      skipScreenshot: true,
      skipBackStack: true,
      requireFreshExtraction: true,
      signal,
    });
    return {
      ...(observation.activeWindow?.appId ? { appId: observation.activeWindow.appId } : {}),
      ...(screenFingerprint(observation) !== undefined
        ? { fingerprint: screenFingerprint(observation) }
        : {}),
    };
  };
}

const defaultWearSurfaceFactory: WearSurfaceFactory = (device) =>
  new AdbWearSurface({
    adb: defaultAdbClientFactory.create(device),
    timer: defaultTimer,
    observe: deviceObserver(device),
  });

const defaultFormFactorRead = traitsFormFactorRead(
  defaultDeviceTraits,
  defaultAdbClientFactory,
  "wearSurface",
);

const WEAR_SURFACE_REFUSAL = { tool: "wearSurface", purpose: "tile tests" };

type SurfaceCall =
  | { action: "showTile"; target: TileTarget }
  | { action: "addTile" | "removeTile"; component: string };

/** The argument combination each action takes; anything else is refused before adb runs. */
function surfaceCall(args: WearSurfaceArgs): SurfaceCall {
  const { action, component, index } = args;
  if (action === "showTile") {
    if (component !== undefined && index === undefined) {
      return { action, target: { component } };
    }
    if (index !== undefined && component === undefined) {
      return { action, target: { index } };
    }
    throw new ActionableError(
      "showTile needs exactly one of component (recommended: its current index is resolved right before showing) or index.",
    );
  }
  if (component === undefined || index !== undefined) {
    throw new ActionableError(
      `${action} needs component (<package>/<service> of the tile provider) and takes no index.`,
    );
  }
  return { action, component };
}

function run(surface: WearSurface, call: SurfaceCall, signal?: AbortSignal) {
  switch (call.action) {
    case "showTile":
      return surface.showTile(call.target, signal);
    case "addTile":
      return surface.addTile(call.component, signal);
    case "removeTile":
      return surface.removeTile(call.component, signal);
  }
}

export const createWearSurfaceHandler =
  (
    makeSurface: WearSurfaceFactory = defaultWearSurfaceFactory,
    readFormFactor: FormFactorRead = defaultFormFactorRead,
  ) =>
  async (
    device: BootedDevice,
    args: WearSurfaceArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "wearSurface is Android-only: it drives the Wear OS tile carousel over adb.",
      );
    }
    const call = surfaceCall(args);
    await requireWatch(device, readFormFactor, WEAR_SURFACE_REFUSAL);
    const result: WearSurfaceResult = await run(makeSurface(device), call, signal);
    return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
  };

const wearSurfaceTool = defineDeviceTool({
  name: "wearSurface",
  description:
    "Wear OS watches only (other form factors are refused without a change): tiles. addTile adds a tile provider to the carousel (idempotent; reports its index). removeTile removes it (also succeeds when it was absent). showTile scrolls the carousel to a tile by component (index resolved right before showing, adding the tile if absent) or by index, then observes; success requires the observe to confirm the screen changed to the Wear system UI. The debug broadcasts report success even when nothing happened, so verified is only true when an observe confirmed it.",
  input: wearSurfaceInput,
  handler: createWearSurfaceHandler(),
  options: { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: wearSurfaceResultSchema },
});

export const wearSurfaceSchema = wearSurfaceTool.schema;
export function registerWearSurfaceTools() {
  wearSurfaceTool.register();
}
