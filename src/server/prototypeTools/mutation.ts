import { shownBackdrop } from "../../features/prototype/prototypeBackdrop";
import { cachedPrototypeShaderAssetProblem } from "../../features/prototype/prototypeShaders";
import { defaultPrototypeAssetCache } from "../../features/prototype/prototypeAssetCache";
import {
  type DegradedEffect,
  prototypeDegradedEffectsOutput,
} from "../../features/prototype/prototypeDegradedEffects";
import { prototypeTimerWarnings } from "../../features/prototype/prototypeTimers";
import { prototypeAccessibilityOutput } from "../../features/prototype/prototypeAccessibilityLint";
import { prototypePlaceholderOutput } from "../../features/prototype/prototypePlaceholderLint";
import { pseudoLocalizeSpec } from "../../features/prototype/prototypePseudoLocale";
import { z } from "zod/v4";
import { createDeviceHierarchyCapture } from "../../features/observe/DeviceHierarchyCapture";
import { type DeviceWindowCacheInvalidator } from "../../features/observe/DeviceWindowCacheInvalidator";
import type { PrototypeResult } from "../../features/observe/android/ctrlProxyProtocol";
import {
  PROTOTYPE_PATCH_CAPABILITY,
  PROTOTYPE_SHOW_IN_PLACE_CAPABILITY,
} from "../../features/observe/android/ctrlProxyProtocol";
import { PrototypeCommitGenerations } from "../../features/prototype/PrototypeCommitGenerations";
import type { PrototypeEventSource } from "../../features/prototype/PrototypeEventCoordinator";
import { PrototypeEventCoordinator } from "../../features/prototype/PrototypeEventCoordinator";
import type { PrototypeMutation } from "../../features/prototype/PrototypeStatusStore";
import {
  type PrototypeLastResult,
  type PrototypeScope,
  type PrototypeStatusStore,
} from "../../features/prototype/PrototypeStatusStore";
import { prototypeEventSource } from "../../features/prototype/PrototypeTransport";
import { prototypeAppLayerVisibilityOutput } from "../../features/prototype/prototypeAppLayerVisibility";
import { shownAppearance } from "../../features/prototype/prototypeAppearance";
import { resolvePrototypeDisplayId } from "../../features/prototype/prototypeDisplay";
import { prototypeGestureFields } from "../../features/prototype/prototypeGestures";
import { parsePrototypeHiddenReason } from "../../features/prototype/prototypeHidden";
import {
  prototypePlatformNotes,
  prototypeStringsFallbackNotes,
} from "../../features/prototype/prototypePlatformNotes";
import { type PrototypeSpec } from "../../features/prototype/prototypeSpec";
import { recordPrototypeTextShow } from "../../features/prototype/prototypeTextTarget";
import { type PrototypeWindowChrome } from "../../features/prototype/prototypeWindowChrome";
import type { BootedDevice } from "../../models";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { performPrototypePatch, type PrototypePatchQueue } from "../prototypePatchAction";
import { patchReverseStaging, reverseLifecycle } from "../prototypeReverse";
import { isIndeterminate, shownSpecOutcome } from "../prototypeShownOutcome";
import { sendPrototype, stageAssets } from "./assets";
import { appLayerGrant, preflightMutation, specCapabilityRefusal } from "./preflight";
import { prototypeSchema } from "./schemas";
import type {
  AnchorStage,
  AssetStage,
  PreflightStage,
  PrototypeHandlerDependencies,
  PrototypeOutput,
  PrototypeTarget,
  PrototypeToolDependencies,
} from "./types";

function clearMutationEvents(
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  target: { id?: string; all?: true },
  action: PrototypeMutation,
  success: boolean,
  clearFailedShow: boolean,
): void {
  if ((action === "dismiss" && success) || (action === "show" && !success && clearFailedShow)) {
    events.dismiss(scope.deviceId, target.id);
  }
}

