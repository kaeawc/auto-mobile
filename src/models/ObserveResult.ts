import { Element } from "./Element";
import { DeviceLockState } from "./DeviceLockState";
import { ScreenSize } from "./ScreenSize";
import { SystemInsets } from "./SystemInsets";
import { ActiveWindowInfo } from "./ActiveWindowInfo";
import { ViewHierarchyResult } from "./ViewHierarchyResult";
import { TimingData } from "../utils/PerformanceTracker";
import { GfxMetrics } from "./GfxMetrics";
import { PerfSnapshot } from "./PerfSnapshot";
import { BackStackInfo } from "./BackStack";
import { PerformanceAuditResult } from "../features/performance/PerformanceAudit";
import { AccessibilityAuditResult } from "./AccessibilityAudit";
import { RecompositionSummary } from "./Recomposition";
import { DisplayedTimeMetric } from "./DisplayedTimeMetric";
import { SelectedElement } from "../utils/interfaces/NavigationGraph";
import { RawViewHierarchyResult } from "./RawViewHierarchyResult";
import type { MediaView } from "../features/observe/IdentifyMediaViews";
import type { ObserveError } from "../features/observe/ObserveError";
import type { LayoutWarnings, ObservationInsets } from "./ObservationInsets";
import type { ObserveScopeMetadata } from "./ObserveScope";
import type { SemanticLink } from "./SemanticLink";

export interface PredictionTarget {
  text?: string;
  elementId?: string;
  contentDesc?: string;
  container?: {
    text?: string;
    elementId?: string;
    contentDesc?: string;
  };
  lookFor?: {
    text?: string;
    elementId?: string;
    contentDesc?: string;
  };
}

export interface PredictedAction {
  action: string;
  target: PredictionTarget;
  predictedScreen: string;
  predictedElements?: string[];
  confidence: number;
}

export interface InteractablePrediction {
  elementId?: string;
  elementText?: string;
  elementContentDesc?: string;
  predictedOutcome?: {
    screenName: string;
    basedOn: "navigation_graph";
  };
}

export interface Predictions {
  likelyActions: PredictedAction[];
  interactableElements: InteractablePrediction[];
}

/**
 * A single actionable affordance a skeleton entry exposes (issue #4388).
 * Derived from view-hierarchy attributes: `clickable` → `tap`,
 * `long-clickable` → `long-press`, `scrollable` → `scroll`, `checkable` →
 * `toggle` (carries `checked`), and a focusable editable field → `input`.
 */
export type Affordance = "tap" | "long-press" | "input" | "scroll" | "toggle";

/**
 * One row of the Interactable Skeleton Projection (issue #4388): a flat,
 * actionable-only summary of a screen. `elementId` / `label` map directly onto
 * the `tapOn` selector union (`elementId` / `text`), so an agent reads the
 * skeleton and issues `tapOn({ elementId })` with no new selector semantics
 * and no key rename (issue #6153). Bounds are always the compact
 * `[left, top, right, bottom]` tuple.
 */
export interface SkeletonElement {
  /** `resource-id ?? view-id` (the stable content-hash id from #3228). */
  elementId?: string;
  /**
   * `text ?? content-desc`, else the hoisted primary text of descendants (issue
   * #5869). A clickable container whose own node carries no text/content-desc
   * (the standard Android `clickable container > TextView` preference-row layout)
   * takes the top-most descendant text as its label, so the row is no longer
   * `label: null`.
   */
  label?: string;
  /**
   * Secondary descendant text hoisted onto a clickable row (issue #5869): the
   * remaining descendant text after `label`, joined with `", "`. Present only
   * when a clickable container encloses text beyond its primary label — e.g. a
   * preference row's summary line or an alarm's day-of-week schedule — so compact
   * state text is not lost. Omitted when there is no secondary text.
   */
  sublabel?: string;
  /** Compose test tag, when supplied by the app; usable as the stable owner key for `subtext`. */
  testTag?: string;
  /** Embedded accessibility links, omitted unless this element exposes one. */
  semanticLinks?: SemanticLink[];
  /** Compact bounds tuple `[left, top, right, bottom]`. */
  bounds: [number, number, number, number];
  /** Actionable affordances, in canonical order tap, long-press, input, scroll, toggle. */
  affordances: Affordance[];
  /** Present only for a `toggle` affordance: the current checked state. */
  checked?: boolean;
  /**
   * Disambiguator (issue #6221 item 2), present only when `elementId` repeats
   * elsewhere in this same skeleton. Pass it verbatim as `tapOn({ selector,
   * index })` to hit this exact entry instead of the `selectionStrategy:
   * "first"` default: `index` is 0-based rank in the same "Nth on-screen match
   * in hierarchy order" that `tapOn.index` itself resolves against (see
   * `SkeletonProjection.assignDuplicateIndexes` for how the two are kept in
   * sync). Unique-id entries never carry this field.
   */
  index?: number;
}

