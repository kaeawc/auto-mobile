import { logger } from "../../../utils/logger";
import type { BootedDevice, PlanStep, Element } from "../../../models";
import type { GestureEmitter, GestureEvent, A11ySource } from "./types";
import { GESTURE_THRESHOLDS } from "./types";
import { AndroidCtrlProxyClient } from "../../observe/android";
import { defaultAdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { discoverTouchNode } from "./TouchNodeDiscovery";
import { buildAxisRanges, buildScaler, queryDensity, queryRotation } from "./AxisRanges";
import { LONG_PRESS_MIN_MS, LONG_PRESS_MAX_MS } from "../../action/tapAtGesture";
import { GetEventReader } from "./GetEventReader";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";

/** An InteractionEvent from the CtrlProxy (subset of fields we use) */
interface ReceivedInteraction {
  type: string;
  timestamp: number;
  packageName?: string;
  screenClassName?: string;
  element?: Partial<Element>;
  text?: string;
  scrollDeltaX?: number;
  scrollDeltaY?: number;
}

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
  private bufferedInteractions: (ReceivedInteraction & { receivedAt: number })[] = [];
  private lastInputText: { elementKey: string; entry: OrderedStep } | null = null;
  private activeEmitter: GestureEmitter | null = null;
  private unsubscribeA11y: (() => void) | null = null;
  /** Reference to the real AndroidCtrlProxyClient when not in test mode */
  private activeA11y: AndroidCtrlProxyClient | null = null;
  private stopped = false;

  get stepCount(): number {
    return this.steps.length;
  }

  constructor(
    private readonly device: BootedDevice,
    /** Optional override for testing — defaults to a real GetEventReader */
    private readonly gestureEmitter?: GestureEmitter,
    /** Optional override for testing — defaults to AndroidCtrlProxyClient */
    private readonly a11ySource?: A11ySource,
    /** Optional override for testing — defaults to the system timer */
    private readonly timer: Timer = defaultTimer,
  ) {}

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
      (e) => logger.warn(`[DualTrackRecorder] GetEventReader error: ${e.message}`),
    );

    this.unsubscribeA11y = a11y.onInteraction((e) =>
      this.handleInteractionEvent(e as unknown as ReceivedInteraction),
    );

    logger.debug("[DualTrackRecorder] Started dual-track recording");
  }

  async stop(): Promise<{ steps: PlanStep[]; stepCount: number }> {
    if (this.stopped) {
      return { steps: this.steps, stepCount: this.steps.length };
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

    logger.debug(`[DualTrackRecorder] Stopped with ${this.steps.length} steps`);

    return { steps: this.steps, stepCount: this.steps.length };
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
      this.enqueueStep({ resolved: true, step: buildPinchStep(gesture) });
      return;
    }

    this.pendingGestures = this.pendingGestures.filter(
      (pending) =>
        !pending.resolved ||
        (pending.step !== undefined && pending.stepIndex === undefined) ||
        (pending.gesture.type === "tap" &&
          gesture.arrivedAt - pending.gesture.arrivedAt <= GESTURE_THRESHOLDS.DOUBLE_TAP_MS),
    );

    if (gesture.type === "doubleTap") {
      const priorTap = [...this.pendingGestures].reverse().find((pending) => {
        const prior = pending.gesture;
        if (prior.type !== "tap" || prior.screenX === undefined || prior.screenY === undefined) {
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
        return;
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
        return;
      }
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
    const matched = this.pendingGestures.find(
      (p) =>
        !p.resolved &&
        isCompatibleType(p.gesture.type, event.type) &&
        gestureHitsElement(p.gesture, event.element),
    );

    if (matched) {
      // find() pairs by receipt order and target: the oldest unresolved match wins.
      this.resolveGesture(matched, event);
    } else if (
      !this.pendingGestures.some(
        (p) =>
          p.resolved &&
          isCompatibleType(p.gesture.type, event.type) &&
          gestureHitsElement(p.gesture, event.element),
      )
    ) {
      // A late event for an already resolved touch must not seed the next touch.
      this.bufferedInteractions.push({ ...event, receivedAt: this.timer.now() });
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
    this.flushResolvedSteps();
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
    const selected = candidates
      .filter(
        ({ event }) =>
          Math.abs(event.receivedAt - pending.arrivedAt) <= MERGE_WINDOW_MS &&
          isCompatibleType(pending.gesture.type, event.type) &&
          gestureHitsElement(pending.gesture, event.element),
      )
      .sort((a, b) => {
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
    if (this.coalesceInputText(elementKey, event.text)) {
      return;
    }

    const entry = { resolved: true, step: this.buildRecordedTextStep(event.text) };
    this.enqueueStep(entry);
    if (elementKey) {
      this.lastInputText = { elementKey, entry };
    }
  }

  private buildRecordedTextStep(text: string): PlanStep {
    return {
      tool: "sendKeys",
      params: {
        commands: [{ action: "type", text, operation: "replace" }],
      },
    };
  }

  private coalesceInputText(elementKey: string | null, text: string): boolean {
    const previous = this.lastInputText;
    if (
      !previous ||
      !elementKey ||
      previous.elementKey !== elementKey ||
      previous.entry !== this.latestEntry
    ) {
      return false;
    }

    return this.updateCoalescedTextStep(previous.entry.step, text);
  }

  private updateCoalescedTextStep(existing: PlanStep | undefined, text: string): boolean {
    const command = existing?.params.commands?.[0];
    if (existing?.tool !== "sendKeys" || command?.action !== "type") {
      return false;
    }

    command.text = text;
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
    const rotation = await queryRotation(adb);
    const ranges = await buildAxisRanges(adb, node, rotation);
    const scaler = buildScaler(ranges);

    return new GetEventReader({
      adb,
      touchNode: node,
      scaler,
      density,
    });
  }
}

// -------------------------------------------------------------------------
// Pure helper functions
// -------------------------------------------------------------------------

function isCompatibleType(gestureType: string, eventType: string): boolean {
  return (
    // Compose Playground clicks emitted stateChange/scroll, never tap (#9142).
    // Only tap/doubleTap may use this signal, and callers still require the hit-test.
    ((gestureType === "tap" || gestureType === "doubleTap") &&
      (eventType === "tap" || eventType === "stateChange")) ||
    (gestureType === "longPress" && eventType === "longPress") ||
    (gestureType === "swipe" && (eventType === "scroll" || eventType === "swipe"))
  );
}

function gestureHitsElement(gesture: GestureEvent, element?: Partial<Element>): boolean {
  const bounds = element?.bounds;
  if (!bounds) {
    return false;
  }
  // Swipes use startX/startY; taps/longPress/doubleTap use screenX/screenY
  const x = gesture.screenX ?? gesture.startX;
  const y = gesture.screenY ?? gesture.startY;
  if (x === null || x === undefined || y === null || y === undefined) {
    return false;
  }
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
      if (selector) {
        return { tool: "tapOn", params: { action: gesture.type, ...selector } };
      }
      return buildCoordinateTapStep(gesture);
    }

    case "swipe": {
      const direction =
        gesture.direction ?? resolveSwipeDirection(event.scrollDeltaX, event.scrollDeltaY);
      if (!direction) {
        return null;
      }
      const params: Record<string, unknown> = { direction };
      if (selector) {
        params.container =
          "elementId" in selector ? { elementId: selector.elementId } : { text: selector.text };
      }
      if (gesture.speed === "fast") {
        params.speed = "fast";
      }
      return { tool: "swipeOn", params };
    }

    default:
      return null;
  }
}

function buildCoordinateTapStep(gesture: GestureEvent): PlanStep | null {
  if (gesture.screenX === undefined || gesture.screenY === undefined) {
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
  return { tool: "tapAt", params };
}

function buildPressButtonStep(gesture: GestureEvent): PlanStep {
  return { tool: "pressButton", params: { button: gesture.button } };
}

function buildPinchStep(gesture: GestureEvent): PlanStep {
  return {
    tool: "pinchOn",
    params: {
      direction: gesture.pinchDirection,
      scale: gesture.scale,
    },
  };
}