/**
 * A fresh show starts its event epoch before dispatch. An in-place show waits until the
 * replacement lands: a failed one leaves the old prototype on screen, so its buffered events and
 * sequence high-water mark must survive.
 */
function startFreshShowEvents(
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  source: PrototypeEventSource,
  show: { target: { id?: string }; args: { action: PrototypeMutation }; inPlace: boolean },
): void {
  if (show.args.action === "show" && !show.inPlace) {
    events.show(scope, show.target.id!, source);
  }
}

function settleShowEvents(
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  source: PrototypeEventSource,
  outcome: { target: { id?: string }; inPlace: boolean; success: boolean },
): void {
  if (outcome.inPlace && outcome.success) {
    events.show(scope, outcome.target.id!, source);
  }
}

function mutationTarget(
  args: Omit<z.infer<typeof prototypeSchema>, "action"> & { action: PrototypeMutation },
): { id?: string; all?: true } {
  if (args.all) {
    return { all: true as const };
  }
  return { id: args.action === "show" ? (args.spec as PrototypeSpec).id : args.id };
}

function shownOnDevice(
  store: PrototypeStatusStore,
  scope: PrototypeScope,
  target: { id?: string },
): PrototypeLastResult | undefined {
  return target.id ? store.shownOnDevice(scope.deviceId, target.id) : undefined;
}

/** A refused display ends the call before any asset is uploaded. */
async function stageUnlessRefused(
  failure: PrototypeResult | undefined,
  args: z.infer<typeof prototypeSchema>,
  dependencies: PrototypeHandlerDependencies,
  device: BootedDevice,
  signal: AbortSignal | undefined,
): Promise<AssetStage> {
  return failure
    ? { uploaded: [], prepared: [], failure }
    : stageAssets(
        dependencies.target,
        args,
        dependencies.assetReaders,
        signal,
        shaderCacheContext(dependencies, device.deviceId),
      );
}

export async function performPrototypeAction(
  dependencies: PrototypeHandlerDependencies,
  device: BootedDevice,
  args: Omit<z.infer<typeof prototypeSchema>, "action"> & { action: PrototypeMutation | "patch" },
  scope: PrototypeScope,
  queue: PrototypePatchQueue,
  signal?: AbortSignal,
): Promise<PrototypeOutput> {
  if (args.action === "patch") {
    const { store, target, cacheInvalidator } = dependencies;
    const patchReverse = patchReverseStaging(dependencies, device, args.id!);
    return performPrototypePatch(
      {
        store,
        transport: target.transport,
        supportsPatch: async () =>
          target.android
            ? target.android.supportsCommand(PROTOTYPE_PATCH_CAPABILITY)
            : target.ios?.supportsCapability(PROTOTYPE_PATCH_CAPABILITY) === true,
        // A patched node may add or drop a via "device" localhost request (#12530): staged here.
        specRefusal: async (spec) =>
          (await specCapabilityRefusal(target, spec, signal, undefined, dependencies.env))?.error ??
          (await cachedPrototypeShaderAssetProblem(
            spec,
            device.deviceId,
            dependencies.shaderAssetCache ?? defaultPrototypeAssetCache(),
          )) ??
          patchReverse.stage(spec),
        settleSpec: patchReverse.settle,
        platform: device.platform === "android" ? "android" : "ios",
        queue,
        retire: (result) => retireObservation(cacheInvalidator, device, result),
      },
      device.deviceId,
      { id: args.id!, ops: args.ops, baseRevision: args.baseRevision, timeoutMs: args.timeoutMs },
      signal,
    );
  }
  return performMutation(dependencies, device, { ...args, action: args.action }, scope, signal);
}