export type ScreenIdentitySource = "heuristic" | "sdk";
export type ScreenIdentityConfidence = "high" | "medium" | "low";

export interface ScreenIdentity {
  platform: "ios" | "android";
  source: ScreenIdentitySource;
  confidence: ScreenIdentityConfidence;
  key: string;
  components: {
    bundleId?: string;
    /** SDK-reported destination / route, when the app integrates AutoMobileSDK. */
    navigationRoute?: string;
    navigationTitle?: string;
    selectedTab?: string;
    /** SDK-reported modal or sheet presentation route, when available. */
    presentation?: string;
    modalClass?: string;
    modalTitle?: string;
    focusedElementId?: string;
    keyboardVisible?: boolean;
  };
}

/**
 * Represents the result of observing the device state
 */
export interface ObserveResult {
  /**
   * Timestamp when the screen state was captured on the device (milliseconds since epoch)
   * This comes from the CtrlProxy on Android or equivalent on iOS
   * Falls back to server timestamp if device timestamp is unavailable
   */
  updatedAt: string | number;

  /** Screen dimensions */
  screenSize: ScreenSize;

  /** System UI insets */
  systemInsets: SystemInsets;

  /** Typed inset metadata. Present even when a platform cannot measure it. */
  insets?: ObservationInsets;

  /**
   * Potential edge-to-edge / safe-area layout problems flagged by the
   * report-only auditor. Always the single `layoutWarnings` key: an object whose
   * `scope` records whether the `warnings` list is `full`, `truncated` (capped,
   * with a `total`), or `scoped` (narrowed to the returned hierarchy).
   */
  layoutWarnings?: LayoutWarnings;

  /** Screen rotation (0: portrait, 1: landscape 90°, 2: reverse portrait 180°, 3: reverse landscape 270°) */
  rotation?: number;

  /** View hierarchy data */
  viewHierarchy?: ViewHierarchyResult;

  /**
   * Interactable Skeleton Projection (issue #4388): a flat, actionable-only
   * summary emitted in place of `viewHierarchy` / `elements`. The `"skeleton"`
   * projection is now the default; it is absent only when a caller opts out with
   * a per-call `project: "full"` arg (or `raw: true`).
   *
   * Actionable-only (issue #6221 item 1): every entry has `affordances.length
   * >= 1`. A row with zero affordances is never emitted here — it goes into
   * the sibling {@link context} array instead, so `skeleton` means what its
   * name says and a client's action surface is not diluted by rows it can
   * never `tapOn`/`inputText`/etc.
   */
  skeleton?: SkeletonElement[];

  /**
   * Non-actionable rows from the same projection that produces `skeleton`
   * (issue #6221 item 1): every entry has `affordances.length === 0`. Covers
   * things like a screen title, a standalone notification line, or the
   * `com.android.systemui` status bar — the latter collapsed to a SINGLE
   * summarized entry rather than one row per icon, since it otherwise
   * reappears verbatim on every observation of every screen. Present
   * alongside `skeleton` whenever `project: "skeleton"` is in effect (the
   * default) and at least one non-actionable row survived the keep rule;
   * absent under `project: "full"` / `raw: true`.
   */
  context?: SkeletonElement[];

  /** Active window information */
  activeWindow?: ActiveWindowInfo;

