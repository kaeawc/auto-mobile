import { z } from "zod/v4";
import { TapAnyElement } from "../../features/action/TapAnyElement";
import { TapAtCoordinate } from "../../features/action/TapAtCoordinate";
import { previewHierarchyHitTest } from "../../features/observe/HierarchyHitTest";
import { RealObserveScreen } from "../../features/observe/ObserveScreen";
import { snapshotReferences } from "../../features/observe/SnapshotReferenceStore";
import { RecompositionTracker } from "../../features/performance/RecompositionTracker";
import { isSessionlessDeviceRead } from "../../features/toolSelection/toolSelectionContext";
import { isTruthyFlag } from "../../features/utility/elementProperties";
import {
  ActionableError,
  BootedDevice,
  type ObserveResult,
  type TapOnElementResult,
  type TapOnSelectedElement,
} from "../../models";
import { StructuredToolResponse, createStructuredToolResponse } from "../../utils/toolUtils";
import { resolveTransportDeadlineMs } from "../formTools";
import { defaultTapOnElementFactory, isIosAppOpenAlertHierarchy } from "../interactionToolHandlers";
import type { TapAnyArgs, TapAtArgs, TapOnArgs } from "../interactionToolTypes";
import { internalTapAtContext } from "../internalToolParams";
import type {
  InteractionHandlerOptions,
  InteractionToolDependencies,
  TapAtElementLike,
} from "./dependencies";
import { hitTestSchema } from "./tapSchemas";

/**
 * Build the tapOn success message so it says *what* it matched, not just
 * "Tapped on element" (#5868). A correct tap and a wrong tap were byte-identical;
 * now the message carries the resolved match identity and match count (so an
 * ambiguous selector is distinguishable from a precise one) alongside the
 * existing hierarchy-changed search summary. The structured `selectedElement`
 * (resourceId/text/bounds/totalMatches) still rides on the result for clients
 * that read the payload.
 */
export function buildTapOnResultMessage(
  selectedElement: TapOnSelectedElement | undefined,
  searchSummary: string | undefined,
  {
    activatedSubtext,
    selectorLabel,
    longPress,
  }: {
    activatedSubtext?: { text: string; occurrence: number };
    selectorLabel?: string;
    longPress?: Pick<TapOnElementResult, "action" | "longClickAdvertised">;
  } = {},
): string {
  const details = buildTapOnResultDetails(
    selectedElement,
    searchSummary,
    activatedSubtext,
    selectorLabel,
  );
  // A long press must not read as a tap: callers judged a held press "delivered as a tap" from
  // the shared "Tapped on element" wording.
  const isLongPress = longPress?.action === "longPress";
  if (isLongPress && longPress?.longClickAdvertised === false) {
    details.push("target advertises no long-click action");
  }
  const verb = isLongPress ? "Long-pressed element" : "Tapped on element";
  return details.length > 0 ? `${verb} (${details.join("; ")})` : verb;
}

/**
 * The label a caller can recognise the tapped element by: the selected node's
 * own text, else the originally matched node's text / content description (the
 * match is often promoted to a clickable row that carries no text of its own),
 * else the text the selector searched for (#11638).
 */
function selectedElementLabel(
  selectedElement: TapOnSelectedElement | undefined,
  selectorLabel: string | undefined,
): string {
  const matched = selectedElement?.matchedElement;
  return (
    selectedElement?.text || matched?.text || matched?.["content-desc"] || (selectorLabel ?? "")
  );
}