async function performMutation(
  dependencies: PrototypeHandlerDependencies,
  device: BootedDevice,
  args: Omit<z.infer<typeof prototypeSchema>, "action"> & { action: PrototypeMutation },
  scope: PrototypeScope,
  signal?: AbortSignal,
): Promise<PrototypeOutput> {
  const { store, events, target: prototypeTarget, commits } = dependencies;
  const target = mutationTarget(args);
  const source = prototypeEventSource(prototypeTarget.transport);
  // The device holds one active prototype, so presence is device-wide, not per session.
  const shown = shownOnDevice(store, scope, target);
  const inPlace = args.action === "show" && shown !== undefined && args.reset !== true;
  // An older CtrlProxy re-shows a same-id prototype fresh on the display it is sent, so its pages
  // restart. It still validates before replacing, so a refused show leaves the old prototype and its
  // events exactly as an in-place one does; only the caller needs telling.
  const legacy = await legacyInPlaceWarning(prototypeTarget, target, inPlace, signal);
  const generation = beginShowGeneration(commits, scope, args.action, target);
  // Display lookups and window-option checks precede staging, so a refused show cannot reset the event epoch.
  const ordering: ShowOrdering = {
    commits,
    scope,
    target,
    generation: generation,
    sent: false,
    startedFreshEvents: false,
  };
  const reversing = reverseLifecycle(dependencies, device, args, target);
  try {
    const resolved = await preflightWithGeneration(ordering, () =>
      preflightMutation(
        { inPlace, shownDisplayId: shown?.displayId },
        prototypeTarget,
        device,
        args,
        dependencies,
        signal,
      ),
    );
    // The device is sent resolved bounds anchors; host status keeps the authored spec's identity.
    const authoredArgs = resolved.spec ? { ...args, spec: resolved.spec } : args;
    const sendArgs = pseudoLocalizedArgs(authoredArgs);
    const comparable = await withdrawOnAbort(
      ordering,
      signal,
      comparableForMutation(resolved, inPlace, device, args, dependencies),
    );
    // An in-place show names the display it replaces on: if the prototype is dismissed while assets
    // stage, the runner then shows it fresh there instead of on the default display.
    const displayId = inPlace ? shown?.displayId : resolved.displayId;
    const stage = await withdrawOnAbort(
      ordering,
      signal,
      stageUnlessRefused(resolved.failure, sendArgs, dependencies, device, signal),
    );
    // A failed upload ends the call unsent, like a refusal: it must not supersede a valid show.
    if (stage.failure) {
      withdrawGeneration(ordering);
    }
    const reverseReport = await reversing.prepare([resolved.failure, stage.failure]);
    const { result, warning } = await withdrawOnAbort(
      ordering,
      undefined,
      sendPrototype(prototypeTarget, sendArgs, stage, signal, displayId, {
        env: dependencies.env,
        superseded: () => isSuperseded(commits, scope, target, generation),
        beforeSend: async () => {
          // Last abort check before the grant, the event epoch and the device send.
          signal?.throwIfAborted();
          await appLayerGrant(prototypeTarget, device, args, dependencies, signal)?.();
          // Last step before dispatch: a refusal, a failed upload, a lost race or a failed grant
          // must leave the event epoch of a prototype still on screen alone (#11394).
          startFreshShowEvents(events, scope, source, { target, args, inPlace });
          ordering.startedFreshEvents = args.action === "show" && !inPlace;
          if (args.action === "show" && target.id) {
            dependencies.store.beginShowDispatch(scope.deviceId, target.id);
          }
          // From here the show is issued to the device: it may be on screen, so it is never withdrawn.
          ordering.sent = true;
          if (args.action === "show") {
            ordering.specTicket = store.shownSpecs.beginShow(
              scope.deviceId,
              target.id,
              args.replaceOthers,
              device.platform === "android" ? "android" : "ios",
            );
          }
        },
      }),
    );
    endShownSpec(store, ordering, {
      action: args.action,
      success: result.success,
      id: target.id,
      spec: authoredArgs.spec,
      replaceOthers: args.replaceOthers,
      result,
    });
    retireObservation(dependencies.cacheInvalidator, device, result);
    recordPrototypeTextShow(
      device.deviceId,
      sendArgs.action,
      sendArgs.spec as PrototypeSpec | undefined,
      {
        accepted: result.success && !isSuperseded(commits, scope, target, generation),
        sent: ordering.sent,
        id: sendArgs.id,
        all: sendArgs.all,
      },
    );
    await reversing.settle(result.success, shown !== undefined, isIndeterminate(result));
    const placed = {
      ...placedDisplay(args, shown, comparable, result.success),
      chrome: resolved.chrome,
    };
    const lastResult = isSuperseded(commits, scope, target, generation)
      ? supersededResult(dependencies, { args, target, result, placed })
      : commitMutation(dependencies, scope, source, {
          args,
          target,
          result,
          placed,
          inPlace,
          previouslyShown: shown !== undefined,
          startedFreshEvents: ordering.startedFreshEvents,
        });
    const { warning: visibilityWarning, ...visibility } = await prototypeAppLayerVisibilityOutput({
      android: prototypeTarget.android !== undefined,
      action: args.action,
      success: result.success,
      hiddenReason: parsePrototypeHiddenReason(result.hiddenReason),
      spec: sendArgs.spec as PrototypeSpec,
      superseded: () => isSuperseded(commits, scope, target, generation),
      capture: () =>
        (dependencies.anchorHierarchyCaptureFactory ?? createDeviceHierarchyCapture)(device),
      timer: dependencies.timer,
      displayId,
      signal,
    });
    const spec = authoredArgs.spec;
    return {
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      lastResult,
      ...(stage.uploaded.length > 0 ? { uploadedAssets: stage.uploaded } : {}),
      ...anchorsOutput(resolved),
      ...showAdviceOutput(authoredArgs, device, prototypeTarget, result.success),
      ...visibility,
      ...reversing.output(reverseReport, result.success),
      ...missingAssetsOutput(result, [warning, placed.warning, visibilityWarning], legacy, spec),
    };
  } catch (error) {
    recordPrototypeTextShow(device.deviceId, args.action, undefined, {
      accepted: false,
      sent: ordering.sent,
    });
    // Rethrow the original error to preserve abort and ActionableError identity after binding cleanup.
    throw error;
  } finally {
    await reversing.abandon(ordering.sent);
    endShownSpec(store, ordering);
    settleGeneration(ordering);
  }
}