  /** Best-effort stable identity for the currently visible screen. */
  screenIdentity?: ScreenIdentity;

  /**
   * Categorized elements from the view hierarchy
   */
  elements?: {
    clickable: Element[];
    scrollable: Element[];
    text: Element[];
    media: MediaView[];
  };

  /**
   * Selected elements detected for this observation (accessibility or visual fallback)
   */
  selectedElements?: SelectedElement[];

  /**
   * The single currently focused UI element from the view hierarchy
   * Contains the element that has focus state set to true
   */
  focusedElement?: Element;

  /**
   * The element with accessibility focus (TalkBack/VoiceOver cursor)
   * Contains the element that currently has the screen reader cursor
   */
  accessibilityFocusedElement?: Element;

  /** Whether a system intent chooser dialog was detected */
  intentChooserDetected?: boolean;
  /** Whether a notification permission dialog was detected */
  notificationPermissionDetected?: boolean;

  /**
   * Device wakefulness state (Android only)
   * - "Awake": Screen is on and device is interactive
   * - "Asleep": Screen is off
   * - "Dozing": Device is in ambient display / always-on mode
   */
  wakefulness?: "Awake" | "Asleep" | "Dozing";

  /**
   * Structured device-lock signal (Android only). Present when the lock state
   * could be read; absent when it could not. Lets an agent detect it is looking
   * at the keyguard rather than the app, and decide whether to dismiss a swipe
   * lock itself or stop and ask the user for a PIN (issue #4235).
   */
  deviceLock?: DeviceLockState;

  /**
   * Android user ID for the foreground app (Android only)
   * - 0: Primary user (personal profile)
   * - 10+: Work profile or other managed profiles
   * This indicates which user profile the current foreground app is running in
   */
  userId?: number;

  /**
   * Back stack information (Android only)
   * Includes activity stack depth, task information, and navigation state
   */
  backStack?: BackStackInfo;

  /** Error message if observation failed partially or completely.
   * Back-compat derived field: equivalent to `errors.map(e => e.message).join("; ")`.
   * Prefer reading from `errors` for structured per-phase failure info. */
  error?: string;

  /**
   * Structured per-phase errors accumulated during observation.
   * The `error` field above is derived from this list (semicolon-joined messages)
   * for back-compat with existing string-based consumers.
   */
  errors?: ObserveError[];

  /**
   * Element detected while waiting for a match via observe waitFor
   */
  awaitedElement?: Element;

  /** Time spent waiting for the element in milliseconds */
  awaitDuration?: number;

  /** True if the wait timed out without finding the element */
  awaitTimeout?: boolean;

  /** Whether a declarative waitFor condition matched. */
  matched?: boolean;

  /** Whether a whole-screen declarative waitFor stable condition settled. */
  settled?: boolean;

  /** True if a declarative waitFor condition or stability wait timed out. */
  timedOut?: boolean;

  /** Number of observations made by the waitFor poll. */
  polls?: number;

  /** Elapsed time spent in the waitFor poll, in milliseconds. */
  waitMs?: number;

  /** Element that satisfied a declarative waitFor condition, when applicable. */
  matchedElement?: Element;

  /** Last-seen near matches when a declarative waitFor condition times out. */
  candidates?: Element[];

  /** Performance timing data (only present when --debug-perf is enabled) */
  perfTiming?: TimingData;

  /** Indicates if performance timing data was truncated due to size limits */
  perfTimingTruncated?: boolean;

  /** Graphics frame metrics from gfxinfo (only present when --debug-perf is enabled) */
  gfxMetrics?: GfxMetrics;

  /** Android "Displayed" metrics captured during launch (when ui-perf-mode is enabled). */
  displayedTimeMetrics?: DisplayedTimeMetric[];

  /**
   * Windowed performance snapshot (fps percentiles, jank, touch latency, CPU,
   * memory) rolled up from the live performance stream. Present only when the
   * `AUTOMOBILE_OBSERVE_PERF_SNAPSHOT` opt-in is enabled. Independent of
   * `--debug-perf`, and intentionally kept outside the debug-perf wire strip so
   * it survives to the client — see `ObserveResultOutput.ts`.
   */
  perfSnapshot?: PerfSnapshot;

