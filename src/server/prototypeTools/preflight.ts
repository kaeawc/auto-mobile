import { PROTOTYPE_DEAD_TAP_CAPABILITY } from "../../features/observe/android/ctrlProxyProtocol";
import { prototypeDeadTapsUnsupportedMessage } from "../../features/prototype/prototypeDeadTaps";
import { z } from "zod/v4";
import { createDeviceHierarchyCapture } from "../../features/observe/DeviceHierarchyCapture";
import {
  prototypeDisplayUnsupportedMessage,
  prototypeMultiSurfaceUnsupportedMessage,
} from "../../features/observe/android/CtrlProxyPrototypes";
import type { PrototypeResult } from "../../features/observe/android/ctrlProxyProtocol";
import {
  PROTOTYPE_ANCHOR_CAPABILITY,
  PROTOTYPE_APPEARANCE_CAPABILITY,
  PROTOTYPE_DISPLAY_CAPABILITY,
  PROTOTYPE_MULTI_SURFACE_CAPABILITY,
  PROTOTYPE_SHOW_IN_PLACE_CAPABILITY,
  PROTOTYPE_WINDOW_CHROME_CAPABILITY,
  PROTOTYPE_WINDOW_OPTIONS_CAPABILITY,
} from "../../features/observe/android/ctrlProxyProtocol";
import { IOS_PROTOTYPE_MULTI_SURFACE_UNSUPPORTED_MESSAGE } from "../../features/prototype/ios/iosPrototypeTransport";
import {
  hasElementAnchors,
  hasPrototypeAnchors,
  prototypeAnchorPlacementError,
  resolvePrototypeAnchors,
} from "../../features/prototype/prototypeAnchors";
import {
  prototypeAppearanceOverride,
  prototypeAppearanceUnsupportedMessage,
} from "../../features/prototype/prototypeAppearance";
import {
  prototypeShaderOptInProblem,
  prototypeShaderFields,
  PROTOTYPE_SHADERS_ANDROID_ONLY_ERROR,
} from "../../features/prototype/prototypeShaders";
import { prototypeRequiredCapabilities } from "../../features/prototype/prototypeCapabilityGates";
import {
  PROTOTYPE_IOS_MINIMUM_OS,
  prototypeIosMinimumOsNote,
} from "../../features/prototype/prototypeIosMinimumOs";
import { resolvePrototypeDisplayId } from "../../features/prototype/prototypeDisplay";
import { type PrototypeSpec } from "../../features/prototype/prototypeSpec";
import {
  resolvePrototypeWindowChrome,
  type PrototypeWindowChrome,
} from "../../features/prototype/prototypeWindowChrome";
import {
  grantPrototypeAppLayer,
  prototypeWindowOptionsUnsupportedMessage,
  requestedPrototypeWindowOptions,
} from "../../features/prototype/prototypeWindowOptions";
import type { BootedDevice } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { prototypeSchema } from "./schemas";
import type {
  AnchorStage,
  PreflightStage,
  PrototypeTarget,
  PrototypeToolDependencies,
} from "./types";

/**
 * Resolves `display` (already explicit-or-pinned) to a logical display id and refuses, before
 * anything is sent, when the device cannot honour it. Only show carries a display.
 */