/** A pseudo-localized show sends altered copy; status and patch keep the authored spec. */
function pseudoLocalizedArgs<T extends { action: string; pseudoLocale?: boolean; spec?: unknown }>(
  args: T,
): T {
  return args.action === "show" && args.pseudoLocale === true && args.spec
    ? { ...args, spec: pseudoLocalizeSpec(args.spec) }
    : args;
}

/** Advisory platform notes and accessibility findings for a successful show. */
function showAdviceOutput(
  args: z.infer<typeof prototypeSchema>,
  device: BootedDevice,
  target: PrototypeTarget,
  success: boolean,
): Pick<
  PrototypeOutput,
  | "platformNotes"
  | "accessibilityFindings"
  | "accessibilityFindingsTotal"
  | "placeholderFindings"
  | "placeholderFindingsTotal"
> {
  return {
    ...platformNotesOutput(args, device, target, success),
    ...(args.action === "show" && success ? prototypeAccessibilityOutput(args.spec) : {}),
    ...(args.action === "show" && success ? prototypePlaceholderOutput(args.spec) : {}),
  };
}

/** Notes describe the expanded, anchor-resolved spec actually sent to the device. */
function platformNotesOutput(
  args: z.infer<typeof prototypeSchema>,
  device: BootedDevice,
  target: PrototypeTarget,
  success: boolean,
): Pick<PrototypeOutput, "platformNotes"> {
  if (args.action !== "show" || !success) {
    return {};
  }
  const notes: NonNullable<PrototypeOutput["platformNotes"]> = prototypePlatformNotes(
    args.spec as PrototypeSpec,
    device.platform === "ios" ? "ios" : "android",
    (capability) => target.ios?.supportsCapability(capability) === true,
    Number.parseInt(device.iosVersion ?? device.osVersion ?? "", 10) || undefined,
  );
  notes.push(...prototypeStringsFallbackNotes(args.spec as PrototypeSpec, args.locale));
  const gestures = device.platform === "ios" ? prototypeGestureFields(args.spec) : [];
  if (gestures.length > 0) {
    notes.push({
      platform: "ios",
      construct: "node.gestures",
      effect: "substituted",
      paths: gestures.slice(0, 20),
      ...(gestures.length > 20 ? { total: gestures.length } : {}),
      detail: [
        ...(gestures.some((path) => path.endsWith(".onLongPress"))
          ? [
              "Long-press uses the platform default threshold (about 0.5 s on iOS versus the Android long-press timeout, about 0.4 s).",
            ]
          : []),
        ...(gestures.some((path) => path.endsWith(".onDoubleTap"))
          ? [
              "The double-tap window is the system's. With onDoubleTap, onTap fires only after that window elapses.",
            ]
          : []),
      ].join(" "),
    });
  }
  return notes.length > 0 ? { platformNotes: notes } : {};
}

