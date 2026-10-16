/**
 * waitFor / settle evaluation moved out of observeTools.ts (#11828): the condition DSL, element
 * search, hierarchy hashing for settle, display-wait evidence, the poll loop and its orchestration
 * helpers. Behaviour is unchanged; observeTools.ts re-exports the public names.
 */
import {
  DEFAULT_WAIT_FOR_TIMEOUT_MS,
  DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS,
} from "../features/observe/waitForTimeout";
import { canDisplayExist, type DisplayInventoryClassification } from "../utils/deviceMatcher";
import type { DisplayPanel } from "../models/DisplayPanel";
import { type ObserveScreenshotOptions } from "../features/observe/screenshot/screenshotOptions";
import { ActionableError } from "../models/ActionableError";
import { hasUsableHierarchy } from "../features/observe/ObserveScreen";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../features/observe/interfaces/ObserveScreen";
import { RealSettleObserve } from "../features/observe/SettleObserve";
import { RealWaitForCondition } from "../features/observe/WaitForCondition";
import { hierarchyUpdatedAtToMillis } from "../features/observe/observeTimestamp";
import type {
  ConditionEvaluation,
  ConditionPredicate,
} from "../features/observe/interfaces/WaitForCondition";
import {
  appear,
  disappear,
  clickable,
  textEquals,
  countStable,
  ConditionSelector,
  usesScopedWait,
  waitContainerSelector,
  isScopedWaitResolutionError,
  waitResolutionFailure,
  waitCaptureUnavailableReason,
} from "../features/observe/ConditionPredicates";
import { throwIfAborted, awaitWhileRequestIsLive } from "../utils/toolUtils";
import { isDeviceLostError, throwDeviceLostFromAbortSignal } from "./deviceLossOutcome";
import { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../models";
import { nodeAttributes, type ViewHierarchyNode } from "../models/ViewHierarchyResult";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { scopeHierarchyToLayer } from "../features/observe/hierarchyLayer";
import type { HierarchyLayer } from "../models/HierarchyLayer";
import {
  ElementResolver,
  isMissingContainerError,
  type MatchMode,
  type ContainerFailure,
} from "../features/utility/ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "../features/utility/SearchableNode";
import {
  hasVisibleScreenPart,
  screenSizeForOffscreenCheck,
  type ScreenSizeForOffscreenCheckOptions,
} from "../features/utility/ElementGeometry";
import type { ScreenSize } from "../models/ScreenSize";
import { normalizeQuotes } from "../features/utility/TextMatcher";
import type { ResolverSelector } from "./elementSelectorSchemas";
import type { ConditionResolver } from "../features/observe/ConditionPredicates";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { serverConfig } from "../utils/ServerConfig";
import { NodeCryptoService } from "../utils/crypto";
import {
  resolveScreenshotMode,
  shouldSkipObserveWaitForScreenshot,
  type ScreenshotMode,
} from "../features/observe/automaticScreenshotPolicy";
import type {
  ObserveWaitForOptions,
  SettledOptions,
  WaitForWithSettled,
  WaitForConditionDsl,
  WaitForConditionKind,
} from "./observeTools";

const WAIT_FOR_POLL_INTERVAL_MS = 100;

/** Metadata produced by an `observe.waitFor` poll. */
export interface WaitForObservationOutcome {
  observation: ObserveResult;
  awaitedElement?: Element;
  awaitDuration: number;
  awaitTimeout: boolean;
  matched?: boolean;
  settled?: boolean;
  timedOut: boolean;
  timeoutReason?: string;
  polls: number;
  waitMs: number;
  matchedElement?: Element;
  candidates?: Element[];
  containerFailure?: ContainerFailure;
}

interface ObserveConditionEvaluation extends ConditionEvaluation {
  containerFailure?: ContainerFailure;
}

function containerFailureMetadata(failed: boolean, failure: ContainerFailure | undefined) {
  return failed && failure ? { containerFailure: failure } : {};
}

/** Record resolver diagnostics without changing predicate matching or other tools. */
function trackContainerFailure(
  finder: ConditionResolver,
  container: ObserveWaitForOptions["container"],
) {
  // Resolution may propagate unique; diagnostics keep each client-sent level.
  const levels: NonNullable<ObserveWaitForOptions["container"]>[] = [];
  for (let level = container; level; level = level.container) {
    levels.unshift(level);
  }
  let failure: ContainerFailure | undefined;
  return {
    finder: {
      resolve: (...args: Parameters<ConditionResolver["resolve"]>) => {
        const result = finder.resolve(...args);
        const resolved = result.containerFailure;
        failure ??= resolved && {
          ...resolved,
          selector: levels[resolved.level - 1] ?? resolved.selector,
        };
        return result;
      },
    } satisfies ConditionResolver,
    failure: () => failure,
    reset: () => {
      failure = undefined;
    },
  };
}

/** True when the waitFor options are the #4398 declarative `for` DSL form. */
const isConditionDsl = (waitFor: ObserveWaitForOptions): waitFor is WaitForConditionDsl =>
  (waitFor as { for?: unknown }).for !== undefined;

/**
 * Build the #4389 {@link ConditionPredicate} for a DSL `for` kind (issue #4398).
 * `stable` is intentionally not handled here — the handler routes it to
 * `RealSettleObserve` (whole-screen settle) rather than a predicate. Throws an
 * `ActionableError` for `textEquals` without a `text` value, mirroring the zod
 * refinement so the standalone tool path fails with the same actionable message.
 */
export const buildConditionPredicate = (
  finder: ConditionResolver,
  kind: WaitForConditionKind,
  selector: ConditionSelector,
  options?: { stableReads?: number },
): ConditionPredicate => {
  switch (kind) {
    case "appear":
      return appear(finder, selector);
    case "disappear":
      return disappear(finder, selector);
    case "clickable":
      return clickable(finder, selector);
    case "textEquals":
      if (selector.text === undefined) {
        throw new ActionableError(
          'waitFor "for: textEquals" requires text (the exact expected value)',
        );
      }
      return textEquals(finder, selector, selector.text);
    case "countStable":
      return countStable(finder, selector, options);
    default: {
      const exhaustive: never = kind;
      throw new ActionableError(`Unknown waitFor condition: ${String(exhaustive)}`);
    }
  }
};

/**
 * Run the declarative `for` DSL (issue #4398) and adapt its result to the shared
 * `waitForObservation` return shape. `stable` runs the settle loop
 * (`RealSettleObserve`); every other kind runs `RealWaitForCondition` with the
 * predicate for that kind. `awaitedElement` carries the matched element (never set
 * for settle / countStable, which have no single element); `awaitTimeout` reflects
 * "did not settle" / "timed out".
 */
// eslint-disable-next-line complexity -- primitive dispatch and its additive settled gate share the DSL outcome boundary.
const runWaitForConditionDsl = async (
  observeScreen: ObserveScreen,
  waitFor: WaitForConditionDsl,
  signal: AbortSignal | undefined,
  timer: Timer,
  skipBackStack: boolean = false,
  platform?: BootedDevice["platform"],
): Promise<WaitForObservationOutcome> => {
  const startTime = timer.now();
  const timeoutMs =
    waitFor.timeout ??
    waitFor.timeoutMs ??
    (waitFor.for === "stable" ? DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS : DEFAULT_WAIT_FOR_TIMEOUT_MS);
  // Omit collectDeferredBackStack here: explicit skipBackStack opts out of terminal reads too.
  const pollingScreen: ObserveScreen = skipBackStack
    ? {
        execute: (options?: ObserveScreenExecuteOptions) =>
          observeScreen.execute({ ...options, skipBackStack: true }),
        appendRawViewHierarchy: (result, abortSignal) =>
          observeScreen.appendRawViewHierarchy(result, abortSignal),
        getMostRecentCachedObserveResult: () => observeScreen.getMostRecentCachedObserveResult(),
        ...(observeScreen.captureScreenshot
          ? {
              captureScreenshot: (
                ...args: Parameters<NonNullable<ObserveScreen["captureScreenshot"]>>
              ) => observeScreen.captureScreenshot!(...args),
            }
          : {}),
        ...(observeScreen.runAccessibilityAudit
          ? {
              runAccessibilityAudit: (
                ...args: Parameters<NonNullable<ObserveScreen["runAccessibilityAudit"]>>
              ) => observeScreen.runAccessibilityAudit!(...args),
            }
          : {}),
        ...(observeScreen.processRecomposition
          ? {
              processRecomposition: (
                ...args: Parameters<NonNullable<ObserveScreen["processRecomposition"]>>
              ) => observeScreen.processRecomposition!(...args),
            }
          : {}),
        ...(observeScreen.captureCacheGeneration
          ? { captureCacheGeneration: () => observeScreen.captureCacheGeneration!() }
          : {}),
        ...(observeScreen.cacheObserveResult
          ? {
              cacheObserveResult: (
                ...args: Parameters<NonNullable<ObserveScreen["cacheObserveResult"]>>
              ) => observeScreen.cacheObserveResult!(...args),
            }
          : {}),
      }
    : observeScreen;
  const settled = (waitFor as WaitForWithSettled).settled;
  const pollMs = waitFor.pollMs;
  const applySettledGate = createSettledGate({
    settled,
    timer,
    startTime,
    timeoutMs,
    signal,
    pollingScreen,
    skipBackStack,
    platform,
  });
  if (waitFor.for === "stable") {
    const settle = await new RealSettleObserve(pollingScreen, timer).execute({
      timeoutMs: waitFor.timeout ?? waitFor.timeoutMs,
      pollMs,
      stableReads: waitFor.stableReads,
      signal,
    });
    const outcome: WaitForObservationOutcome = {
      observation: settle.observation,
      awaitedElement: undefined,
      awaitDuration: settle.waitMs,
      awaitTimeout: !settle.settled,
      settled: settle.settled,
      // The terminal reason preserves whether an Asleep observation was an
      // admissible screen-off fast-fail or merely the last stale frame at the
      // end of an exhausted timeout budget.
      timedOut: settle.terminalReason === "timeout",
      polls: settle.polls,
      waitMs: settle.waitMs,
    };
    return applySettledGate(outcome, settle.settled);
  }

  const tracked = trackContainerFailure(new ElementResolver(), waitFor.container);
  const evaluate = buildConditionPredicate(
    tracked.finder,
    waitFor.for,
    {
      elementId: waitFor.elementId,
      text: waitFor.text,
      container: waitFor.container,
      selectionStrategy: waitFor.selectionStrategy,
    },
    { stableReads: waitFor.stableReads },
  );
  const predicate: ConditionPredicate = (observation) => {
    tracked.reset();
    const evaluation = evaluate(
      layerScopedObservation(observation, (waitFor as WaitForWithSettled).layer),
    );
    return { ...evaluation, ...containerFailureMetadata(!evaluation.matched, tracked.failure()) };
  };
  const result = await new RealWaitForCondition(pollingScreen, timer).execute(predicate, {
    timeoutMs: waitFor.timeout ?? waitFor.timeoutMs,
    pollMs,
    signal,
  });
  const outcome: WaitForObservationOutcome = {
    observation: result.observation,
    awaitedElement: result.matchedElement,
    awaitDuration: result.waitMs,
    awaitTimeout: result.timedOut,
    matched: result.matched,
    timedOut: result.timedOut,
    polls: result.polls,
    waitMs: result.waitMs,
    matchedElement: result.matchedElement,
    candidates: result.candidates,
    ...containerFailureMetadata(result.timedOut, tracked.failure()),
    ...(result.diagnostic
      ? {
          timeoutReason: `Timed out after ${result.waitMs} ms waiting for ${waitFor.for}; ${result.diagnostic}`,
        }
      : {}),
  };
  return applySettledGate(outcome, result.matched, predicate);
};

const waitForContainerForFinder = (waitFor: ObserveWaitForOptions): ResolverSelector | undefined =>
  waitContainerSelector(waitFor.container);

function shouldRetryCompoundText(
  waitFor: ObserveWaitForOptions,
  negative: boolean,
  sets: readonly (readonly unknown[])[],
): boolean {
  if (negative || waitFor.matchType === "any" || waitFor.text === undefined) {
    return false;
  }
  if (waitFor.textMatch !== undefined || sets.length < 2) {
    return false;
  }
  return !sets.some((set) => set.some((node) => sets.every((other) => other.includes(node))));
}

function retryCompoundText<T>(
  waitFor: ObserveWaitForOptions,
  negative: boolean,
  predicates: ResolverSelector[],
  sets: T[][],
  resolve: (selector: ResolverSelector) => T[],
): void {
  if (!shouldRetryCompoundText(waitFor, negative, sets)) {
    return;
  }
  const textIndex = predicates.findIndex((selector) => selector.text !== undefined);
  sets[textIndex] = resolve({ text: waitFor.text!, match: "contains" });
}

function isWaitSourceVisible(
  element: Element | undefined,
  screenSize: ScreenSize | undefined,
  negative: boolean,
): boolean {
  return element !== undefined && (negative || hasVisibleScreenPart(element.bounds, screenSize));
}

interface WaitForElementOptions extends ScreenSizeForOffscreenCheckOptions {
  negative?: boolean;
  evaluation?: ConditionEvaluation;
}

function resolveWaitForElementOptions(
  options: boolean | WaitForElementOptions,
  context: { hierarchy: ViewHierarchyResult; platform?: BootedDevice["platform"] },
): { negative: boolean; screenSize: ScreenSize | undefined } {
  const resolved = typeof options === "boolean" ? { negative: options } : options;
  return {
    negative: resolved.negative ?? false,
    screenSize: screenSizeForOffscreenCheck(context.hierarchy, {
      ...resolved,
      platform: context.platform ?? resolved.platform,
    }),
  };
}

function finderForSelection(
  finder: ConditionResolver,
  candidates: SearchableEntry[],
  selectionStrategy: ResolverSelector["selectionStrategy"],
) {
  return finder.resolve(
    {
      id: "wait-selection",
      nodes: candidates.map((node, index) => ({ ...node, index, parentIndex: undefined })),
    },
    { selectionStrategy },
    { action: "inspect" },
  );
}

function bindWaitScope(nodes: readonly SearchableEntry[], scope: SearchableEntry) {
  let key = "wait-resolved-scope";
  while (nodes.some((node) => node.nodeKey === key || node.nativeId === key)) {
    key += "_";
  }
  return {
    nodes: nodes.map((node) => (node === scope ? { ...node, nodeKey: key } : node)),
    container: { elementId: key },
  };
}

/** Resolve the chain once per frame, then pin later compound fields to that exact scope. */
function scopedWaitFinder(
  finder: ConditionResolver,
  waitFor: ObserveWaitForOptions,
  evaluation: ConditionEvaluation,
): ConditionResolver {
  let bound: { nodes: readonly SearchableEntry[]; container: ResolverSelector } | undefined;
  return {
    resolve: (snapshot, selector, intent) => {
      const container = bound?.container ?? waitForContainerForFinder(waitFor);
      const result = finder.resolve(
        { ...snapshot, nodes: bound?.nodes ?? snapshot.nodes },
        {
          ...selector,
          container: container && {
            ...container,
            selectionStrategy:
              waitFor.selectionStrategy === "unique" ? "unique" : container.selectionStrategy,
          },
        },
        intent,
      );
      if (result.error && !isScopedWaitResolutionError(result.error)) {
        throw new ActionableError(result.error);
      }
      const failure = waitResolutionFailure(result, waitFor, true);
      if (failure) {
        Object.assign(evaluation, failure);
        return result;
      }
      if (!bound && result.scope) {
        bound = bindWaitScope(snapshot.nodes, result.scope);
      }
      return result;
    },
  };
}

function waitElementSelectors(waitFor: ObserveWaitForOptions): ResolverSelector[] {
  const predicates: ResolverSelector[] = [];
  if (waitFor.elementId !== undefined) {
    predicates.push({ elementId: waitFor.elementId });
  }
  if (waitFor.text !== undefined) {
    predicates.push({ text: waitFor.text, match: waitFor.textMatch });
  }
  if (waitFor.className !== undefined) {
    predicates.push({ className: waitFor.className });
  }
  if (waitFor.contentDescription !== undefined) {
    predicates.push({ contentDescription: waitFor.contentDescription, match: "exact" });
  }
  return predicates;
}

function waitElementEvaluation(options: boolean | WaitForElementOptions): ConditionEvaluation {
  return typeof options === "boolean"
    ? { matched: false }
    : (options.evaluation ?? { matched: false });
}

function chooseWaitElement(
  finder: ConditionResolver,
  eligible: SearchableEntry[],
  waitFor: ObserveWaitForOptions,
  negative: boolean,
  evaluation: ConditionEvaluation,
): Element | null {
  if (!usesScopedWait(waitFor)) {
    return eligible[0]?.element ?? null;
  }
  if (evaluation.diagnostic) {
    return null;
  }
  // Scope and compound matching are already proven; the shared resolver chooses
  // among these source nodes without another random draw of the container chain.
  const selected = finderForSelection(finder, eligible, waitFor.selectionStrategy);
  if (waitFor.container && selected.error === "Target not found") {
    selected.error = "Target not found within container";
  }
  const failure = waitResolutionFailure(selected, waitFor, negative);
  if (failure) {
    Object.assign(evaluation, failure);
  }
  return selected.chosen?.element ?? null;
}

export const findWaitForElement = (
  finder: ConditionResolver,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  platform?: BootedDevice["platform"],
  modes = new Map<string, MatchMode>(),
  options: boolean | WaitForElementOptions = false,
): Element | null => {
  const evaluation = waitElementEvaluation(options);
  const scoped = usesScopedWait(waitFor);
  const selectionFinder = finder;
  if (scoped) {
    finder = scopedWaitFinder(finder, waitFor, evaluation);
  }
  const { negative, screenSize } = resolveWaitForElementOptions(options, {
    hierarchy: viewHierarchy,
    platform,
  });
  const snapshot = {
    id: "wait",
    // Compound predicates describe one source node, not its hoisted display row.
    nodes: new SearchableHierarchy().project(viewHierarchy).map((node) => ({
      ...node,
      textFields: Object.values(node.textSources),
    })),
  };
  const canTryVisibleContains = (
    selector: ResolverSelector,
    key: string,
    mode: MatchMode,
    visibleCount: number,
  ) =>
    Boolean(waitFor.textAny) &&
    !negative &&
    selector.match === undefined &&
    !modes.has(key) &&
    mode === "exact" &&
    visibleCount === 0;
  const resolve = (selector: ResolverSelector) => {
    const key = JSON.stringify(selector);
    let result = finder.resolve(
      snapshot,
      { ...selector, container: waitForContainerForFinder(waitFor) ?? undefined },
      { action: "inspect", negative, matchMode: modes.get(key) },
    );
    if (
      isMissingContainerError(result.error) ||
      (scoped && isScopedWaitResolutionError(result.error))
    ) {
      return [];
    }
    if (result.error) {
      throw new ActionableError(result.error);
    }
    const visibleSources = (resolution: typeof result) =>
      [
        ...new Set(resolution.matches.flatMap(({ node, sourceNodes }) => sourceNodes ?? [node])),
      ].filter((node) => {
        if (!isWaitSourceVisible(node.element, screenSize, negative)) {
          return false;
        }
        if (selector.text === undefined || selector.match !== "exact") {
          return true;
        }
        const expected = normalizeQuotes(selector.text).toLowerCase();
        const trimNode = selector.text === selector.text.trim();
        return Object.values(node.textSources).some(
          (value) => normalizeQuotes(trimNode ? value.trim() : value).toLowerCase() === expected,
        );
      });
    let candidates = visibleSources(result);
    if (canTryVisibleContains(selector, key, result.matchMode, candidates.length)) {
      result = finder.resolve(
        snapshot,
        {
          ...selector,
          container: waitForContainerForFinder(waitFor) ?? undefined,
          match: "contains",
        },
        { action: "inspect", matchMode: "contains" },
      );
      if (result.error) {
        throw new ActionableError(result.error);
      }
      candidates = visibleSources(result);
    }
    if (!waitFor.textAny || candidates.length > 0) {
      modes.set(key, result.matchMode);
    }
    return candidates;
  };
  if (waitFor.textAny) {
    for (const text of waitFor.textAny) {
      const candidate = resolve({ text, match: waitFor.textMatch })[0];
      if (candidate) {
        return candidate.element!;
      }
    }
  }
  const predicates = waitElementSelectors(waitFor);
  const sets = predicates.map((selector) => {
    const candidates = resolve(selector);
    // Older iOS captures expose the accessibility label only as text. Keep this
    // rich-wait compatibility local; field-specific focus selectors stay strict.
    if (platform === "ios" && selector.contentDescription !== undefined) {
      candidates.push(
        ...resolve({ text: selector.contentDescription, match: "exact" }).filter(
          (node) => !node.accessibleLabel && !node.textSources["content-desc"],
        ),
      );
    }
    return candidates;
  });
  retryCompoundText(waitFor, negative, predicates, sets, resolve);
  const candidates = [...new Set(sets.flat())].sort(
    (a, b) => a.windowRank - b.windowRank || a.index - b.index,
  );
  const eligible = candidates.filter((candidate) =>
    waitFor.matchType === "any"
      ? sets.some((set) => set.includes(candidate))
      : sets.every((set) => set.includes(candidate)),
  );
  return chooseWaitElement(selectionFinder, eligible, waitFor, negative, evaluation);
};

export const hasElementPredicate = (
  waitFor: Pick<
    ObserveWaitForOptions,
    "elementId" | "text" | "textAny" | "className" | "contentDescription"
  >,
): boolean =>
  waitFor.elementId !== undefined ||
  waitFor.text !== undefined ||
  waitFor.textAny !== undefined ||
  waitFor.className !== undefined ||
  waitFor.contentDescription !== undefined;

const matchesActiveWindow = (
  observation: ObserveResult,
  waitFor: ObserveWaitForOptions,
  platform?: BootedDevice["platform"],
): boolean => {
  if (!waitFor.activeWindow) {
    return true;
  }

  const activeWindow = observation.activeWindow;
  if (!activeWindow) {
    return false;
  }

  if (
    waitFor.activeWindow.appId !== undefined &&
    activeWindow.appId !== waitFor.activeWindow.appId
  ) {
    return false;
  }

  if (
    platform === "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    waitFor.activeWindow.appId === undefined
  ) {
    return false;
  }

  if (
    platform !== "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    activeWindow.activityName !== waitFor.activeWindow.activityName
  ) {
    return false;
  }

  return true;
};

// Absence / negation predicate (issue #3490 §4). Reuses the same element
// matcher: the `absent` fields describe an element that must NOT be present, so
// the predicate is satisfied exactly when no element matches them. Returns true
// (vacuously satisfied) when no `absent` predicate is configured.
const matchesAbsent = (
  finder: ConditionResolver,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  platform: BootedDevice["platform"] | undefined,
  sizeOptions: ScreenSizeForOffscreenCheckOptions,
  evaluation: ConditionEvaluation,
): boolean => {
  if (!waitFor.absent) {
    return true;
  }
  const absentAsWaitFor = {
    ...waitFor.absent,
    container: waitFor.container,
    selectionStrategy: waitFor.absent.selectionStrategy ?? waitFor.selectionStrategy,
  } as ObserveWaitForOptions;
  return (
    findWaitForElement(finder, absentAsWaitFor, viewHierarchy, platform, new Map(), {
      ...sizeOptions,
      negative: true,
      evaluation,
    }) === null && !evaluation.diagnostic
  );
};

const matchesDisplayStamp = (
  observation: ObserveResult,
  waitFor: ObserveWaitForOptions,
  displayInventory: DisplayInventoryClassification,
): boolean => {
  const display = observation.display;
  const isSingleInventoryStub =
    displayInventory === "single" && display?.key === "0" && display.role === "unknown";
  return (
    (waitFor.posture === undefined || display?.posture === waitFor.posture) &&
    (waitFor.activeDisplay === undefined ||
      (!isSingleInventoryStub &&
        (display?.key === waitFor.activeDisplay || display?.role === waitFor.activeDisplay)))
  );
};

/**
 * The observation an element predicate sees for `layer` (issue #9305). Only the
 * hierarchy is scoped; the polled observation itself, and the cache behind it,
 * keep every window.
 */
function layerScopedObservation(
  observation: ObserveResult,
  layer: HierarchyLayer | undefined,
): ObserveResult {
  if (layer === undefined || !observation.viewHierarchy) {
    return observation;
  }
  return {
    ...observation,
    viewHierarchy: scopeHierarchyToLayer(observation.viewHierarchy, layer),
  };
}

const evaluateWaitForObservation = (
  finder: ConditionResolver,
  waitFor: WaitForWithSettled,
  observation: ObserveResult,
  platform: BootedDevice["platform"] | undefined,
  displayInventory: DisplayInventoryClassification,
  { modes, iosMultiPanel }: { modes: Map<string, MatchMode>; iosMultiPanel: boolean },
): ObserveConditionEvaluation & { awaitedElement?: Element } => {
  observation = layerScopedObservation(observation, waitFor.layer);
  const sizeOptions = {
    platform,
    iosMultiPanel,
    observationScreenSize: observation.screenSize,
    display: observation.viewHierarchy,
  };
  const evaluation: ObserveConditionEvaluation = { matched: false };
  const tracked = trackContainerFailure(finder, waitFor.container);
  finder = tracked.finder;
  const needsHierarchy =
    hasElementPredicate(waitFor) || waitFor.absent !== undefined || waitFor.settled !== undefined;
  const diagnostic = needsHierarchy ? waitCaptureUnavailableReason(observation) : undefined;
  if (diagnostic) {
    return { matched: false, diagnostic };
  }
  const activeWindowMatched = matchesActiveWindow(observation, waitFor, platform);
  const displayMatched = matchesDisplayStamp(observation, waitFor, displayInventory);
  const needsElementMatch = hasElementPredicate(waitFor);
  const awaitedElement =
    needsElementMatch && observation.viewHierarchy
      ? findWaitForElement(finder, waitFor, observation.viewHierarchy, platform, modes, {
          ...sizeOptions,
          evaluation,
        })
      : null;
  // The shared admission guard above ensures absence is evaluated only on a
  // usable capture; an unavailable tree cannot prove that an element is gone.
  const absentSatisfied =
    waitFor.absent === undefined
      ? true
      : observation.viewHierarchy
        ? matchesAbsent(
            finder,
            waitFor,
            observation.viewHierarchy,
            platform,
            sizeOptions,
            evaluation,
          )
        : false;

  const matched = [
    activeWindowMatched,
    displayMatched,
    absentSatisfied,
    !needsElementMatch || awaitedElement !== null,
  ].every(Boolean);
  return {
    ...evaluation,
    ...containerFailureMetadata(!matched, tracked.failure()),
    matched,
    awaitedElement: awaitedElement ?? undefined,
  };
};

const SETTLE_VOLATILE_NODE_FIELDS = new Set([
  "extras",
  "occlusionState",
  "occludedBy",
  "occludedByViewId",
  "recomposition",
  "recompositionMetrics",
]);

function normalizeSettleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeSettleValue);
  }
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeSettleValue((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }
  return value;
}

