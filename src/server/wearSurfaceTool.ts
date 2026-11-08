import { z } from "zod/v4";
import {
  ActionableError,
  type ObserveResult,
  type ViewHierarchyNode,
  type BootedDevice,
} from "../models";
import {
  AdbWearSurface,
  BROADCAST_OUTCOMES,
  TILE_COMPONENT_PATTERN,
  WEAR_SURFACE_ACTIONS,
  type SurfaceObserver,
  type SurfaceSnapshot,
  type TileProviderListResult,
  type TileTarget,
  type WearSurface,
  type WearSurfaceResult,
} from "../features/wear/WearSurface";
import { AdbTileProviderLister } from "../features/wear/TileProviders";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultDeviceTraits } from "../utils/android-cmdline-tools/deviceTraits";
import { defaultTimer } from "../utils/SystemTimer";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { requireWatch, traitsFormFactorRead, type FormFactorRead } from "./requireWatch";
import { ViewHierarchyParser } from "../utils/ViewHierarchyParser";
import { nodeAttributes } from "../models/ViewHierarchyResult";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const wearSurfaceInput = z.strictObject({
  action: z
    .enum(WEAR_SURFACE_ACTIONS)
    .describe(
      "listTileProviders takes no other argument; addTile and removeTile need component; showTile needs component (index resolved right before showing) or index",
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
  broadcastResult: broadcastSchema
    .optional()
    .describe("The broadcast that performed the action; absent for listTileProviders"),
  indexResolution: broadcastSchema.optional(),
  index: z.number().optional(),
  providers: z
    .array(z.object({ component: z.string(), packageName: z.string(), className: z.string() }))
    .optional()
    .describe("listTileProviders only: installed tile provider services"),
  verified: z.boolean().describe("True only when an observe after the action confirmed it"),
  message: z.string(),
  reason: z.string().optional(),
});

export type WearSurfaceFactory = (device: BootedDevice) => WearSurface;

/** Read tile evidence through the same hierarchy traversal used by element search. */
export function surfaceSnapshot(
  observation: Pick<ObserveResult, "viewHierarchy" | "activeWindow">,
): SurfaceSnapshot {
  const parser = new ViewHierarchyParser();
  let tileShowing = false;
  for (const root of parser.extractRootNodes(observation.viewHierarchy ?? null)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attrs = nodeAttributes(node);
      tileShowing ||=
        attrs["resource-id"] === "com.google.android.clockwork.sysui:id/carousel_tile_container";
    });
  }
  return { appId: observation.activeWindow?.appId, tileShowing };
}

/** Hierarchy plus foreground app; screenshots and fingerprint changes are not tile evidence. */
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
    return surfaceSnapshot(observation);
  };
}

const defaultWearSurfaceFactory: WearSurfaceFactory = (device) => {
  const adb = defaultAdbClientFactory.create(device);
  return new AdbWearSurface({
    adb,
    timer: defaultTimer,
    observe: deviceObserver(device),
    tileProviders: new AdbTileProviderLister(adb),
  });
};

const defaultFormFactorRead = traitsFormFactorRead(
  defaultDeviceTraits,
  defaultAdbClientFactory,
  "wearSurface",
);

const WEAR_SURFACE_REFUSAL = { tool: "wearSurface", purpose: "tile tests" };

type SurfaceCall =
  | { action: "listTileProviders" }
  | { action: "showTile"; target: TileTarget }
  | { action: "addTile" | "removeTile"; component: string };

/** The argument combination each action takes; anything else is refused before adb runs. */
function surfaceCall(args: WearSurfaceArgs): SurfaceCall {
  const { action, component, index } = args;
  if (action === "listTileProviders") {
    if (component !== undefined || index !== undefined) {
      throw new ActionableError("listTileProviders takes no component or index.");
    }
    return { action };
  }
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
    case "listTileProviders":
      return surface.listTileProviders(signal);
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
    const result: WearSurfaceResult | TileProviderListResult = await run(
      makeSurface(device),
      call,
      signal,
    );
    return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
  };

const wearSurfaceTool = defineDeviceTool({
  name: "wearSurface",
  description:
    "Wear OS watches only (other form factors are refused without a change): tiles. listTileProviders lists the installed tile provider components. addTile adds a tile provider to the carousel (idempotent; reports its index; a component that is not a tile provider fails before anything is sent, naming the valid ones). removeTile removes it (also succeeds when it was absent). showTile scrolls the carousel to a tile by component (index resolved right before showing, adding the tile if absent) or by index, then observes; success requires the observe to confirm a tile container in the foreground Wear system UI. The debug broadcasts report success even when nothing happened, so verified is only true when an observe confirmed it.",
  input: wearSurfaceInput,
  handler: createWearSurfaceHandler(),
  options: { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: wearSurfaceResultSchema },
});

export const wearSurfaceSchema = wearSurfaceTool.schema;
export function registerWearSurfaceTools() {
  wearSurfaceTool.register();
}