/**
 * A same-id show replaces in place only on a CtrlProxy advertising prototype_show_in_place_v1. An
 * older APK ignores reset and re-shows the prototype fresh on the display it is sent (#10642), so the
 * caller is told its pager pages restarted. iOS's prototype agent always replaces in place.
 */
async function legacyInPlaceWarning(
  target: PrototypeTarget,
  prototype: { id?: string },
  inPlace: boolean,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (!inPlace || !target.android) {
    return undefined;
  }
  const supported = await target.android.supportsCommand(PROTOTYPE_SHOW_IN_PLACE_CAPABILITY);
  // The lookup waits for connection and handshake; a cancelled show must not carry on to the device.
  signal?.throwIfAborted();
  if (supported) {
    return undefined;
  }
  return `the connected CtrlProxy does not advertise ${PROTOTYPE_SHOW_IN_PLACE_CAPABILITY}, so prototype ${prototype.id} was re-shown fresh on its display: pager pages restarted. Update the connected CtrlProxy to keep pages.`;
}

/**
 * A show or dismiss that landed changed the screen, so the observation cached before it is stale:
 * without this, the "Verify with observe" call right after returns the pre-mutation capture.
 * The foreground app is unchanged, so the iOS SDK identity is preserved.
 */
function retireObservation(
  invalidator: DeviceWindowCacheInvalidator,
  device: BootedDevice,
  result: PrototypeResult,
): void {
  if (result.success) {
    invalidator.invalidate(device, true);
  }
}

interface ShowOrdering {
  commits: PrototypeCommitGenerations;
  scope: PrototypeScope;
  target: { id?: string };
  generation: number | undefined;
  /** Set once the show is issued to the device: a show that may be on screen is never withdrawn. */
  sent: boolean;
  /** This call created the fresh event epoch; unsent refusals must not clear another call's. */
  startedFreshEvents: boolean;
  specTicket?: number;
}

function withdrawGeneration(ordering: ShowOrdering): void {
  const { commits, scope, target, generation, sent } = ordering;
  if (!sent && generation !== undefined && target.id !== undefined) {
    commits.withdraw(scope.deviceId, target.id, generation);
  }
}

function endShownSpec(
  store: PrototypeStatusStore,
  ordering: ShowOrdering,
  outcome?: Parameters<typeof shownSpecOutcome>[0],
): void {
  if (ordering.specTicket !== undefined) {
    const { shown, refusal } = outcome ? shownSpecOutcome(outcome) : {};
    store.shownSpecs.endShow(ordering.scope.deviceId, ordering.specTicket, shown, refusal);
  }
}

function settleGeneration(ordering: ShowOrdering): void {
  const { commits, scope, target, generation } = ordering;
  if (generation !== undefined && target.id !== undefined) {
    commits.settle(scope.deviceId, target.id, generation);
  }
}

/**
 * Awaits one step of a show past preflight. A step that throws, or a request cancelled while it
 * waited, withdraws the show's generation so an aborted show leaves no ordering state behind.
 */