function normalizeSettleAttributes(
  attributes: Record<string, unknown>,
  excludedFields: ReadonlySet<string>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(attributes).sort()) {
    if (!excludedFields.has(key)) {
      normalized[key] = normalizeSettleValue(attributes[key]);
    }
  }
  return normalized;
}

function normalizeSettleNode(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const node = value as ViewHierarchyNode;
  const nodeRecord: Record<string, unknown> = { ...node };
  const attributes = nodeAttributes(node);
  const normalized = normalizeSettleAttributes(
    nodeRecord,
    new Set([...SETTLE_VOLATILE_NODE_FIELDS, "node", "$"]),
  );
  // Hash every node field by default so newly added accessibility attributes
  // (for example iOS value or Android hint/error) cannot hide UI changes.
  // Only known capture noise is excluded from the settle signal.
  if (node.$ !== undefined) {
    normalized.$ = normalizeSettleAttributes(attributes, SETTLE_VOLATILE_NODE_FIELDS);
  }
  const children = node.node;
  if (children !== undefined) {
    const childNodes = Array.isArray(children) ? children : [children];
    normalized.node = childNodes.map(normalizeSettleNode);
  }
  return normalized;
}

function normalizeHierarchyForSettle(hierarchy: ViewHierarchyResult["hierarchy"]): unknown {
  const root = hierarchy.node;
  if (root === undefined) {
    return hierarchy.bounds === undefined
      ? null
      : { bounds: normalizeSettleValue(hierarchy.bounds) };
  }
  const nodes = Array.isArray(root) ? root : [root];
  return {
    ...(hierarchy.bounds === undefined ? {} : { bounds: normalizeSettleValue(hierarchy.bounds) }),
    node: nodes.map(normalizeSettleNode),
  };
}