function buildTapOnResultDetails(
  selectedElement: TapOnSelectedElement | undefined,
  searchSummary: string | undefined,
  activatedSubtext?: { text: string; occurrence: number },
  selectorLabel?: string,
): string[] {
  const details: string[] = [];
  if (selectedElement) {
    // Include every available identity field, not just the resource id: Android
    // list rows commonly reuse an id such as `...:id/title`, so the id alone can't
    // tell "Internet" from "Calendar" — the text can.
    const identity: string[] = [];
    if (selectedElement.resourceId) {
      identity.push(`id=${selectedElement.resourceId}`);
    }
    if (selectedElement.testTag) {
      identity.push(`testTag=${selectedElement.testTag}`);
    }
    const label = selectedElementLabel(selectedElement, selectorLabel);
    if (label) {
      identity.push(`text=${JSON.stringify(label)}`);
    }
    details.push(`matched ${identity.length > 0 ? identity.join(" ") : "element"}`);
    const count = selectedElement.totalMatches;
    // For an ambiguous selector, name which occurrence was tapped so index 0 vs 2
    // (or a random pick) among identical rows is distinguishable.
    const index = count > 1 ? ` (index ${selectedElement.indexInMatches})` : "";
    details.push(`${count} ${count === 1 ? "match" : "matches"}${index}`);
  }
  // Append the activated semantic link whenever present, additively: an
  // owner-scoped subtext tap resolves BOTH an owner (selectedElement) and the
  // activated link, and the accessibilityLink selector resolves only the link —
  // either way, naming the link keeps taps on different links from being
  // byte-identical.
  if (activatedSubtext) {
    const occurrence =
      activatedSubtext.occurrence > 0 ? ` [occurrence ${activatedSubtext.occurrence}]` : "";
    details.push(`activated link ${JSON.stringify(activatedSubtext.text)}${occurrence}`);
  }
  if (searchSummary) {
    details.push(searchSummary);
  }
  return details;
}

const defaultTapAtElementFactory: NonNullable<
  InteractionToolDependencies["tapAtElementFactory"]
> = (device) => new TapAtCoordinate(device);

const defaultHitTestObservationFactory: NonNullable<
  InteractionToolDependencies["hitTestObservationFactory"]
> = (device) => new RealObserveScreen(device);

const defaultHitTestDeviceReadFactory: NonNullable<
  InteractionToolDependencies["hitTestDeviceReadFactory"]
> = (device, display) =>
  new RealObserveScreen(device, undefined, { display, deviceReadOnly: true });

/**
 * hitTest's observation. A watcher of a held device (the read-only device path) reads through the
 * observer capture, connect-only, like `observe {deviceId}`; it never touches the holder's session
 * pipeline or cache (#10965). Every other caller reads the session pipeline's cached-ok capture.
 */
async function readHitTestObservation(
  device: BootedDevice,
  display: string | undefined,
  signal: AbortSignal | undefined,
  deps: InteractionToolDependencies,
) {
  if (isSessionlessDeviceRead()) {
    return await (deps.hitTestDeviceReadFactory ?? defaultHitTestDeviceReadFactory)(
      device,
      display,
    ).executeDeviceRead(signal, "none");
  }
  return await (deps.hitTestObservationFactory ?? defaultHitTestObservationFactory)(device).execute(
    {
      display,
      freshness: "cached-ok",
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      skipPerformanceAudit: true,
      skipRecompositionTracking: true,
    },
  );
}

/** True when an iOS observation contains the system custom-URL confirmation. */
export function isIosAppOpenAlert(observation: ObserveResult | undefined): boolean {
  return isIosAppOpenAlertHierarchy(observation?.viewHierarchy);
}

/**
 * The hierarchy-changed search summary appended to the tapOn message. Emitted
 * when the search polled or observed changes, or when `searchUntil` was
 * requested and the observation is confirmed fresh.
 */
function buildTapOnSearchSummary(
  result: Pick<TapOnElementResult, "searchUntil" | "observation">,
  searchUntilRequested: boolean,
): string | undefined {
  const searchStats = result.searchUntil;
  if (!searchStats) {
    return undefined;
  }
  const freshness = result.observation?.freshness;
  const hasConfirmedFreshObservation =
    typeof freshness?.requestedAfter === "number" &&
    typeof freshness?.actualTimestamp === "number" &&
    freshness.actualTimestamp >= freshness.requestedAfter;
  const shouldIncludeSearchSummary =
    searchStats.requestCount > 0 ||
    searchStats.changeCount > 0 ||
    (searchUntilRequested && hasConfirmedFreshObservation);
  return shouldIncludeSearchSummary
    ? `${searchStats.changeCount} view hierarchy changes over ${searchStats.requestCount} requests within ${searchStats.durationMs}ms`
    : undefined;
}