async function withdrawOnAbort<T>(
  ordering: ShowOrdering,
  signal: AbortSignal | undefined,
  step: Promise<T>,
): Promise<T> {
  try {
    const value = await step;
    signal?.throwIfAborted();
    return value;
  } catch (error) {
    withdrawGeneration(ordering);
    throw error;
  }
}

/**
 * A show takes its generation on arrival so concurrent valid shows order by arrival, but a show the
 * host refuses (or abandons) never reaches the device and so withdraws it: it must not supersede a
 * valid in-flight show of the same id (#11477).
 */
async function preflightWithGeneration(
  ordering: ShowOrdering,
  preflight: () => Promise<PreflightStage>,
): Promise<PreflightStage> {
  const resolved = await withdrawOnAbort(ordering, undefined, preflight());
  if (resolved.failure) {
    withdrawGeneration(ordering);
  }
  return resolved;
}

function beginShowGeneration(
  commits: PrototypeCommitGenerations,
  scope: PrototypeScope,
  action: PrototypeMutation,
  target: { id?: string },
): number | undefined {
  return action === "show" && target.id ? commits.begin(scope.deviceId, target.id) : undefined;
}

function isSuperseded(
  commits: PrototypeCommitGenerations,
  scope: PrototypeScope,
  target: { id?: string },
  generation: number | undefined,
): boolean {
  return (
    generation !== undefined &&
    target.id !== undefined &&
    !commits.isLatest(scope.deviceId, target.id, generation)
  );
}

