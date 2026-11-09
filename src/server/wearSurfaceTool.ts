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
import {
  AdbWatchFaceSurface,
  WATCH_FACE_ACTIONS,
  WATCH_FACE_ERRORS,
  WATCH_FACE_PATTERN,
  type WatchFaceChangeResult,
  type WatchFaceSurface,
} from "../features/wear/WatchFaceSurface";
import {
  AdbWatchFaceReader,
  type WatchFaceReader,
  type WatchFaceResult,
} from "../features/wear/WatchFace";
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

const WEAR_SURFACE_TOOL_ACTIONS = [
  ...WEAR_SURFACE_ACTIONS,
  "watchFace",
  ...WATCH_FACE_ACTIONS,
] as const;

const wearSurfaceInput = z.strictObject({
  action: z
    .enum(WEAR_SURFACE_TOOL_ACTIONS)
    .describe(
      "listTileProviders takes no other argument; addTile and removeTile need component; showTile needs component (index resolved right before showing) or index; watchFace takes neither and only reads. setWatchFace needs watchFace; unsetWatchFace takes nothing; setComplication needs watchFace, slot, type and provider; unsetComplication needs watchFace, slot and provider",
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

const complicationSlotSchema = z.object({
  slot: z.number(),
  type: z.number().describe("Complication data type id"),
  provider: z.string().nullable().describe("<package>/<class>, or null for an empty slot"),
});

const activeFaceSchema = z.object({
  package: z.string(),
  favoriteId: z.number().nullable(),
  fallback: z.boolean().describe("The classic fallback face, which has no slots"),
});

const favoritesSchema = z.array(
  z.object({
    favoriteId: z.number(),
    package: z.string(),
    slots: z.array(complicationSlotSchema),
  }),
);

/** Tile and watch face change actions carry requested and verified; watchFace never does. */
export const wearSurfaceResultSchema = z.object({
  success: z.boolean(),
  action: z.enum(WEAR_SURFACE_TOOL_ACTIONS),
  requested: z
    .object({
      component: z.string().optional(),
      index: z.number().optional(),
      watchFace: z.string().optional(),
      slot: z.number().optional(),
      type: z.number().optional(),
      provider: z.string().optional(),
    })
    .optional(),
  broadcastResult: z
    .union([broadcastSchema, faceBroadcastSchema])
    .optional()
    .describe(
      "The broadcast that performed the action; absent for listTileProviders and watchFace",
    ),
  indexResolution: broadcastSchema.optional(),
  index: z.number().optional(),
  providers: z
    .array(z.object({ component: z.string(), packageName: z.string(), className: z.string() }))
    .optional()
    .describe("listTileProviders only: installed tile provider services"),
  verified: z
    .boolean()
    .optional()
    .describe(
      "Tile and watch face change actions: true only when an observe or dumpsys wear_service readback confirmed it",
    ),
  applied: z
    .boolean()
    .optional()
    .describe("Watch face change actions: true only when dumpsys wear_service showed the change"),
  favoriteId: z.number().optional(),
  readback: z
    .object({
      activeFace: activeFaceSchema,
      favorites: favoritesSchema,
      ambient: z.boolean().optional(),
    })
    .optional()
    .describe("Watch face change actions: the last dumpsys wear_service readback"),
  error: z.enum(WATCH_FACE_ERRORS).optional(),
  available: z
    .boolean()
    .optional()
    .describe("watchFace: false when dumpsys wear_service had no readable watch faces"),
  activeFace: activeFaceSchema.optional(),
  favorites: favoritesSchema.optional(),
  ambient: z.boolean().optional(),
  message: z.string(),
  reason: z.string().optional(),
});

export type WearSurfaceFactory = (device: BootedDevice) => WearSurface;
export type WatchFaceReaderFactory = (device: BootedDevice) => WatchFaceReader;
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
export function createDeviceObserver(
  device: BootedDevice,
  createScreen: (
    ...args: ConstructorParameters<typeof RealObserveScreen>
  ) => Pick<RealObserveScreen, "execute"> = (...args) => new RealObserveScreen(...args),
): SurfaceObserver {
  return async (signal) => {
    // Tile controls own the caller's session; deviceReadOnly would bypass its live hierarchy.
    const observation = await createScreen(device).execute({
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
    observe: createDeviceObserver(device),
    tileProviders: new AdbTileProviderLister(adb),
  });
};

const defaultWatchFaceReaderFactory: WatchFaceReaderFactory = (device) =>
  new AdbWatchFaceReader(defaultAdbClientFactory.create(device));

const defaultWatchFaceSurfaceFactory: WatchFaceSurfaceFactory = (device) =>
  new AdbWatchFaceSurface({ adb: defaultAdbClientFactory.create(device), timer: defaultTimer });

const defaultFormFactorRead = traitsFormFactorRead(
  defaultDeviceTraits,
  defaultAdbClientFactory,
  "wearSurface",
);

const WEAR_SURFACE_REFUSAL = { tool: "wearSurface", purpose: "tile and watch-face tests" };

type TileCall =
  | { action: "watchFace" }
  | { action: "listTileProviders" }
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

const NO_ARGUMENT_READ_REFUSALS = {
  watchFace: "watchFace only reads and takes no component or index.",
  listTileProviders: "listTileProviders takes no component or index.",
} as const;

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
  if (action === "watchFace" || action === "listTileProviders") {
    if (component !== undefined || index !== undefined) {
      throw new ActionableError(NO_ARGUMENT_READ_REFUSALS[action]);
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

interface SurfaceFactories {
  makeSurface: WearSurfaceFactory;
  makeWatchFace: WatchFaceReaderFactory;
  makeWatchFaceSurface: WatchFaceSurfaceFactory;
}

type SurfaceResult =
  | WearSurfaceResult
  | TileProviderListResult
  | WatchFaceResult
  | WatchFaceChangeResult;

function run(
  device: BootedDevice,
  factories: SurfaceFactories,
  call: SurfaceCall,
  signal?: AbortSignal,
): Promise<SurfaceResult> {
  switch (call.action) {
    case "setWatchFace":
      return factories.makeWatchFaceSurface(device).setWatchFace(call.watchFace, signal);
    case "unsetWatchFace":
      return factories.makeWatchFaceSurface(device).unsetWatchFace(signal);
    case "setComplication":
      return factories.makeWatchFaceSurface(device).setComplication(call, signal);
    case "unsetComplication":
      return factories.makeWatchFaceSurface(device).unsetComplication(call, signal);
    default:
      return runTile(device, factories, call, signal);
  }
}

function runTile(
  device: BootedDevice,
  factories: SurfaceFactories,
  call: TileCall,
  signal?: AbortSignal,
): Promise<WearSurfaceResult | TileProviderListResult | WatchFaceResult> {
  if (call.action === "watchFace") {
    return factories.makeWatchFace(device).observe(signal);
  }
  const surface = factories.makeSurface(device);
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
    makeWatchFace: WatchFaceReaderFactory = defaultWatchFaceReaderFactory,
    makeWatchFaceSurface: WatchFaceSurfaceFactory = defaultWatchFaceSurfaceFactory,
  ) =>
  async (
    device: BootedDevice,
    args: WearSurfaceArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "wearSurface is Android-only: it drives the Wear OS tile carousel, watch faces and complications over adb.",
      );
    }
    const call = surfaceCall(args);
    await requireWatch(device, readFormFactor, WEAR_SURFACE_REFUSAL);
    const factories = { makeSurface, makeWatchFace, makeWatchFaceSurface };
    const result = await run(device, factories, call, signal);
    return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
  };

const wearSurfaceTool = defineDeviceTool({
  name: "wearSurface",
  description:
    "Wear OS watches only (other form factors are refused without a change): tiles, watch faces and complications. listTileProviders lists the installed tile provider components. addTile adds a tile provider to the carousel (idempotent; reports its index; a component that is not a tile provider fails before anything is sent, naming the valid ones). removeTile removes it (also succeeds when it was absent). showTile scrolls the carousel to a tile by component (index resolved right before showing, adding the tile if absent) or by index, then observes; success requires the observe to confirm a tile container in the foreground Wear system UI. The debug broadcasts report success even when nothing happened, so verified is only true when an observe confirmed it. watchFace only reads dumpsys wear_service: the active face (package, favoriteId, fallback), each favorite's complication slots (slot, type, provider or null; the active favorite's are live) and ambient; available is false when the watch faces cannot be read. setWatchFace switches the active face (bare package for a WFF face, <package>/<class> for a classic one) and unsetWatchFace reverts it; setComplication puts a provider in a face slot with an androidx type int, unsetComplication empties the slot. Watch face changes succeed (applied: true) only when a dumpsys wear_service readback shows the change: an accepted broadcast can still leave a slot empty when the provider does not support the type (error not_applied).",
  input: wearSurfaceInput,
  handler: createWearSurfaceHandler(),
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: wearSurfaceResultSchema,
    // listTileProviders only queries the package manager and watchFace only reads dumpsys
    // wear_service: both are reads (#10965). Every tile and watch face change broadcasts to the
    // watch, so it is control.
    deviceReadOnly: (args) => args.action === "listTileProviders" || args.action === "watchFace",
  },
});

export const wearSurfaceSchema = wearSurfaceTool.schema;
export function registerWearSurfaceTools() {
  wearSurfaceTool.register();
}
