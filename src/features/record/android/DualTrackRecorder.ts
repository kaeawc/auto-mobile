import { logger } from "../../../utils/logger";
import type { BootedDevice, PlanStep, Element } from "../../../models";
import type {
  GestureEmitter,
  GestureEvent,
  A11ySource,
  DisplayChangeSource,
  ReceivedInteraction,
  TouchTrackFailure,
} from "./types";
import { GESTURE_THRESHOLDS } from "./types";
import { AndroidCtrlProxyClient } from "../../observe/android";
import { defaultAdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { discoverTouchNode } from "./TouchNodeDiscovery";
import { queryDensity, queryDisplaySize } from "./AxisRanges";
import { ROTATION_UNKNOWN_CAVEAT, ScreenGeometryTimeline } from "./ScreenGeometryTimeline";
import {
  createAdbGeometryProbe,
  DisplayGeometryTracker,
  type DisplayGeometryProbe,
} from "./DisplayGeometryTracker";
import { errorMessage } from "../../../utils/describeUnknownError";
import { LONG_PRESS_MIN_MS, LONG_PRESS_MAX_MS } from "../../action/tapAtGesture";
import { GetEventReader } from "./GetEventReader";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";

interface OrderedStep {
  resolved: boolean;
  step?: PlanStep;
  stepIndex?: number;
}

interface PendingGesture extends OrderedStep {
  gesture: GestureEvent;
  arrivedAt: number;
  timeout?: NodeJS.Timeout;
}

type BufferedInteraction = ReceivedInteraction & { receivedAt: number };

type SendKeysTextCommand =
  | { action: "type"; text: string; operation: "replace" }
  | { action: "clear" };

/**
 * Map an inputText event's complete field value to a replayable sendKeys
 * command. `sendKeys` rejects an empty `type` text (min(1)), so an emptied field
 * (null or "") is recorded as `clear`.
 */
function buildTextCommand(text: string | null): SendKeysTextCommand {
  return text ? { action: "type", text, operation: "replace" } : { action: "clear" };
}

/**
 * How long to wait for a CtrlProxy event to pair with a getevent gesture.
 * Issue #9142 measured 222–361 ms from touch-up to host receipt, including the
 * service's 100 ms notificationTimeout and the WebSocket hop. 750 ms gives
 * roughly twice the observed maximum while bounding unrelated-event pairing.
 * CtrlProxy notificationTimeout is a separate service-side follow-up, unchanged here.
 * Unmatched gestures fall back to coordinates/direction when this deadline expires.
 */
export const MERGE_WINDOW_MS = 750;

/**
 * One budget for everything stop does against the device: waiting for in-flight
 * geometry refreshes plus the stop-time rotation cross-check. It is far below the
 * manager's 10 s stop deadline (`STOP_RECORDING_TIMEOUT_MS`) so that a stalled adb
 * read can never cost the recording: on expiry the captured steps are returned with
 * `GEOMETRY_UNCONFIRMED_WARNING`. Each read inside also has its own shorter timeout
 * (`GEOMETRY_READ_TIMEOUT_MS`).
 */
export const GEOMETRY_FINALIZE_BUDGET_MS = 3_000;

export const GEOMETRY_UNCONFIRMED_WARNING =
  "rotation/size could not be confirmed at stop; tapAt and swipeOn steps recorded after a display change may be at the wrong coordinates or direction";

/**
 * Merges GestureEvents from getevent with InteractionEvents from the CtrlProxy
 * to build AutoMobile plan steps with full gesture-type and element-identity information.
 *
 * Usage:
 *   const recorder = new DualTrackRecorder(device)
 *   await recorder.start()
 *   // ... user interacts ...
 *   const { steps } = await recorder.stop()
 */
export class DualTrackRecorder {
  private steps: PlanStep[] = [];
  private orderedSteps: OrderedStep[] = [];
  private latestEntry: OrderedStep | null = null;
  private pendingGestures: PendingGesture[] = [];
  private bufferedInteractions: BufferedInteraction[] = [];
  private lastInputText: { elementKey: string; entry: OrderedStep } | null = null;
  private activeEmitter: GestureEmitter | null = null;
  private unsubscribeA11y: (() => void) | null = null;
  /** Reference to the real AndroidCtrlProxyClient when not in test mode */
  private activeA11y: AndroidCtrlProxyClient | null = null;
  private stopped = false;
  private firstTouchTrackFailure?: TouchTrackFailure;
  /** Rotation/size timeline for the touch track; built at start in real mode (#10174). */
  private geometry?: DisplayGeometryTracker;
  private unsubscribeDisplay: (() => void) | null = null;
  /** Touch time span of each step whose coordinates or direction depend on the geometry. */
  private readonly geometrySpans = new Map<PlanStep, { downAt: number; upAt: number }>();
  private finalized?: Promise<string[]>;

  get touchTrackFailure(): TouchTrackFailure | undefined {
    return this.firstTouchTrackFailure;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  /** The steps captured so far; complete once `stop()` has been called, labels aside. */
  get capturedSteps(): readonly PlanStep[] {
    return this.steps;
  }

  constructor(
    private readonly device: BootedDevice,
    /** Optional override for testing — defaults to a real GetEventReader */
    private readonly gestureEmitter?: GestureEmitter,
    /** Optional override for testing — defaults to AndroidCtrlProxyClient */
    private readonly a11ySource?: A11ySource,
    /** Optional override for testing — defaults to the system timer */
    private readonly timer: Timer = defaultTimer,
    /** Optional override for testing — defaults to the timeline built from the device at start */
    geometry?: DisplayGeometryTracker,
    /** Optional override for testing — defaults to the CtrlProxy client's display changes */
    private readonly displaySource?: DisplayChangeSource,
  ) {
    this.geometry = geometry;
  }

  async start(): Promise<void> {
    // In real mode (no test override), obtain the AndroidCtrlProxyClient directly
    // so we can send start/stop recording notifications to the Kotlin service.
    let a11yClient: AndroidCtrlProxyClient | undefined;
    if (!this.a11ySource) {
      a11yClient = AndroidCtrlProxyClient.getInstance(this.device);
    }

    const a11y: A11ySource = this.a11ySource ?? a11yClient!;

    const connected = await a11y.ensureConnected();
    if (!connected) {
      throw new Error("[DualTrackRecorder] Unable to connect to the accessibility service.");
    }
    // Notify Kotlin service that recording is starting (enables interaction event emission)
    if (a11yClient) {
      a11yClient.notifyRecordingStarted();
      this.activeA11y = a11yClient;
    }

    const emitter = this.gestureEmitter ?? (await this.createGetEventReader());
    this.activeEmitter = emitter;
    emitter.start(
      (e) => this.handleGestureEvent(e),
      (error) => {
        if (this.stopped || this.firstTouchTrackFailure) {
          return;
        }
        this.firstTouchTrackFailure = { error, failedAt: this.timer.now() };
        logger.warn(`[DualTrackRecorder] Touch track (getevent) failed: ${error.message}`);
      },
    );

    this.unsubscribeA11y = a11y.onInteraction((e) => this.handleInteractionEvent(e));
    this.subscribeDisplayChanges(a11yClient);

    logger.debug("[DualTrackRecorder] Started dual-track recording");
  }

  async stop(): Promise<{
    steps: PlanStep[];
    stepCount: number;
    touchTrackFailure?: TouchTrackFailure;
    /** Rotation/size problems that may have mis-recorded tapAt/swipeOn steps (#10174). */
    geometryWarnings?: string[];
  }> {
    if (this.stopped) {
      const geometryWarnings = (await this.finalized) ?? [];
      return this.stopResult(geometryWarnings);
    }
    this.stopped = true;

    // Notify Kotlin service that recording is stopping before unsubscribing
    this.activeA11y?.notifyRecordingStopped();
    this.activeA11y = null;

    this.unsubscribeA11y?.();
    this.unsubscribeA11y = null;
    this.activeEmitter?.stop();
    this.activeEmitter = null;

    // Flush pending gestures that haven't been matched yet
    for (const pending of this.pendingGestures) {
      if (!pending.resolved) {
        this.resolveGesture(pending);
      }
    }
    this.pendingGestures = [];

    // Display pushes stay subscribed until finalisation is done: the device debounces
    // them (100 ms), so a rotation just before stop is pushed after it.
    this.finalized = this.finalizeGeometry().finally(() => {
      this.unsubscribeDisplay?.();
      this.unsubscribeDisplay = null;
    });
    const geometryWarnings = await this.finalized;

    logger.debug(`[DualTrackRecorder] Stopped with ${this.steps.length} steps`);

    return this.stopResult(geometryWarnings);
  }

  private stopResult(geometryWarnings: string[]) {
    return {
      steps: this.steps,
      stepCount: this.steps.length,
      ...(this.touchTrackFailure ? { touchTrackFailure: this.touchTrackFailure } : {}),
      ...(geometryWarnings.length > 0 ? { geometryWarnings } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Private: display geometry (rotation / size) during the recording
  // -------------------------------------------------------------------------

  private subscribeDisplayChanges(a11yClient?: AndroidCtrlProxyClient): void {
    const source = this.displaySource ?? (a11yClient ? clientDisplaySource(a11yClient) : undefined);
    const geometry = this.geometry;
    if (source && geometry) {
      this.unsubscribeDisplay = source.onDisplayChange((change) =>
        geometry.handleTransition(change),
      );
    }
  }

  /**
   * Attach a warning label to every tapAt/swipeOn step whose touch overlapped a
   * display change or ran under a geometry that could not be read, and return the
   * distinct warnings for the recording result. Runs at stop so late pushes count.
   * Strictly best-effort: it never rejects and is bounded by
   * `GEOMETRY_FINALIZE_BUDGET_MS`, because the steps are already captured.
   */
  private async finalizeGeometry(): Promise<string[]> {
    const geometry = this.geometry;
    if (!geometry) {
      return [];
    }
    const { mismatch, unconfirmed } = await this.confirmGeometryAtStop(geometry);
    const warnings = new Set<string>();
    for (const [step, { downAt, upAt }] of this.geometrySpans) {
      const stepWarnings = geometry.timeline.warningsFor(downAt, upAt);
      // A rotation the device never pushed can have happened at any time after the last
      // known-good geometry, so every touch from there on may be mapped with a stale one.
      if (mismatch && upAt >= geometry.timeline.lastKnownGoodAt) {
        stepWarnings.push(mismatch);
      }
      if (stepWarnings.length > 0) {
        step.label = `Warning: ${stepWarnings.join("; ")}`;
        for (const warning of stepWarnings) {
          warnings.add(warning);
        }
      }
    }
    if (mismatch) {
      warnings.add(mismatch);
    }
    if (unconfirmed) {
      warnings.add(GEOMETRY_UNCONFIRMED_WARNING);
    }
    return [...warnings];
  }

  private async confirmGeometryAtStop(
    geometry: DisplayGeometryTracker,
  ): Promise<{ mismatch?: string; unconfirmed: boolean }> {
    try {
      const mismatch = await raceWithDeadline(
        async () => {
          await geometry.settle();
          return geometry.verifyAtStop();
        },
        {
          timer: this.timer,
          timeoutMs: GEOMETRY_FINALIZE_BUDGET_MS,
          label: "Confirming display geometry at stop",
        },
      );
      return { mismatch, unconfirmed: false };
    } catch (error) {
      logger.warn(
        `[DualTrackRecorder] Could not confirm display geometry at stop: ${errorMessage(error)}`,
        error,
      );
      return { unconfirmed: true };
    }
  }

  // -------------------------------------------------------------------------
  // Private: event handlers
  // -------------------------------------------------------------------------

  private handleGestureEvent(gesture: GestureEvent): void {
    if (this.stopped) {
      return;
    }

    if (gesture.type === "pressButton") {
      this.enqueueStep({ resolved: true, step: buildPressButtonStep(gesture) });
      return;
    }

    if (gesture.type === "pinch") {
      this.enqueueStep({ resolved: true, step: buildPinchStep(gesture) ?? undefined });
      return;
    }

    this.pendingGestures = this.pendingGestures.filter(
      (pending) =>
        !pending.resolved ||
        (pending.step !== undefined && pending.stepIndex === undefined) ||
        // Retain unknown contacts as ambiguity witnesses across serial timeouts.
        (hasUnknownAxes(pending.gesture) &&
          this.timer.now() - pending.arrivedAt <= MERGE_WINDOW_MS * 2) ||
        (pending.gesture.type === "tap" &&
          gesture.arrivedAt - pending.gesture.arrivedAt <= GESTURE_THRESHOLDS.DOUBLE_TAP_MS),
    );

    if (this.upgradeDoubleTap(gesture)) {
      return;
    }

    // tap / doubleTap / longPress / swipe → hold for merge window
    const pending: PendingGesture = {
      gesture,
      arrivedAt: this.timer.now(),
      resolved: false,
    };
    this.pendingGestures.push(pending);
    this.enqueueStep(pending);

    pending.timeout = this.timer.setTimeout(() => this.resolveGesture(pending), MERGE_WINDOW_MS);
  }

  private upgradeDoubleTap(gesture: GestureEvent): boolean {
    if (gesture.type !== "doubleTap" || hasUnknownAxes(gesture)) {
      return false;
    }
    const priorTap = [...this.pendingGestures].reverse().find((pending) => {
      const prior = pending.gesture;
      if (
        prior.type !== "tap" ||
        hasUnknownAxes(prior) ||
        prior.screenX === undefined ||
        prior.screenY === undefined
      ) {
        return false;
      }
      const elapsed = gesture.arrivedAt - prior.arrivedAt;
      if (gesture.firstTapArrivedAt !== undefined) {
        return (
          prior.arrivedAt === gesture.firstTapArrivedAt &&
          elapsed >= 0 &&
          elapsed <= GESTURE_THRESHOLDS.DOUBLE_TAP_MS
        );
      }
      // Direct emitter events lack the classifier's correlation time.
      const dx = (gesture.screenX ?? Infinity) - prior.screenX;
      const dy = (gesture.screenY ?? Infinity) - prior.screenY;
      return (
        elapsed >= 0 &&
        elapsed <= GESTURE_THRESHOLDS.DOUBLE_TAP_MS &&
        Math.hypot(dx, dy) <= GESTURE_THRESHOLDS.DOUBLE_TAP_SLOP_DP
      );
    });
    const step = priorTap?.step;
    if (step && ["tapOn", "tapAt"].includes(step.tool) && step.params.action === "tap") {
      step.params.action = "doubleTap";
      return true;
    }
    if (priorTap && !priorTap.resolved) {
      // Keep the first tap's position, but allow the pair's delayed click a
      // fresh merge window, as when recording an uncorrelated double tap.
      if (priorTap.timeout) {
        this.timer.clearTimeout(priorTap.timeout);
      }
      priorTap.gesture = gesture;
      priorTap.arrivedAt = this.timer.now();
      priorTap.timeout = this.timer.setTimeout(
        () => this.resolveGesture(priorTap),
        MERGE_WINDOW_MS,
      );
      return true;
    }
    return false;
  }

  private enqueueStep(entry: OrderedStep): void {
    this.latestEntry = entry;
    this.orderedSteps.push(entry);
    this.flushResolvedSteps();
  }

  private flushResolvedSteps(): void {
    // Emit only a contiguous resolved prefix, so accessibility receipt order
    // cannot reorder touches. Skipped gestures still release later steps.
    while (this.orderedSteps[0]?.resolved) {
      const entry = this.orderedSteps.shift()!;
      if (entry.step) {
        entry.stepIndex = this.steps.length;
        this.steps.push(entry.step);
      }
    }
  }

  private handleInteractionEvent(event: ReceivedInteraction): void {
    if (this.stopped) {
      return;
    }

    if (event.type === "windowChange") {
      // Screen navigation metadata — not a plan step
      return;
    }

    if (event.type === "inputText") {
      this.handleInputText(event);
      return;
    }

    // tap / longPress / swipe — try to match a pending gesture
    const received = { ...event, receivedAt: this.timer.now() };
    const matched = this.pendingGestures.find(
      (p) => !p.resolved && !hasUnknownAxes(p.gesture) && this.isPairCandidate(p, received),
    );

    if (matched) {
      // find() pairs by receipt order and target: the oldest unresolved match wins.
      this.resolveGesture(matched, event);
    } else if (
      !this.pendingGestures.some(
        (p) =>
          p.resolved &&
          !hasUnknownAxes(p.gesture) &&
          isCompatibleType(p.gesture.type, event.type) &&
          gestureHitsElement(p.gesture, event.element),
      )
    ) {
      // A late event for an already resolved touch must not seed the next touch.
      // Unknown contacts wait for the full window so later competitors count.
      this.bufferedInteractions.push(received);
    }
  }

  private resolveGesture(pending: PendingGesture, interaction?: ReceivedInteraction): void {
    if (pending.resolved) {
      return;
    }
    pending.resolved = true;
    if (pending.timeout) {
      this.timer.clearTimeout(pending.timeout);
    }

    const event = this.selectInteraction(pending, interaction);
    const step = buildMergedStep(pending.gesture, event);
    pending.step = step ?? undefined;
    this.trackGeometrySpan(pending.gesture, step);
    this.flushResolvedSteps();
    if (!step && hasUnknownAxes(pending.gesture)) {
      warnUnknownGesture(pending.gesture);
      return;
    }
    if (!event || !buildSelector(event.element) || !step) {
      const gesture = pending.gesture;
      const [x, y] =
        gesture.type === "swipe"
          ? [gesture.startX, gesture.startY]
          : [gesture.screenX, gesture.screenY];
      const outcome = step
        ? `recorded ${step.tool} fallback`
        : "no swipe direction or missing coordinates — step skipped";
      logger.warn(
        `[DualTrackRecorder] No element match for ${gesture.type} at (${x}, ${y}) — ${outcome}`,
      );
    }
  }

  private trackGeometrySpan(gesture: GestureEvent, step: PlanStep | null): void {
    if (step && gesture.downAt !== undefined && ["tapAt", "swipeOn"].includes(step.tool)) {
      this.geometrySpans.set(step, { downAt: gesture.downAt, upAt: gesture.arrivedAt });
    }
  }

  private selectInteraction(
    pending: PendingGesture,
    interaction?: ReceivedInteraction,
  ): ReceivedInteraction | undefined {
    // Prune stale buffered interactions using host receipt time, not device timestamp,
    // to avoid false drops/retains caused by host-device clock skew.
    const now = this.timer.now();
    const MAX_BUFFER_AGE_MS = MERGE_WINDOW_MS * 2;
    this.bufferedInteractions = this.bufferedInteractions.filter(
      (e) => now - e.receivedAt <= MAX_BUFFER_AGE_MS,
    );

    const candidates = this.bufferedInteractions.map((event, index) => ({ event, index }));
    if (interaction) {
      candidates.push({ event: { ...interaction, receivedAt: now }, index: -1 });
    }
    const matching = candidates.filter(({ event }) => this.isPairCandidate(pending, event));
    if (
      hasUnknownAxes(pending.gesture) &&
      !this.isUnambiguousUnknownPair(
        pending,
        matching.map(({ event }) => event),
      )
    ) {
      return undefined;
    }
    const selected = matching.sort((a, b) => {
      // Genuine clicks beat stateChange. Within that priority, prefer events
      // following the touch, then proximity. Stable ties retain buffer order
      // (the incoming event is appended after buffered candidates).
      const aDelta = a.event.receivedAt - pending.arrivedAt;
      const bDelta = b.event.receivedAt - pending.arrivedAt;
      return (
        Number(b.event.type === "tap") - Number(a.event.type === "tap") ||
        Number(aDelta < 0) - Number(bDelta < 0) ||
        Math.abs(aDelta) - Math.abs(bDelta)
      );
    })[0];
    if (selected && selected.index >= 0) {
      this.bufferedInteractions.splice(selected.index, 1);
    }
    return selected?.event;
  }

  private isPairCandidate(pending: PendingGesture, event: BufferedInteraction): boolean {
    const gesture = pending.gesture;
    if (Math.abs(event.receivedAt - pending.arrivedAt) > MERGE_WINDOW_MS) {
      return false;
    }
    if (hasUnknownAxes(gesture)) {
      // Low displacement on a reported axis cannot rule out scrolling on an
      // unreported axis. Only a directional scroll can supply that evidence.
      const directionalScroll =
        (gesture.type === "tap" || gesture.type === "longPress") &&
        event.type === "scroll" &&
        resolveSwipeDirection(event.scrollDeltaX, event.scrollDeltaY) !== null;
      return Boolean(
        (directionalScroll || isCompatibleType(gesture.type, event.type, false)) &&
        event.element?.bounds &&
        buildSelector(event.element),
      );
    }
    return isCompatibleType(gesture.type, event.type) && gestureHitsElement(gesture, event.element);
  }

  private isUnambiguousUnknownPair(
    pending: PendingGesture,
    candidates: BufferedInteraction[],
  ): boolean {
    if (candidates.length !== 1) {
      return false;
    }
    const event = candidates[0];
    // Known points claim their targets first. Resolved unknown contacts remain
    // witnesses so flushing an earlier ambiguous contact cannot free its event.
    return !this.pendingGestures.some(
      (other) =>
        other !== pending &&
        (hasUnknownAxes(other.gesture) || !other.resolved) &&
        this.isPairCandidate(other, event),
    );
  }

  private handleInputText(event: ReceivedInteraction): void {
    const elementKey = buildElementKey(event);
    if (event.text === undefined) {
      return;
    }

    // Coalesce consecutive inputText events on the same element only when the
    // previous replacement is still the most recent entry (including pending
    // gestures). Stable references also allow coalescing a held text step.
    // Accessibility events carry the field's complete value, so recording an
    // insert would duplicate text when the plan is replayed.
    const command = buildTextCommand(event.text);
    if (this.coalesceInputText(elementKey, command)) {
      return;
    }

    const entry = { resolved: true, step: this.buildRecordedTextStep(command) };
    this.enqueueStep(entry);
    if (elementKey) {
      this.lastInputText = { elementKey, entry };
    }
  }

  private buildRecordedTextStep(command: SendKeysTextCommand): PlanStep {
    return {
      tool: "sendKeys",
      params: { commands: [command] },
    };
  }

  private coalesceInputText(elementKey: string | null, command: SendKeysTextCommand): boolean {
    const previous = this.lastInputText;
    if (
      !previous ||
      !elementKey ||
      previous.elementKey !== elementKey ||
      previous.entry !== this.latestEntry
    ) {
      return false;
    }

    return this.updateCoalescedTextStep(previous.entry.step, command);
  }

  // The coalesced step always holds the field's latest complete value: a later
  // non-empty value replaces an earlier clear, and an emptied field replaces
  // earlier typed text with a `clear` (never with an empty `type`).
  private updateCoalescedTextStep(
    existing: PlanStep | undefined,
    command: SendKeysTextCommand,
  ): boolean {
    const previous = existing?.params.commands?.[0];
    if (
      existing?.tool !== "sendKeys" ||
      (previous?.action !== "type" && previous?.action !== "clear")
    ) {
      return false;
    }

    existing.params.commands = [command];
    return true;
  }

  // -------------------------------------------------------------------------
  // Private: factory
  // -------------------------------------------------------------------------

  private async createGetEventReader(): Promise<GestureEmitter> {
    const adb = defaultAdbClientFactory.create(this.device);
    const node = await discoverTouchNode(adb);
    if (!node) {
      throw new Error("[DualTrackRecorder] No multitouch input device found on this device");
    }
    const density = await queryDensity(adb);
    const probe = createAdbGeometryProbe(adb);
    const display = await queryDisplaySize(adb);
    const { rotation, caveats } = await readStartRotation(probe);
    const timeline = new ScreenGeometryTimeline(
      { xMin: node.axisXMin, xMax: node.axisXMax, yMin: node.axisYMin, yMax: node.axisYMax },
      { rotation, display },
      this.timer.now(),
      caveats,
    );
    this.geometry = new DisplayGeometryTracker(timeline, probe, this.timer);

    const reader = new GetEventReader({
      adb,
      touchNode: node,
      // Each touch is mapped with the geometry in force at its DOWN, not at recording start.
      scaler: timeline,
      density,
      timer: this.timer,
    });
    const rotated = rotation % 2 !== 0;
    const geometry = {
      platform: "android" as const,
      deviceWidth: rotated ? display.height : display.width,
      deviceHeight: rotated ? display.width : display.height,
      orientation: rotation,
    };
    return {
      start: (onGesture, onError) =>
        reader.start((event) => onGesture({ ...event, geometry }), onError),
      stop: () => reader.stop(),
    };
  }
}

/**
 * The rotation at recording start. An unreadable rotation is not assumed to be
 * portrait silently: the timeline carries a caveat that labels affected steps.
 */
async function readStartRotation(
  probe: DisplayGeometryProbe,
): Promise<{ rotation: number; caveats: string[] }> {
  try {
    const rotation = await probe.readRotation();
    if (rotation !== null) {
      return { rotation, caveats: [] };
    }
    logger.warn("[DualTrackRecorder] WindowManager reported no display rotation at start");
  } catch (error) {
    logger.warn(
      `[DualTrackRecorder] Failed to read display rotation at start: ${errorMessage(error)}`,
      error,
    );
  }
  return { rotation: 0, caveats: [ROTATION_UNKNOWN_CAVEAT] };
}

/**
 * Adapt the CtrlProxy client's single-slot display observer to a subscription,
 * chaining any observer already installed and restoring it on unsubscribe.
 */
function clientDisplaySource(client: AndroidCtrlProxyClient): DisplayChangeSource {
  return {
    onDisplayChange(listener) {
      const previous = client.onDisplayTransition;
      const handler: NonNullable<AndroidCtrlProxyClient["onDisplayTransition"]> = (event) => {
        previous?.(event);
        listener(event);
      };
      client.onDisplayTransition = handler;
      return () => {
        if (client.onDisplayTransition === handler) {
          client.onDisplayTransition = previous;
        }
      };
    },
  };
}

// -------------------------------------------------------------------------
// Pure helper functions
// -------------------------------------------------------------------------

function isCompatibleType(
  gestureType: string,
  eventType: string,
  allowStateChange = true,
): boolean {
  return (
    // Compose Playground clicks emitted stateChange/scroll, never tap (#9142).
    // Only tap/doubleTap may use this signal, and callers still require the hit-test.
    ((gestureType === "tap" || gestureType === "doubleTap") &&
      (eventType === "tap" || (allowStateChange && eventType === "stateChange"))) ||
    (gestureType === "longPress" && eventType === "longPress") ||
    (gestureType === "swipe" && (eventType === "scroll" || eventType === "swipe"))
  );
}

function gestureHitsElement(gesture: GestureEvent, element?: Partial<Element>): boolean {
  const bounds = element?.bounds;
  if (!bounds) {
    return false;
  }
  // Unknown raw axes cannot prove a spatial hit (rotation may swap them).
  if (hasUnknownAxes(gesture)) {
    return false;
  }
  // Swipes use startX/startY; taps/longPress/doubleTap use screenX/screenY
  const x = gesture.screenX ?? gesture.startX;
  const y = gesture.screenY ?? gesture.startY;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return false;
  }
  return pointHitsBounds(x, y, bounds);
}

function pointHitsBounds(x: number, y: number, bounds: Element["bounds"]): boolean {
  const PAD = 20;
  return (
    x >= bounds.left - PAD &&
    x <= bounds.right + PAD &&
    y >= bounds.top - PAD &&
    y <= bounds.bottom + PAD
  );
}

function buildSelector(
  element?: Partial<Element>,
): { elementId: string } | { text: string } | null {
  if (!element) {
    return null;
  }
  const resourceId = element["resource-id"];
  if (resourceId) {
    return { elementId: resourceId };
  }
  const text = element.text ?? element["content-desc"];
  if (text) {
    return { text };
  }
  return null;
}

function buildElementKey(event: ReceivedInteraction): string | null {
  const el = event.element;
  if (!el) {
    return null;
  }
  const resourceId = el["resource-id"] ?? "";
  const contentDesc = el["content-desc"] ?? "";
  const className = el["class"] ?? "";
  if (!resourceId && !contentDesc && !className) {
    return null;
  }
  return `${resourceId}|${contentDesc}|${className}`;
}

export function resolveSwipeDirection(
  scrollDeltaX?: number,
  scrollDeltaY?: number,
): "up" | "down" | "left" | "right" | null {
  const dx = scrollDeltaX ?? 0;
  const dy = scrollDeltaY ?? 0;
  if (dx === 0 && dy === 0) {
    return null;
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx > 0 ? "left" : "right";
  }
  return dy > 0 ? "up" : "down";
}

function buildMergedStep(
  gesture: GestureEvent,
  event: ReceivedInteraction = { type: "", timestamp: 0 },
): PlanStep | null {
  const selector = buildSelector(event.element);

  switch (gesture.type) {
    case "tap":
    case "doubleTap":
    case "longPress": {
      if (gesture.type !== "doubleTap" && hasUnknownAxes(gesture) && event.type === "scroll") {
        return buildSwipeStep(gesture, event);
      }
      if (selector) {
        return { tool: "tapOn", params: { action: gesture.type, ...selector } };
      }
      return buildCoordinateTapStep(gesture);
    }

    case "swipe":
      return buildSwipeStep(gesture, event);

    default:
      return null;
  }
}

function buildSwipeStep(gesture: GestureEvent, event: ReceivedInteraction): PlanStep | null {
  const selector = buildSelector(event.element);
  const direction = hasUnknownAxes(gesture)
    ? selector && resolveSwipeDirection(event.scrollDeltaX, event.scrollDeltaY)
    : (gesture.direction ?? resolveSwipeDirection(event.scrollDeltaX, event.scrollDeltaY));
  if (!direction) {
    return null;
  }
  const params: Record<string, unknown> = { direction };
  if (selector) {
    params.container =
      "elementId" in selector ? { elementId: selector.elementId } : { text: selector.text };
  }
  if (!hasUnknownAxes(gesture) && gesture.speed === "fast") {
    params.speed = "fast";
  }
  return { tool: "swipeOn", params };
}

function hasUnknownAxes(gesture: GestureEvent): boolean {
  return Boolean(gesture.unknownAxes?.length);
}

function buildCoordinateTapStep(gesture: GestureEvent): PlanStep | null {
  if (hasUnknownAxes(gesture) || gesture.screenX === undefined || gesture.screenY === undefined) {
    return null;
  }
  // The scaler already supplies native Android display pixels (rotation applied).
  // tapAt defaults to absolute native coordinates, so no coordinateSpace is needed.
  const params: Record<string, unknown> = {
    x: gesture.screenX,
    y: gesture.screenY,
    action: gesture.type,
  };
  if (gesture.type === "longPress" && gesture.durationMs !== undefined) {
    // Classification starts at 400 ms; tapAt's existing contract starts at 500 ms.
    params.durationMs = Math.min(
      LONG_PRESS_MAX_MS,
      Math.max(LONG_PRESS_MIN_MS, gesture.durationMs),
    );
  }
  return {
    tool: "tapAt",
    params,
    ...(gesture.geometry
      ? { geometry: { ...gesture.geometry, x: gesture.screenX, y: gesture.screenY } }
      : {}),
  };
}

function warnUnknownGesture(gesture: GestureEvent): void {
  logger.warn(
    `[DualTrackRecorder] ${gesture.type} has unknown axes: ${gesture.unknownAxes?.join(", ")} — no resolved element gesture; step skipped`,
  );
}

function buildPressButtonStep(gesture: GestureEvent): PlanStep {
  return { tool: "pressButton", params: { button: gesture.button } };
}

function buildPinchStep(gesture: GestureEvent): PlanStep | null {
  if (hasUnknownAxes(gesture)) {
    warnUnknownGesture(gesture);
    return null;
  }
  return {
    tool: "pinchOn",
    params: {
      direction: gesture.pinchDirection,
      scale: gesture.scale,
    },
  };
}