async function showDisplayId(
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  // prototypePlatformError refuses display off Android, so only Android reaches the resolver.
  if (args.action !== "show" || args.display === undefined || !target.android) {
    return undefined;
  }
  const displayId = await resolvePrototypeDisplayId(device, args.display, {
    adb: (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
    lastRenderedObservation: dependencies.lastRenderedObservation,
  });
  signal?.throwIfAborted();
  // Id 0 is the default display: it needs neither the wire field nor the capability, and the
  // result schema leaves displayId absent for it, so it is never carried forward as 0.
  if (!displayId) {
    return undefined;
  }
  const supported = await target.android.supportsCommand(PROTOTYPE_DISPLAY_CAPABILITY);
  // The lookup waits for connection and handshake; a cancelled show must not carry on to the device.
  signal?.throwIfAborted();
  if (!supported) {
    throw new ActionableError(prototypeDisplayUnsupportedMessage(displayId));
  }
  return displayId;
}

/**
 * Refuses, before anything is sent, a spec whose window options the device would silently ignore.
 * It has no device side effect: the app-layer grant is [appLayerGrant], run last.
 */
async function windowOptionsRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  signal: AbortSignal | undefined,
): Promise<PrototypeResult | undefined> {
  if (args.action !== "show" || args.spec === undefined) {
    return undefined;
  }
  // Only a dead-taps show looks anything up: an extra await here shifts the show's tick timing.
  const deadTaps = wantsDeadTaps(args) ? await deadTapsRefusal(target, args, signal) : undefined;
  if (deadTaps) {
    return deadTaps;
  }
  const options = requestedPrototypeWindowOptions(args.spec as PrototypeSpec);
  if (!options.appLayer && !options.devicePersistence) {
    return undefined;
  }
  // prototypePlatformError refuses persistence off Android; layer "app" is ignored on iOS.
  if (!target.android) {
    return undefined;
  }
  const supported = await target.android.supportsCommand(PROTOTYPE_WINDOW_OPTIONS_CAPABILITY);
  // The lookup waits for connection and handshake; an abort during it must stop every variant.
  signal?.throwIfAborted();
  if (!supported) {
    return {
      success: false,
      error: new ActionableError(prototypeWindowOptionsUnsupportedMessage(options)).message,
    };
  }
  return undefined;
}

function wantsDeadTaps(args: z.infer<typeof prototypeSchema>): boolean {
  return (
    args.action === "show" && (args.spec as PrototypeSpec | undefined)?.window.deadTaps === true
  );
}

/** Dead taps must never silently disappear on an older connected agent. */
async function deadTapsRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  signal: AbortSignal | undefined,
): Promise<PrototypeResult | undefined> {
  if (!wantsDeadTaps(args)) {
    return undefined;
  }
  const supported = target.android
    ? await target.android.supportsCommand(PROTOTYPE_DEAD_TAP_CAPABILITY)
    : target.ios?.supportsCapability(PROTOTYPE_DEAD_TAP_CAPABILITY) === true;
  signal?.throwIfAborted();
  return supported
    ? undefined
    : {
        success: false,
        error: new ActionableError(
          prototypeDeadTapsUnsupportedMessage(target.android ? "android" : "ios"),
        ).message,
      };
}

/**
 * The SYSTEM_ALERT_WINDOW grant for an app-layer window (the device re-checks it and fails with
 * the appop command when the grant did not take), or undefined when the show needs none. It is a
 * device mutation, so it runs after every refusal, immediately before the show is sent.
 */