// Compact stable hash of the hierarchy node tree, used only to detect quiet
// (settled) periods. Screen size / window metadata are excluded so cosmetic,
// non-hierarchy churn does not defeat the gate. A missing hierarchy hashes to a
// stable sentinel, so it counts as "quiet". Returns null when the tree cannot be
// hashed, which the settle gate treats as unstable (never settle on it).
export const hashHierarchyForSettle = (viewHierarchy?: ViewHierarchyResult): string | null => {
  try {
    const normalized = viewHierarchy ? normalizeHierarchyForSettle(viewHierarchy.hierarchy) : null;
    return NodeCryptoService.generateCacheKey(JSON.stringify(normalized));
  } catch (error) {
    // Non-serializable hierarchy is unexpected; a constant sentinel would compare
    // equal across consecutive failures and be mistaken for a quiet tree, so
    // return null and let settleReady restart the quiet window instead.
    logger.debug(`[observe] Failed to hash hierarchy for settle gate: ${error}`);
    return null;
  }
};

interface DisplayWaitTimeoutEvidence {
  knownValueObserved: boolean;
  hierarchyCaptured: boolean;
  lastObservedReason: string;
}

function displayWaitTimeoutReason(
  waitKind: "posture" | "activeDisplay",
  requested: string,
  duration: number,
  inventory: DisplayInventoryClassification,
  evidence: DisplayWaitTimeoutEvidence,
): string {
  let reason = evidence.lastObservedReason;
  if (!evidence.knownValueObserved) {
    if (inventory === "unavailable") {
      reason =
        waitKind === "posture"
          ? "display inventory was unavailable so posture support was never confirmed"
          : "display inventory was unavailable so the active display was never confirmed";
    } else if (!evidence.hierarchyCaptured) {
      reason =
        waitKind === "posture"
          ? "posture was never observable because no hierarchy was captured"
          : "the active display was never observable because no hierarchy was captured";
    }
  }
  return `Timed out after ${duration} ms waiting for ${waitKind} "${requested}"; ${reason}`;
}

