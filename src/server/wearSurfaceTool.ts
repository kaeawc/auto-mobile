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
  type TileTarget,
  type WearSurface,
  type WearSurfaceResult,
} from "../features/wear/WearSurface";
import {
  AdbWatchFaceSurface,
  WATCH_FACE_ACTIONS,
  WATCH_FACE_ERRORS,
  WATCH_FACE_PATTERN,
  type WatchFaceResult,
  type WatchFaceSurface,
} from "../features/wear/WatchFaceSurface";
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

const ACTIONS = [...WEAR_SURFACE_ACTIONS, ...WATCH_FACE_ACTIONS] as const;

const wearSurfaceInput = z.strictObject({
  action: z
    .enum(ACTIONS)
    .describe(
      "addTile and removeTile need component; showTile needs component (index resolved right before showing) or index. setWatchFace needs watchFace; unsetWatchFace takes nothing; setComplication needs watchFace, slot, type and provider; unsetComplication needs watchFace, slot and provider",
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
  watchFace: z
    .string()
    .regex(WATCH_FACE_PATTERN, "watchFace must be <package> or <package>/<class>")
    .optional()
    .describe(
      "Watch face: the bare package for a resource-only (WFF) face, <package>/<class> for a classic face",
    ),
  slot: z.number().int().min(0).optional().describe("Complication slot id on the watch face"),
  type: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("setComplication: androidx complication type int (SHORT_TEXT=3, RANGED_VALUE=5)"),
  provider: z
    .string()
    .regex(TILE_COMPONENT_PATTERN, "provider must be <package>/<service>")
    .optional()
    .describe("Complication data source service as <package>/<service>"),
});

type WearSurfaceArgs = z.output<typeof wearSurfaceInput>;

const broadcastSchema = z.object({
  code: z.number().nullable(),
  data: z.string().optional(),
  outcome: z.enum(BROADCAST_OUTCOMES),
  index: z.number().optional(),
  operation: z.string().optional(),
});

const faceBroadcastSchema = z.object({
  code: z.number().nullable(),
  data: z.string().optional(),
  accepted: z.boolean(),
  favoriteId: z.number().optional(),
  error: z.enum(WATCH_FACE_ERRORS).optional(),
});

const watchFaceReadingSchema = z.object({
  activeFace: z.object({ package: z.string(), className: z.string().nullable() }).optional(),
  favoriteId: z.number().optional(),
  slots: z.array(z.object({ slot: z.number(), type: z.number(), provider: z.string().nullable() })),
});

export const wearSurfaceResultSchema = z.object({
  success: z.boolean(),
  action: z.enum(ACTIONS),
  requested: z.object({
    component: z.string().optional(),
    index: z.number().optional(),
    watchFace: z.string().optional(),
    slot: z.number().optional(),
    type: z.number().optional(),
    provider: z.string().optional(),
  }),
  broadcastResult: z.union([broadcastSchema, faceBroadcastSchema]),
  indexResolution: broadcastSchema.optional(),
  index: z.number().optional(),
  verified: z
    .boolean()
    .describe("True only when an observe or dumpsys wear_service readback confirmed it"),
  applied: z
    .boolean()
    .optional()
    .describe("Watch face actions: true only when dumpsys wear_service showed the change"),
  favoriteId: z.number().optional(),
  readback: watchFaceReadingSchema.optional(),
  error: z.enum(WATCH_FACE_ERRORS).optional(),
  message: z.string(),
  reason: z.string().optional(),
});

export type WearSurfaceFactory = (device: BootedDevice) => WearSurface;
export type WatchFaceSurfaceFactory = (device: BootedDevice) => WatchFaceSurface;

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

const defaultWearSurfaceFactory: WearSurfaceFactory = (device) =>
  new AdbWearSurface({
    adb: defaultAdbClientFactory.create(device),
    timer: defaultTimer,
    observe: deviceObserver(device),
  });

const defaultWatchFaceFactory: WatchFaceSurfaceFactory = (device) =>
  new AdbWatchFaceSurface({ adb: defaultAdbClientFactory.create(device), timer: defaultTimer });

const defaultFormFactorRead = traitsFormFactorRead(
  defaultDeviceTraits,
  defaultAdbClientFactory,
  "wearSurface",
);

const WEAR_SURFACE_REFUSAL = { tool: "wearSurface", purpose: "tile and watch face tests" };

type TileCall =
  | { action: "showTile"; target: TileTarget }
  | { action: "addTile" | "removeTile"; component: string };

type FaceCall =
  | { action: "setWatchFace"; watchFace: string }
  | { action: "unsetWatchFace" }
  | { action: "setComplication"; watchFace: string; slot: number; type: number; provider: string }
  | { action: "unsetComplication"; watchFace: string; slot: number; provider: string };

type SurfaceCall = TileCall | FaceCall;

type ArgumentName = (typeof ARGUMENT_NAMES)[number];
const ARGUMENT_NAMES = [
  "component",
  "index",
  "watchFace",
  "slot",
  "type",
  "provider",
] as const satisfies ReadonlyArray<keyof WearSurfaceArgs>;

const FACE_ARGUMENTS: Record<FaceCall["action"], readonly ArgumentName[]> = {
  setWatchFace: ["watchFace"],
  unsetWatchFace: [],
  setComplication: ["watchFace", "slot", "type", "provider"],
  unsetComplication: ["watchFace", "slot", "provider"],
};

function isFaceAction(action: WearSurfaceArgs["action"]): action is FaceCall["action"] {
  return action in FACE_ARGUMENTS;
}

/** Watch face actions take exactly their own arguments; anything else is refused before adb. */
function faceCall(action: FaceCall["action"], args: WearSurfaceArgs): FaceCall {
  const wanted = FACE_ARGUMENTS[action];
  const given = ARGUMENT_NAMES.filter((name) => args[name] !== undefined);
  if (given.length !== wanted.length || !wanted.every((name) => given.includes(name))) {
    throw new ActionableError(
      `${action} takes ${wanted.length === 0 ? "no arguments" : `exactly ${wanted.join(", ")}`}.`,
    );
  }
  return buildFaceCall(action, args);
}

/** Only called once `faceCall` has checked the action's arguments are all present. */
function buildFaceCall(action: FaceCall["action"], args: WearSurfaceArgs): FaceCall {
  const { watchFace = "", slot = 0, type = 0, provider = "" } = args;
  switch (action) {
    case "setWatchFace":
      return { action, watchFace };
    case "unsetWatchFace":
      return { action };
    case "setComplication":
      return { action, watchFace, slot, type, provider };
    case "unsetComplication":
      return { action, watchFace, slot, provider };
  }
}

/** The argument combination each action takes; anything else is refused before adb runs. */
function surfaceCall(args: WearSurfaceArgs): SurfaceCall {
  const { action } = args;
  if (isFaceAction(action)) {
    return faceCall(action, args);
  }
  if (
    args.watchFace !== undefined ||
    args.slot !== undefined ||
    args.type !== undefined ||
    args.provider !== undefined
  ) {
    throw new ActionableError(`${action} takes only component or index.`);
  }
  return tileCall({ ...args, action });
}

function tileCall(args: WearSurfaceArgs & { action: TileCall["action"] }): TileCall {
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

interface Surfaces {
  tiles: WearSurfaceFactory;
  faces: WatchFaceSurfaceFactory;
}

function run(
  surfaces: Surfaces,
  device: BootedDevice,
  call: SurfaceCall,
  signal?: AbortSignal,
): Promise<WearSurfaceResult | WatchFaceResult> {
  switch (call.action) {
    case "setWatchFace":
      return surfaces.faces(device).setWatchFace(call.watchFace, signal);
    case "unsetWatchFace":
      return surfaces.faces(device).unsetWatchFace(signal);
    case "setComplication":
      return surfaces.faces(device).setComplication(call, signal);
    case "unsetComplication":
      return surfaces.faces(device).unsetComplication(call, signal);
    default:
      return runTile(surfaces.tiles(device), call, signal);
  }
}

function runTile(surface: WearSurface, call: TileCall, signal?: AbortSignal) {
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
    makeWatchFace: WatchFaceSurfaceFactory = defaultWatchFaceFactory,
  ) =>
  async (
    device: BootedDevice,
    args: WearSurfaceArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "wearSurface is Android-only: it drives Wear OS tiles and watch faces over adb.",
      );
    }
    const call = surfaceCall(args);
    await requireWatch(device, readFormFactor, WEAR_SURFACE_REFUSAL);
    const result = await run({ tiles: makeSurface, faces: makeWatchFace }, device, call, signal);
    return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
  };

const wearSurfaceTool = defineDeviceTool({
  name: "wearSurface",
  description:
    "Wear OS watches only (other form factors are refused without a change): tiles. addTile adds a tile provider to the carousel (idempotent; reports its index). removeTile removes it (also succeeds when it was absent). showTile scrolls the carousel to a tile by component (index resolved right before showing, adding the tile if absent) or by index, then observes; success requires the observe to confirm a tile container in the foreground Wear system UI. The debug broadcasts report success even when nothing happened, so verified is only true when an observe confirmed it. setWatchFace switches the active face (bare package for a WFF face, <package>/<class> for a classic one) and unsetWatchFace reverts it; setComplication puts a provider in a face slot with an androidx type int, unsetComplication empties the slot. Watch face actions succeed (applied: true) only when dumpsys wear_service shows the change: an accepted broadcast can still leave a slot empty when the provider does not support the type (error not_applied).",
  input: wearSurfaceInput,
  handler: createWearSurfaceHandler(),
  options: { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: wearSurfaceResultSchema },
});

export const wearSurfaceSchema = wearSurfaceTool.schema;
export function registerWearSurfaceTools() {
  wearSurfaceTool.register();
}