export function appLayerGrant(
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory">,
  signal: AbortSignal | undefined,
): (() => Promise<void>) | undefined {
  if (args.action !== "show" || args.spec === undefined || !target.android) {
    return undefined;
  }
  if (!requestedPrototypeWindowOptions(args.spec as PrototypeSpec).appLayer) {
    return undefined;
  }
  return async () => {
    await grantPrototypeAppLayer(
      (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
      signal,
    );
    // An abort that landed after the grant completed must still stop the mutation.
    signal?.throwIfAborted();
  };
}

/** Refuses spec-introduced features before a show or patch reaches the device. */
export async function specCapabilityRefusal(
  target: {
    android?: Pick<NonNullable<PrototypeTarget["android"]>, "supportsCommand">;
    ios?: Pick<NonNullable<PrototypeTarget["ios"]>, "supportsCapability">;
  },
  spec: unknown,
  signal: AbortSignal | undefined,
  iosMinimumOs: Readonly<Record<string, number>> = PROTOTYPE_IOS_MINIMUM_OS,
  env?: NodeJS.ProcessEnv,
): Promise<PrototypeResult | undefined> {
  if (!target.android && prototypeShaderFields(spec).length) {
    return { success: false, error: PROTOTYPE_SHADERS_ANDROID_ONLY_ERROR };
  }
  const optIn = prototypeShaderOptInProblem(spec, env);
  if (optIn) {
    return { success: false, error: optIn };
  }
  for (const gate of prototypeRequiredCapabilities(spec)) {
    const supported = target.android
      ? await target.android.supportsCommand(gate.capability)
      : target.ios?.supportsCapability(gate.capability) === true;
    // A capability lookup may wait for the connection and handshake.
    signal?.throwIfAborted();
    if (!supported) {
      const platform = target.android ? "android" : "ios";
      const note =
        platform === "ios" ? prototypeIosMinimumOsNote(gate.capability, iosMinimumOs) : "";
      const message = gate.unsupportedMessage(gate.fields, platform) + note;
      return { success: false, error: new ActionableError(message).message };
    }
  }
  return undefined;
}

/**
 * Refuses, before anything is sent, a `light` or `dark` appearance override (#11223) on a device
 * that does not advertise `prototype_appearance_v1`: an older device ignores the request field and
 * draws the prototype in the device's own mode, which the caller would take for the pinned one.
 * `device` and an omitted `appearance` send nothing, so they need no capability.
 */
async function appearanceRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  signal: AbortSignal | undefined,
): Promise<PrototypeResult | undefined> {
  const override =
    args.action === "show" ? prototypeAppearanceOverride(args.appearance) : undefined;
  if (override === undefined) {
    return undefined;
  }
  const supported = target.android
    ? await target.android.supportsCommand(PROTOTYPE_APPEARANCE_CAPABILITY)
    : target.ios?.supportsCapability(PROTOTYPE_APPEARANCE_CAPABILITY) === true;
  // The lookup waits for connection and handshake; an abort during it must stop the show.
  signal?.throwIfAborted();
  if (supported) {
    return undefined;
  }
  const message = prototypeAppearanceUnsupportedMessage(
    override,
    target.android ? "android" : "ios",
  );
  return { success: false, error: new ActionableError(message).message };
}

/** Retaining sibling surfaces must be refused before uploads, event changes or dispatch. */
async function multiSurfaceRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  signal: AbortSignal | undefined,
): Promise<PrototypeResult | undefined> {
  if (args.action !== "show" || args.replaceOthers !== false) {
    return undefined;
  }
  const supported = target.android
    ? await target.android.supportsCommand(PROTOTYPE_MULTI_SURFACE_CAPABILITY)
    : false;
  signal?.throwIfAborted();
  if (supported) {
    return undefined;
  }
  const message = target.android
    ? prototypeMultiSurfaceUnsupportedMessage()
    : IOS_PROTOTYPE_MULTI_SURFACE_UNSUPPORTED_MESSAGE;
  return { success: false, error: new ActionableError(message).message };
}

/** Resolve chrome once per show, refusing unsupported explicit requests before any mutation. */
async function windowChromeRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  signal: AbortSignal | undefined,
): Promise<{ chrome?: PrototypeWindowChrome; failure?: { success: false; error: string } }> {
  if (args.action !== "show" || !args.spec) {
    return {};
  }
  // Placement validation needs no connection or capability lookup.
  const spec = args.spec as PrototypeSpec;
  const fullscreen = spec.window.placement.type === "fullscreen";
  const supported = fullscreen
    ? target.android
      ? await target.android.supportsCommand(PROTOTYPE_WINDOW_CHROME_CAPABILITY)
      : target.ios?.supportsCapability(PROTOTYPE_WINDOW_CHROME_CAPABILITY) === true
    : false;
  signal?.throwIfAborted();
  const resolved = resolvePrototypeWindowChrome(spec, {
    supported,
    platform: target.android ? "android" : "ios",
  });
  if (resolved.refusal) {
    return { failure: { success: false, error: new ActionableError(resolved.refusal).message } };
  }
  return resolved.effective === undefined ? {} : { chrome: resolved.effective };
}

const IOS_RESET_UNSUPPORTED_MESSAGE = `The connected iOS prototype agent does not advertise ${PROTOTYPE_SHOW_IN_PLACE_CAPABILITY}, so it does not support reset: it would keep the pager pages instead of starting fresh. Nothing was shown. Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version, or omit reset.`;