function recordDisplayWaitEvidence(
  observation: ObserveResult,
  postureEvidence: DisplayWaitTimeoutEvidence,
  activeDisplayEvidence: DisplayWaitTimeoutEvidence,
): void {
  if (observation.display?.posture !== undefined) {
    postureEvidence.lastObservedReason = `last observed posture "${observation.display.posture}"`;
  }
  postureEvidence.knownValueObserved ||=
    observation.display !== undefined && observation.display.posture !== "unknown";
  postureEvidence.hierarchyCaptured ||= hasUsableHierarchy(observation.viewHierarchy);
  activeDisplayEvidence.lastObservedReason = observation.display
    ? `last observed active display "${observation.display.key}" (${observation.display.role})`
    : 'last observed active display "unknown"';
  activeDisplayEvidence.knownValueObserved ||=
    observation.display !== undefined &&
    !(observation.display.key === "0" && observation.display.role === "unknown");
  activeDisplayEvidence.hierarchyCaptured ||= hasUsableHierarchy(observation.viewHierarchy);
}

function scopedWaitTimeoutMetadata(evaluation: ObserveConditionEvaluation, waitMs: number) {
  return {
    ...containerFailureMetadata(!evaluation.matched, evaluation.containerFailure),
    ...(evaluation.diagnostic
      ? {
          candidates: evaluation.candidates,
          timeoutReason: `Timed out after ${waitMs} ms waiting for element; ${evaluation.diagnostic}`,
        }
      : {}),
  };
}