  /**
   * Performance audit results (only present when --debug-perf/--ui-perf-debug is enabled)
   * Contains validation against thresholds and detailed diagnostics
   */
  performanceAudit?: PerformanceAuditResult;

  /**
   * Accessibility audit results (when accessibility audit mode is enabled)
   * Contains WCAG 2.1 violation detection and compliance checking
   */
  accessibilityAudit?: AccessibilityAuditResult;

  /**
   * Freshness metadata for the observation
   * Helps agents understand if the data reflects a recent interaction
   */
  freshness?: {
    /** Minimum timestamp requested for freshness (milliseconds since epoch, device time if available) */
    requestedAfter?: number;
    /** Actual timestamp of the observation (milliseconds since epoch) */
    actualTimestamp?: number;
    /** Wall-clock age of `actualTimestamp` at report time. Always present when a capture timestamp exists. */
    ageMs?: number;
    /**
     * Whether the hierarchy delegate obtained a tree it verified against the
     * device on THIS call, as opposed to serving a host-side cache entry
     * unverified. Absent when the platform's delegate does not report it.
     */
    verified?: boolean;
    /**
     * Whether the observation is believed to match the screen.
     *
     * When no `requestedAfter` was supplied this is a MEASUREMENT (capture age +
     * whether the delegate verified against the device), not the constant `true`
     * it used to be. Freshness that cannot be established reads `false`, and
     * `warning` names the cause.
     */
    isFresh: boolean;
    /** How stale the observation was in milliseconds, if stale */
    staleDurationMs?: number;
    /** Optional warning when freshness could not be guaranteed */
    warning?: string;
  };

  /**
   * Compose recomposition summary (populated when SDK is integrated in the target app)
   */
  recompositionSummary?: RecompositionSummary;

  /**
   * Predictive UI state derived from navigation graph (when enabled)
   */
  predictions?: Predictions;

  /**
   * Accessibility state for the device
   * Indicates if accessibility services (TalkBack/VoiceOver) are enabled
   */
  accessibilityState?: {
    /** Whether any accessibility service is enabled */
    enabled: boolean;
    /** The detected accessibility service type */
    service: "talkback" | "voiceover" | "unknown";
  };

  /**
   * Raw view hierarchy data (only present when observe is called with raw: true)
   * Contains the unprocessed hierarchy from the accessibility service (Android) or
   * the pre-offscreen-filter hierarchy (iOS)
   */
  rawViewHierarchy?: RawViewHierarchyResult;

  /**
   * Progressive-disclosure scoping metadata (issue #4344), present only when a
   * per-call `scope.focus` / `scope.overview` / `scope.region` request scoped
   * this observe payload, or withheld a requested dimension.
   * Records which transforms ran and the node-count reduction so the experiment
   * is measurable on the wire. See
   * `features/observe/output/ObserveScopeExperiments.ts`.
   */
  observeScope?: ObserveScopeMetadata;
}

/**
 * The payload the `observe` tool packs into its MCP `structuredContent` envelope.
 * Equals {@link ObserveResult}, which already carries the `awaitedElement` /
 * `awaitDuration` / `awaitTimeout` wait fields the handler spreads.
 *
 * The alias is kept (rather than using `ObserveResult` directly) to name the
 * envelope payload at the tool boundary: it annotates the
 * `StructuredToolResponse<ObserveToolPayload>` the handler returns and types the
 * toolRegistry lastHierarchy read site so an envelope-top-level
 * `response.viewHierarchy` read is a **compile error** (issue #2932;
 * envelope-vs-`structuredContent` dead-read class, issue #2907).
 *
 * There is deliberately no `screenshot` field: production `observe` never
 * emitted one and the session `lastScreenshot` cache slot it fed had no reader,
 * so the dead chain was removed (issue #3221). If observe ever attaches a
 * screenshot payload, add the field back together with a real consumer.
 */
export type ObserveToolPayload = ObserveResult;