/**
 * Refuses, before anything is sent or any host state changes (#11394), `reset: true` on an iOS
 * prototype agent that does not advertise `prototype_show_in_place_v1`: the transport refuses it
 * too, but only after the event epoch was reset and assets uploaded. Android needs no refusal
 * here: an older CtrlProxy re-shows fresh, which [legacyInPlaceWarning] reports.
 */
function iosResetRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
): PrototypeResult | undefined {
  if (
    args.action !== "show" ||
    args.reset !== true ||
    !target.ios ||
    target.ios.supportsCapability(PROTOTYPE_SHOW_IN_PLACE_CAPABILITY)
  ) {
    return undefined;
  }
  return { success: false, error: new ActionableError(IOS_RESET_UNSUPPORTED_MESSAGE).message };
}

const ANCHOR_UNSUPPORTED_MESSAGE = `The connected CtrlProxy does not advertise ${PROTOTYPE_ANCHOR_CAPABILITY}, so it would ignore anchor and draw the node at its normal position. Nothing was shown. Update the connected CtrlProxy, or remove anchor.`;
const IOS_ANCHOR_UNSUPPORTED_MESSAGE = `The connected iOS prototype agent does not advertise ${PROTOTYPE_ANCHOR_CAPABILITY}, so it would ignore anchor and draw the node at its normal position. Nothing was shown. Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version, or remove anchor.`;
const ANCHOR_DISPLAY_MESSAGE =
  "Element anchors resolve against the default display's app hierarchy, so they cannot be shown on another display. Nothing was shown. Omit display, or use a bounds anchor in dp.";

/** Throws when the connected CtrlProxy or iOS prototype agent would ignore the spec's anchors. */
async function assertAnchorCapability(target: PrototypeTarget): Promise<void> {
  if (target.android) {
    if (!(await target.android.supportsCommand(PROTOTYPE_ANCHOR_CAPABILITY))) {
      throw new ActionableError(ANCHOR_UNSUPPORTED_MESSAGE);
    }
    return;
  }
  if (!target.ios?.supportsCapability(PROTOTYPE_ANCHOR_CAPABILITY)) {
    throw new ActionableError(IOS_ANCHOR_UNSUPPORTED_MESSAGE);
  }
}

/** Throws when the device would ignore the spec's anchors or its placement would clip them. */
async function assertAnchorsShowable(
  target: PrototypeTarget,
  spec: PrototypeSpec,
  displayId: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  await assertAnchorCapability(target);
  signal?.throwIfAborted();
  const placementError = prototypeAnchorPlacementError(spec);
  if (placementError) {
    throw new ActionableError(placementError);
  }
  if (displayId && hasElementAnchors(spec)) {
    throw new ActionableError(ANCHOR_DISPLAY_MESSAGE);
  }
}

/** Resolves element anchors against a fresh app hierarchy; bounds anchors pass through. */
async function resolveElementAnchors(
  device: BootedDevice,
  spec: PrototypeSpec,
  request: { timeoutMs?: number; signal?: AbortSignal },
  dependencies: Pick<PrototypeToolDependencies, "anchorHierarchyCaptureFactory">,
): Promise<AnchorStage> {
  if (!hasElementAnchors(spec)) {
    return {};
  }
  const capture = (dependencies.anchorHierarchyCaptureFactory ?? createDeviceHierarchyCapture)(
    device,
  );
  const snapshot = await capture.capture({ freshness: "fresh", ...request });
  // iOS hierarchies are in points, the unit iOS spec sizes use; Android's px convert to dp.
  const resolution = resolvePrototypeAnchors(spec, {
    ...snapshot,
    boundsUnit: device.platform === "ios" ? "points" : "px",
  });
  return {
    spec: resolution.spec,
    anchors: resolution.anchors,
    ...(resolution.hierarchyUpdatedAt === undefined
      ? {}
      : { hierarchyUpdatedAt: resolution.hierarchyUpdatedAt }),
  };
}