export const waitForObservation = async (
  observeScreen: ObserveScreen,
  waitFor: WaitForWithSettled,
  signal?: AbortSignal,
  skipBackStack: boolean = false,
  timer: Timer = defaultTimer,
  platform?: BootedDevice["platform"],
  screenshot?: ScreenshotMode,
  screenshotOptions?: ObserveScreenshotOptions,
  displayInventory: DisplayInventoryClassification = "unavailable",
  displayPanels: readonly Pick<DisplayPanel, "key" | "role">[] = [],
): Promise<WaitForObservationOutcome> => {
  const iosMultiPanel = hasIosWaitPanels(platform, displayPanels);
  const postureEvidence: DisplayWaitTimeoutEvidence = {
    lastObservedReason: 'last observed posture "unknown"',
    knownValueObserved: false,
    hierarchyCaptured: false,
  };
  const activeDisplayEvidence: DisplayWaitTimeoutEvidence = {
    lastObservedReason: 'last observed active display "unknown"',
    knownValueObserved: false,
    hierarchyCaptured: false,
  };
  const complete = createWaitCompletion({
    waitFor,
    displayInventory,
    postureEvidence,
    activeDisplayEvidence,
    screenshot,
    observeScreen,
    signal,
    screenshotOptions,
  });

  // Declarative `for` DSL (issue #4398) routes to the #4389 primitives; the
  // legacy element/textAny/activeWindow path below is unchanged (back-compat).
  if (isConditionDsl(waitFor)) {
    return complete(
      await runWaitForConditionDsl(observeScreen, waitFor, signal, timer, skipBackStack, platform),
    );
  }

  const startTime = timer.now();
  const timeoutMs = legacyWaitTimeout(waitFor);
  const settled = waitFor.settled;
  const finder = new ElementResolver();
  const queryOptions = waitObservationQuery(waitFor);

  // Back-stack collection may stay disabled during waitFor polling to preserve its
  // timeout budget. Screenshots always stay suppressed during polls; when opted
  // in, `complete` captures exactly one screenshot from the terminal state.
  const skipPollingOverhead = !serverConfig.isWaitForPollingOverheadEnabled();

  const observeOnce = createWaitObserver({
    observeScreen,
    queryOptions,
    timeoutMs,
    timer,
    startTime,
    signal,
    skipPollingOverhead,
    skipBackStack,
    postureEvidence,
    activeDisplayEvidence,
  });

  // Settle gate (issue #3490 §3): once the predicate matches, hold until the
  // hierarchy hash is unchanged for settled.quietPeriodMs. `matchedHash === null`
  // means "no stable candidate yet"; a changed hash restarts the quiet window.
  let matchedHash: string | null = null;
  let quietStart = startTime;
  const settleReady = (observation: ObserveResult): boolean => {
    if (!settled) {
      return true;
    }
    const hash = hashHierarchyForSettle(observation.viewHierarchy);
    // An unhashable tree (null) is never quiet: fall through to restart the
    // window so the gate cannot resolve early on an unverifiable snapshot.
    if (hash === null || matchedHash === null || hash !== matchedHash) {
      matchedHash = hash;
      quietStart = timer.now();
      return false;
    }
    return timer.now() - quietStart >= settled.quietPeriodMs;
  };

  const resetMatchedHash = () => {
    matchedHash = null;
  };

  throwIfAborted(signal);
  // Evaluate the current cache on the first poll, then use its device-clock
  // timestamp to request a strictly newer hierarchy on later polls.
  let observation = await observeOnce(0);
  throwIfAborted(signal);
  checkWaitDisplaySupport(waitFor, displayInventory, displayPanels);
  const baselineTimestamp = waitBaselineTimestamp(observation);
  // A posture-only stamp is read independently of hierarchy capture, including
  // while folding locks the device. UI predicates/settling still need a fresh tree.
  const needsHierarchyFreshness = needsWaitHierarchyFreshness(waitFor, settled);
  const minTimestamp = waitTimestampFloor(needsHierarchyFreshness, baselineTimestamp);
  let polls = 1;
  const modes = new Map<string, MatchMode>();
  let waitEvaluation = evaluateWaitForObservation(
    finder,
    waitFor,
    observation,
    platform,
    displayInventory,
    { modes, iosMultiPanel },
  );

  if (waitMatchReady(waitEvaluation, observation, settleReady, resetMatchedHash)) {
    const waitMs = timer.now() - startTime;
    return complete(matchedWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
  }
  if (timer.now() - startTime >= timeoutMs) {
    const waitMs = timer.now() - startTime;
    return complete(timedOutWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
  }

  while (timer.now() - startTime < timeoutMs) {
    await awaitWhileRequestIsLive(timer.sleep(WAIT_FOR_POLL_INTERVAL_MS), signal);
    throwIfAborted(signal);

    polls++;
    try {
      observation = await observeOnce(minTimestamp);
    } catch (error) {
      throwDeviceLostFromAbortSignal(signal);
      if (shouldRethrowWaitObservationError(error, waitFor, signal)) {
        logger.debug("[observe] Wait observation failed", error);
        throw error;
      }
      // A fold may lock/disconnect capture before posture is observable; retry within the deadline.
      logger.debug("[observe] Posture transition interrupted observation; retrying", error);
      waitEvaluation = { matched: false };
      matchedHash = null;
      continue;
    }
    throwIfAborted(signal);
    checkWaitDisplaySupport(waitFor, displayInventory, displayPanels);
    const observedTimestamp = hierarchyUpdatedAtToMillis(observation.viewHierarchy);
    // A timed-out delegate may return its old cache despite the requested
    // floor. It must not satisfy waitFor as post-invocation evidence.
    waitEvaluation = evaluateFreshWaitObservation({
      minTimestamp,
      observedTimestamp,
      finder,
      waitFor,
      observation,
      platform,
      displayInventory,
      modes,
      iosMultiPanel,
    });

    if (waitMatchReady(waitEvaluation, observation, settleReady, resetMatchedHash)) {
      const waitMs = timer.now() - startTime;
      return complete(matchedWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
    }
  }

  const waitMs = timer.now() - startTime;
  return complete(timedOutWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
};

function createSettledGate({
  settled,
  timer,
  startTime,
  timeoutMs,
  signal,
  pollingScreen,
  skipBackStack,
  platform,
}: {
  settled: SettledOptions | undefined;
  timer: Timer;
  startTime: number;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  pollingScreen: ObserveScreen;
  skipBackStack: boolean;
  platform: BootedDevice["platform"] | undefined;
}) {
  return async (
    outcome: WaitForObservationOutcome,
    matched: boolean,
    recheck: ConditionPredicate = () => ({ matched: true }),
  ): Promise<WaitForObservationOutcome> => {
    if (!settled || !matched) {
      return outcome;
    }
    let observation = outcome.observation;
    // The floor must be in the device clock domain, like the `updatedAt` it is
    // compared with (#9878, same class as #6430). The matched capture's own
    // device stamp is inclusive, so it admits that capture (as the host
    // `startTime` floor did with no skew) without rejecting every read of a
    // still screen on a device whose clock trails the host. No device stamp
    // (unavailable capture) means unfloored, as the #6430 loop does. iOS keeps
    // the host `startTime` floor: the runner stamps `updatedAt` with its own
    // `Date()`, which is the host clock for simulators but not clearly
    // comparable for a physical device, so that path is unchanged.
    const minTimestamp = settledGateFloor(observation, platform, startTime);
    let matchedHash = hashHierarchyForSettle(observation.viewHierarchy);
    let quietStart = timer.now();
    let polls = outcome.polls;
    let matchedElement = outcome.matchedElement;
    let awaitedElement = outcome.awaitedElement;
    let conditionMatched = true;
    let lastEvaluation: ObserveConditionEvaluation = { matched: true };
    while (timer.now() - startTime < timeoutMs) {
      if (matchedHash !== null && timer.now() - quietStart >= settled.quietPeriodMs) {
        return {
          ...outcome,
          observation,
          matchedElement,
          awaitedElement,
          matched: true,
          settled: true,
          timedOut: false,
          awaitTimeout: false,
          waitMs: timer.now() - startTime,
          awaitDuration: timer.now() - startTime,
          polls,
        };
      }
      await awaitWhileRequestIsLive(timer.sleep(WAIT_FOR_POLL_INTERVAL_MS), signal);
      throwIfAborted(signal);
      observation = await pollingScreen.execute({
        timeoutMs: Math.max(0, timeoutMs - (timer.now() - startTime)),
        skipWaitForFresh: false,
        minTimestamp,
        signal,
        skipBackStack: skipBackStack || undefined,
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        skipStaleWindowRecovery: true,
      });
      throwIfAborted(signal);
      polls++;
      const unavailableReason = waitCaptureUnavailableReason(observation);
      const evaluation: ObserveConditionEvaluation = unavailableReason
        ? { matched: false, diagnostic: unavailableReason }
        : recheck(observation);
      lastEvaluation = evaluation;
      if (!evaluation.matched) {
        conditionMatched = false;
        matchedHash = null;
        quietStart = timer.now();
        matchedElement = undefined;
        awaitedElement = undefined;
        continue;
      }
      conditionMatched = true;
      matchedElement = evaluation.matchedElement;
      awaitedElement = evaluation.matchedElement;
      const hash = hashHierarchyForSettle(observation.viewHierarchy);
      if (hash === null || hash !== matchedHash) {
        matchedHash = hash;
        quietStart = timer.now();
      }
    }
    const unavailableReason = waitCaptureUnavailableReason(observation);
    return {
      ...outcome,
      observation,
      matchedElement,
      awaitedElement,
      settled: false,
      timedOut: true,
      matched: conditionMatched,
      ...containerFailureMetadata(!conditionMatched, lastEvaluation.containerFailure),
      ...scopedWaitTimeoutMetadata(
        { matched: conditionMatched, diagnostic: unavailableReason },
        timer.now() - startTime,
      ),
      awaitTimeout: true,
      waitMs: timer.now() - startTime,
      awaitDuration: timer.now() - startTime,
      polls,
    };
  };
}

function createWaitCompletion({
  waitFor,
  displayInventory,
  postureEvidence,
  activeDisplayEvidence,
  screenshot,
  observeScreen,
  signal,
  screenshotOptions,
}: {
  waitFor: WaitForWithSettled;
  displayInventory: DisplayInventoryClassification;
  postureEvidence: DisplayWaitTimeoutEvidence;
  activeDisplayEvidence: DisplayWaitTimeoutEvidence;
  screenshot: ScreenshotMode | undefined;
  observeScreen: ObserveScreen;
  signal: AbortSignal | undefined;
  screenshotOptions: ObserveScreenshotOptions | undefined;
}) {
  return async (outcome: WaitForObservationOutcome): Promise<WaitForObservationOutcome> => {
    if (outcome.timedOut && waitFor.posture !== undefined) {
      outcome.timeoutReason = displayWaitTimeoutReason(
        "posture",
        waitFor.posture,
        outcome.awaitDuration,
        displayInventory,
        postureEvidence,
      );
    } else if (outcome.timedOut && waitFor.activeDisplay !== undefined) {
      outcome.timeoutReason = displayWaitTimeoutReason(
        "activeDisplay",
        waitFor.activeDisplay,
        outcome.awaitDuration,
        displayInventory,
        activeDisplayEvidence,
      );
    }
    const mode = resolveScreenshotMode(screenshot);
    if (
      mode === "settled" ||
      (mode === "async" &&
        (!shouldSkipObserveWaitForScreenshot() || serverConfig.isAccessibilityAuditEnabled()))
    ) {
      await observeScreen.captureScreenshot?.(
        createGlobalPerformanceTracker(),
        signal,
        outcome.observation,
        screenshot,
        screenshotOptions,
      );
    } else {
      await observeScreen.runAccessibilityAudit?.(
        outcome.observation,
        createGlobalPerformanceTracker(),
      );
    }
    return outcome;
  };
}

function createWaitObserver({
  observeScreen,
  queryOptions,
  timeoutMs,
  timer,
  startTime,
  signal,
  skipPollingOverhead,
  skipBackStack,
  postureEvidence,
  activeDisplayEvidence,
}: {
  observeScreen: ObserveScreen;
  queryOptions: { text: string | undefined; elementId: string | undefined };
  timeoutMs: number;
  timer: Timer;
  startTime: number;
  signal: AbortSignal | undefined;
  skipPollingOverhead: boolean;
  skipBackStack: boolean;
  postureEvidence: DisplayWaitTimeoutEvidence;
  activeDisplayEvidence: DisplayWaitTimeoutEvidence;
}) {
  return async (minTimestamp: number) => {
    const observation = await observeScreen.execute({
      queryOptions,
      timeoutMs: Math.max(0, timeoutMs - (timer.now() - startTime)),
      perf: createGlobalPerformanceTracker(),
      skipWaitForFresh: false,
      minTimestamp,
      signal,
      skipBackStack: skipPollingOverhead || skipBackStack,
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      skipStaleWindowRecovery: true,
    });
    recordDisplayWaitEvidence(observation, postureEvidence, activeDisplayEvidence);
    return observation;
  };
}

interface WaitOutcomeState {
  observation: ObserveResult;
  waitEvaluation: ReturnType<typeof evaluateWaitForObservation>;
  waitMs: number;
  settled: SettledOptions | undefined;
  polls: number;
}

function matchedWaitOutcome({
  observation,
  waitEvaluation,
  waitMs,
  settled,
  polls,
}: WaitOutcomeState): WaitForObservationOutcome {
  return {
    observation,
    awaitedElement: waitEvaluation.awaitedElement,
    awaitDuration: waitMs,
    awaitTimeout: false,
    matched: true,
    settled: settled ? true : undefined,
    timedOut: false,
    polls,
    waitMs,
    matchedElement: waitEvaluation.awaitedElement,
  };
}

function timedOutWaitOutcome({
  observation,
  waitEvaluation,
  waitMs,
  settled,
  polls,
}: WaitOutcomeState): WaitForObservationOutcome {
  return {
    observation,
    awaitedElement: waitEvaluation.matched ? waitEvaluation.awaitedElement : undefined,
    awaitDuration: waitMs,
    awaitTimeout: true,
    matched: waitEvaluation.matched,
    settled: settled ? false : undefined,
    timedOut: true,
    polls,
    waitMs,
    matchedElement: waitEvaluation.matched ? waitEvaluation.awaitedElement : undefined,
    ...scopedWaitTimeoutMetadata(waitEvaluation, waitMs),
  };
}

function needsWaitHierarchyFreshness(
  waitFor: WaitForWithSettled,
  settled: SettledOptions | undefined,
): boolean {
  return (
    waitFor.posture === undefined ||
    hasElementPredicate(waitFor) ||
    waitFor.absent !== undefined ||
    waitFor.activeWindow !== undefined ||
    settled !== undefined
  );
}

function shouldRethrowWaitObservationError(
  error: unknown,
  waitFor: WaitForWithSettled,
  signal: AbortSignal | undefined,
): boolean | undefined {
  return (
    isDeviceLostError(error) ||
    waitFor.posture === undefined ||
    signal?.aborted ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function checkWaitDisplaySupport(
  waitFor: WaitForWithSettled,
  displayInventory: DisplayInventoryClassification,
  displayPanels: readonly Pick<DisplayPanel, "key" | "role">[],
): void {
  if (
    waitFor.activeDisplay !== undefined &&
    !canDisplayExist(displayInventory, displayPanels, waitFor.activeDisplay)
  ) {
    throw new ActionableError(
      "Cannot wait for activeDisplay: this device has no display inventory. Select a device that reports display panels and posture and retry.",
    );
  }
  if (waitFor.posture !== undefined && displayInventory === "single") {
    throw new ActionableError(
      "Cannot wait for posture: this device has no display inventory. Select a device that reports display panels and posture and retry.",
    );
  }
}

function hasIosWaitPanels(
  platform: BootedDevice["platform"] | undefined,
  displayPanels: readonly Pick<DisplayPanel, "key" | "role">[],
): boolean {
  return platform === "ios" && displayPanels.length > 1;
}

function legacyWaitTimeout(waitFor: WaitForWithSettled): number {
  return waitFor.timeout ?? waitFor.timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
}

function waitObservationQuery(waitFor: WaitForWithSettled) {
  return {
    text: waitFor.text ?? waitFor.textAny?.[0] ?? waitFor.contentDescription,
    elementId: waitFor.elementId,
  };
}

function waitTimestampFloor(
  needsHierarchyFreshness: boolean,
  baselineTimestamp: number | undefined,
): number {
  return needsHierarchyFreshness && baselineTimestamp !== undefined && baselineTimestamp > 0
    ? baselineTimestamp + 1
    : 0;
}

/** Settled-gate floor: iOS keeps the host `startTime`; otherwise the matched capture's own device stamp, else unfloored. */
function settledGateFloor(
  observation: ObserveResult,
  platform: BootedDevice["platform"] | undefined,
  startTime: number,
): number {
  return platform === "ios" ? startTime : (waitBaselineTimestamp(observation) ?? 0);
}

function waitBaselineTimestamp(observation: ObserveResult): number | undefined {
  return waitCaptureUnavailableReason(observation)
    ? undefined
    : hierarchyUpdatedAtToMillis(observation.viewHierarchy);
}

function evaluateFreshWaitObservation({
  minTimestamp,
  observedTimestamp,
  finder,
  waitFor,
  observation,
  platform,
  displayInventory,
  modes,
  iosMultiPanel,
}: {
  minTimestamp: number;
  observedTimestamp: number | undefined;
  finder: ElementResolver;
  waitFor: WaitForWithSettled;
  observation: ObserveResult;
  platform: BootedDevice["platform"] | undefined;
  displayInventory: DisplayInventoryClassification;
  modes: Map<string, MatchMode>;
  iosMultiPanel: boolean;
}): ReturnType<typeof evaluateWaitForObservation> {
  return minTimestamp > 0 && (observedTimestamp === undefined || observedTimestamp < minTimestamp)
    ? {
        matched: false,
        awaitedElement: undefined,
        diagnostic: waitCaptureUnavailableReason(observation),
      }
    : evaluateWaitForObservation(finder, waitFor, observation, platform, displayInventory, {
        modes,
        iosMultiPanel,
      });
}

function waitMatchReady(
  waitEvaluation: ReturnType<typeof evaluateWaitForObservation>,
  observation: ObserveResult,
  settleReady: (observation: ObserveResult) => boolean,
  resetMatchedHash: () => void,
): boolean {
  if (waitEvaluation.matched) {
    return settleReady(observation);
  }
  resetMatchedHash();
  return false;
}