function buildTapOnSuccessMessage(
  result: TapOnElementResult,
  searchSummary: string | undefined,
  ensureChecked: boolean | undefined,
  selectorLabel: string | undefined,
): string {
  const label = tapOnElementLabel(result, selectorLabel);
  if (result.skipped === "already-checked") {
    const state = ensureChecked ? "checked" : "unchecked";
    return `${label} already ${state}, no tap${searchSummary ? ` (${searchSummary})` : ""}`;
  }
  if (ensureChecked !== undefined && !result.error) {
    const beforeState = isTruthyFlag(result.element.checked) ? "checked" : "unchecked";
    const afterState = ensureChecked ? "checked" : "unchecked";
    const details = buildTapOnResultDetails(
      result.selectedElement,
      searchSummary,
      result.activatedSubtext,
      selectorLabel,
    );
    return `${label} was ${beforeState}, tapped, now ${afterState} (verified)${details.length > 0 ? `; ${details.join("; ")}` : ""}`;
  }
  return buildTapOnResultMessage(result.selectedElement, searchSummary, {
    activatedSubtext: result.activatedSubtext,
    selectorLabel,
    longPress: result,
  });
}

function tapOnElementLabel(result: TapOnElementResult, selectorLabel: string | undefined): string {
  // Name the thing the caller asked for before a resource id, which generic
  // widgets share across rows (`...:id/switchWidget`) (#11638).
  return (
    selectedElementLabel(result.selectedElement, selectorLabel) ||
    result.selectedElement?.resourceId ||
    result.selectedElement?.testTag ||
    result.element.text ||
    "toggle"
  );
}

export async function tapOnHandler(
  device: BootedDevice,
  args: TapOnArgs,
  { progress, signal, deps = {} }: InteractionHandlerOptions = {},
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const tapOnTextCommand = (deps.tapOnElementFactory ?? defaultTapOnElementFactory)(device);
  const result = await tapOnTextCommand.execute(
    {
      display: args.display,
      container: args.container,
      text: args.selector.text,
      textAny: args.selector.textAny,
      elementId: args.selector.elementId,
      testTag: args.selector.testTag,
      accessibilityLink: args.selector.accessibilityLink,
      sibling: args.sibling,
      selectionStrategy: args.selectionStrategy,
      index: args.index,
      action: args.action,
      duration: args.duration,
      searchUntil: args.searchUntil,
      preTapStability: args.preTapStability,
      retryIfNoChange: args.retryIfNoChange,
      ensureTap: args.ensureTap,
      ensureChecked: args.ensureChecked,
      subtext: args.subtext,
      layer: args.layer,
    },
    { progress, signal, deadlineMs: resolveTransportDeadlineMs(args) },
  );

  const searchSummary = buildTapOnSearchSummary(result, Boolean(args.searchUntil));

  // A selector miss must not read as a completed tap: gate the message on the
  // outcome and mark the MCP envelope `isError`, exactly as other action tools do since
  // #5902 (#6152). `||` not `??`: an empty-string error must still yield the
  // non-empty fallback (#4183 P4). The failure keeps the search summary so the
  // user still sees how long the selector was looked for before it missed.
  const message = result.success
    ? `${buildTapOnSuccessMessage(
        result,
        searchSummary,
        args.ensureChecked,
        args.selector.text ?? args.selector.textAny?.[0],
      )}${result.warnings?.length ? `. Warning: ${result.warnings.join("; ")}` : ""}`
    : `Failed to tap: ${result.error || "unknown error"}${searchSummary ? ` (${searchSummary})` : ""}`;
  const payload = { message, observation: result.observation, ...result };
  const response: StructuredToolResponse<typeof payload> & { isError?: true } =
    createStructuredToolResponse(payload);
  return result.success ? response : { ...response, isError: true as const };
}