/**
 * Refuses, before anything is shown, an anchored spec the device would silently mis-place, and
 * resolves each element anchor against a fresh app hierarchy (the prototype excluded), converting
 * Android px bounds to dp once with the display density; iOS bounds are points already (#9316). A
 * missing, ambiguous or off-screen element fails the show.
 */
async function resolveShowAnchors(
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  context: { displayId?: number; signal?: AbortSignal },
  dependencies: Pick<PrototypeToolDependencies, "anchorHierarchyCaptureFactory">,
): Promise<AnchorStage> {
  const { displayId, signal } = context;
  const spec = args.action === "show" ? (args.spec as PrototypeSpec | undefined) : undefined;
  if (!spec || !hasPrototypeAnchors(spec)) {
    return {};
  }
  try {
    await assertAnchorsShowable(target, spec, displayId, signal);
    return await resolveElementAnchors(
      device,
      spec,
      { timeoutMs: args.timeoutMs, signal },
      dependencies,
    );
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`[prototype] anchor resolution refused the show: ${errorMessage(error)}`);
    return {
      failure: {
        success: false,
        error: toActionableError(error, "Prototype anchor failed").message,
      },
    };
  }
}

/** A refused display ends the call before any asset is uploaded or anything is sent. */
async function resolveShowDisplay(
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
  signal: AbortSignal | undefined,
): Promise<{ displayId?: number; failure?: PrototypeResult }> {
  try {
    return { displayId: await showDisplayId(target, device, args, dependencies, signal) };
  } catch (error) {
    // A cancelled request is not a display refusal: let the abort end the call.
    signal?.throwIfAborted();
    logger.warn("[prototype] Request failed", error);
    return {
      failure: {
        success: false,
        error: toActionableError(error, "Prototype request failed").message,
      },
    };
  }
}

/**
 * Chrome resolution/refusal, then display resolution, the iOS reset refusal, the theme-modes
 * refusal, the appearance-override refusal, window-option support, then anchor
 * resolution: any refusal ends the call unsent and leaves the device untouched (the app-layer grant
 * is a device side effect that runs later, in [sendPrototype]). An in-place show stays on [show.shownDisplayId], so anchors are checked against that.
 */
export async function preflightMutation(
  show: { inPlace: boolean; shownDisplayId?: number },
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<
    PrototypeToolDependencies,
    "adbFactory" | "lastRenderedObservation" | "anchorHierarchyCaptureFactory" | "env"
  >,
  signal: AbortSignal | undefined,
): Promise<PreflightStage> {
  const multiSurface = await multiSurfaceRefusal(target, args, signal);
  if (multiSurface) {
    return { failure: multiSurface };
  }
  const chrome = await windowChromeRefusal(target, args, signal);
  if (chrome.failure) {
    return { failure: chrome.failure };
  }
  const resolved = await resolveMutationDisplay(
    show.inPlace,
    target,
    device,
    args,
    dependencies,
    signal,
  );
  if (resolved.failure) {
    return resolved;
  }
  const failure =
    iosResetRefusal(target, args) ??
    (args.action === "show" && args.spec !== undefined
      ? await specCapabilityRefusal(target, args.spec, signal, undefined, dependencies.env)
      : undefined) ??
    (await appearanceRefusal(target, args, signal)) ??
    (await windowOptionsRefusal(target, args, signal));
  if (failure) {
    return { displayId: resolved.displayId, failure };
  }
  const anchorDisplayId = show.inPlace ? show.shownDisplayId : resolved.displayId;
  const anchors = await resolveShowAnchors(
    target,
    device,
    args,
    { displayId: anchorDisplayId, signal },
    dependencies,
  );
  return { ...resolved, ...anchors, ...chrome };
}

/**
 * A same-id show without reset replaces the prototype in place on the display it is already on, so
 * the requested or pinned display is irrelevant: resolving it could only fail the call.
 */
async function resolveMutationDisplay(
  inPlace: boolean,
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
  signal: AbortSignal | undefined,
): Promise<{ displayId?: number; failure?: PrototypeResult }> {
  return inPlace ? {} : resolveShowDisplay(target, device, args, dependencies, signal);
}