async function comparableForMutation(
  resolved: { displayId?: number; failure?: PrototypeResult },
  inPlace: boolean,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<number | undefined | null> {
  return resolved.failure
    ? undefined
    : comparableRequestedDisplay(inPlace, resolved.displayId, device, args, dependencies);
}

interface CommitOutcome {
  args: { action: PrototypeMutation; spec?: unknown; replaceOthers?: boolean };
  target: { id?: string; all?: true };
  result: PrototypeResult;
  placed: { displayId?: number; chrome?: PrototypeWindowChrome };
}

function commitMutation(
  dependencies: PrototypeHandlerDependencies,
  scope: PrototypeScope,
  source: PrototypeEventSource,
  outcome: CommitOutcome & {
    inPlace: boolean;
    previouslyShown: boolean;
    startedFreshEvents: boolean;
  },
): PrototypeLastResult {
  const { store, events } = dependencies;
  const { args, target, result, placed, inPlace, previouslyShown } = outcome;
  settleShowEvents(events, scope, source, { target, inPlace, success: result.success });
  clearMutationEvents(
    events,
    scope,
    target,
    args.action,
    result.success,
    outcome.startedFreshEvents && !previouslyShown,
  );
  if (args.action === "show" && result.success && target.id && args.replaceOthers !== false) {
    events.replaceShown(scope.deviceId, target.id);
  }
  const lastResult = store.record(scope, args.action, target, result, placed.displayId, {
    data: args.action === "show" ? (args.spec as PrototypeSpec | undefined)?.data : undefined,
    chrome: placed.chrome,
    replaceOthers: args.replaceOthers,
  });
  if (target.id && events.isDismissed(scope, target.id)) {
    store.dismissed(scope, target.id);
  }
  return lastResult;
}

/**
 * A newer show of the same id on this device started after this one, so it owns host status and
 * event buffers; this call reports only its own outcome and commits nothing.
 */
function supersededResult(
  dependencies: PrototypeHandlerDependencies,
  outcome: CommitOutcome,
): PrototypeLastResult {
  const { args, target, result, placed } = outcome;
  return {
    ...target,
    lastAction: args.action,
    ...(placed.displayId === undefined ? {} : { displayId: placed.displayId }),
    ...(args.action === "show" && result.success && placed.chrome !== undefined
      ? { chrome: placed.chrome }
      : {}),
    ...shownAppearance(args.action, result),
    ...shownBackdrop(args.action, result),
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    ...(result.totalTimeMs === undefined ? {} : { totalTimeMs: result.totalTimeMs }),
    timestamp: dependencies.now(),
  };
}

/**
 * The display an in-place show asked for (a fresh show's resolved one otherwise), resolved only to decide whether to warn that it was
 * ignored. null means it could not be resolved, which is itself ignored, so it always warns.
 */
async function comparableRequestedDisplay(
  inPlace: boolean,
  resolvedDisplayId: number | undefined,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<number | undefined | null> {
  if (!inPlace) {
    return resolvedDisplayId;
  }
  if (args.display === undefined) {
    return undefined;
  }
  try {
    const id = await resolvePrototypeDisplayId(device, args.display, {
      adb: (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
      lastRenderedObservation: dependencies.lastRenderedObservation,
    });
    return id || undefined;
  } catch (error) {
    // The selector is irrelevant to an in-place show, so an unresolvable one only changes the warning.
    logger.debug(`[prototype] ignored display selector did not resolve: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * The display an accepted mutation leaves the prototype on. A same-id show without reset is replaced
 * in place on the device, on the display it is already on, so a different requested display is
 * ignored and the caller is told so.
 */
function placedDisplay(
  args: Pick<z.infer<typeof prototypeSchema>, "action" | "reset" | "display">,
  shown: PrototypeLastResult | undefined,
  displayId: number | undefined | null,
  success: boolean,
): { displayId?: number; warning?: string } {
  if (args.action !== "show" || shown?.id === undefined) {
    return { displayId: displayId ?? undefined };
  }
  // A refused show, reset or not, leaves the prototype on the display it was already on.
  if (!success) {
    return { displayId: shown.displayId };
  }
  if (args.reset === true) {
    return { displayId: displayId ?? undefined };
  }
  if (args.display === undefined || displayId === shown.displayId) {
    return { displayId: shown.displayId };
  }
  const where =
    shown.displayId === undefined ? "the default display" : `logical display ${shown.displayId}`;
  return {
    displayId: shown.displayId,
    warning: `display was ignored: prototype ${shown.id} is already shown on ${where}, and a show with the same id replaces it in place there. Pass reset: true to show it fresh on the requested display.`,
  };
}

/** Element anchors as resolved, also reported when the show then failed, so the caller can re-anchor. */
function anchorsOutput(
  stage: AnchorStage,
): Pick<PrototypeOutput, "anchors" | "hierarchyUpdatedAt"> {
  return stage.anchors?.length
    ? {
        anchors: stage.anchors,
        ...(stage.hierarchyUpdatedAt === undefined
          ? {}
          : { hierarchyUpdatedAt: stage.hierarchyUpdatedAt }),
      }
    : {};
}

/** [landedWarning] is reported only when the mutation succeeded. */
function missingAssetsOutput(
  result: PrototypeResult,
  warnings: readonly (string | undefined)[],
  landedWarning?: string,
  spec?: unknown,
): {
  missingAssets?: string[];
  warning?: string;
  degradedEffects?: DegradedEffect[];
} {
  const degraded: ReturnType<typeof prototypeDegradedEffectsOutput> = result.success
    ? prototypeDegradedEffectsOutput(result.degradedEffects)
    : {};
  const warning = [
    ...warnings,
    degraded.warning,
    result.success ? landedWarning : undefined,
    ...(result.success ? prototypeTimerWarnings(spec) : []),
  ]
    .filter((entry) => entry !== undefined)
    .join(" ");
  return {
    ...(result.success && result.missingAssets?.length
      ? { missingAssets: result.missingAssets }
      : {}),
    ...degraded,
    ...(warning ? { warning } : {}),
  };
}

function shaderCacheContext(
  dependencies: PrototypeHandlerDependencies,
  serial: string,
): NonNullable<Parameters<typeof stageAssets>[4]> {
  return { serial, cache: dependencies.shaderAssetCache ?? defaultPrototypeAssetCache() };
}