export async function tapAtHandler(
  device: BootedDevice,
  args: TapAtArgs,
  { progress, signal, deps = {} }: InteractionHandlerOptions = {},
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const result = await (deps.tapAtElementFactory ?? defaultTapAtElementFactory)(device).execute(
    {
      ...(args.image !== undefined
        ? { image: args.image }
        : { x: args.x, y: args.y, coordinateSpace: args.coordinateSpace }),
      display: args.display,
      snapshotId: args.snapshotId,
      action: args.action,
      durationMs: args.durationMs,
      layer: args.layer,
      pointer: args.pointer,
    } as Parameters<TapAtElementLike["execute"]>[0],
    { progress, signal, planContext: internalTapAtContext(args) },
  );
  const message = result.success
    ? `${result.action === "longPress" ? "Long pressed" : result.action === "doubleTap" ? "Double tapped" : "Tapped"} at (${result.x}, ${result.y})`
    : `Failed to tap at (${result.x}, ${result.y}): ${result.error || "unknown error"}`;
  const payload = {
    message,
    observation: result.observation,
    ...result,
    deviceId: device.deviceId,
    platform: device.platform,
  };
  const response: StructuredToolResponse<typeof payload> & { isError?: true } =
    createStructuredToolResponse(payload);
  return result.success ? response : { ...response, isError: true as const };
}

export async function hitTestHandler(
  device: BootedDevice,
  args: z.infer<typeof hitTestSchema>,
  { signal, deps = {} }: InteractionHandlerOptions = {},
) {
  const observation = await readHitTestObservation(device, args.display, signal, deps);
  if (args.snapshotId) {
    const staleReason = snapshotReferences.staleReason(
      args.snapshotId,
      device.deviceId,
      observation,
    );
    if (staleReason) {
      throw new ActionableError(staleReason);
    }
  }
  const preview = previewHierarchyHitTest(args, observation, device.platform);
  return createStructuredToolResponse({ ...preview, deviceId: device.deviceId });
}

const defaultTapAnyElementFactory: NonNullable<
  InteractionToolDependencies["tapAnyElementFactory"]
> = (device) => new TapAnyElement(device);

function buildTapAnySearchSummary(
  result: Pick<TapOnElementResult, "searchUntil">,
): string | undefined {
  const searchStats = result.searchUntil;
  const shouldIncludeSearchSummary =
    Boolean(searchStats) && (searchStats!.requestCount > 0 || searchStats!.changeCount > 0);
  return shouldIncludeSearchSummary && searchStats
    ? `${searchStats.changeCount} view hierarchy changes over ${searchStats.requestCount} requests within ${searchStats.durationMs}ms`
    : undefined;
}

export async function tapAnyHandler(
  device: BootedDevice,
  args: TapAnyArgs,
  { progress, signal, deps = {} }: InteractionHandlerOptions = {},
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const tapAnyCommand = (deps.tapAnyElementFactory ?? defaultTapAnyElementFactory)(device);
  const result = await tapAnyCommand.execute(
    {
      display: args.display,
      container: args.container,
      selectionStrategy: args.selectionStrategy,
      scrollableContainer: args.scrollableContainer,
      action: args.action,
      duration: args.duration,
      searchUntil: args.searchUntil,
      layer: args.layer,
    },
    { progress, signal, deadlineMs: resolveTransportDeadlineMs(args) },
  );

  const searchSummary = buildTapAnySearchSummary(result);
  // A miss must not read as a completed tap: gate the message on the outcome
  // and mark the MCP envelope `isError`, exactly as tapOn does (#6152, #6163).
  const failurePrefix = "Failed to tap clickable element: ";
  const failure = result.error || "unknown error";
  const message = result.success
    ? searchSummary
      ? `Tapped clickable element (${searchSummary})`
      : "Tapped clickable element"
    : failure.startsWith(failurePrefix)
      ? failure
      : `${failurePrefix}${failure}`;
  const response = createStructuredToolResponse({
    message,
    observation: result.observation,
    ...result,
  });
  return result.success ? response : { ...response, isError: true as const };
}
