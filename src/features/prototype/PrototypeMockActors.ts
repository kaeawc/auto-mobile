/**
 * Scripted mock actors (#14211): timed and route-triggered writes to a mock backend's collections
 * and frames to its rooms, so a demo has "the other side" (someone is typing, a reply arrives, an
 * order moves to "out for delivery") without the agent patching `/data`. Every delay waits on the injected `Timer`, so a fake clock replays a
 * timeline exactly. A run's steps execute in order; each step's `afterMs` is relative to the step
 * before it, and a step with no delay applies immediately.
 *
 * Actors keep a virtual clock: it follows the timer, and {@link PrototypeMockActors.advance}
 * (`prototype simulate advanceTimeMs`) moves it ahead, applying every step that falls due in that
 * window in due order. A step scheduled by another step counts from that step's due time, so the
 * same timeline results whether time passes on the timer or through `advance`.
 */
import { errorMessage } from "../../models/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { MAX_PROTOTYPE_CHANNEL_FRAME_BYTES } from "./prototypeChannelLimits";
import { bindMockValue, matchMockPath, type MockBindingContext } from "./prototypeMockBinding";
import type { MockActor, MockActorStep } from "./prototypeMockSchema";
import type { PrototypeRequestJson } from "./prototypeRequestProtocol";

export type MockActorTimer = Pick<Timer, "setTimeout" | "clearTimeout" | "now" | "monotonicNow">;

interface PendingStep {
  /** Virtual time the step falls due. */
  dueAt: number;
  callback: () => void;
  counted: boolean;
  handle?: NodeJS.Timeout;
}

/** A collection write, answered the way the equivalent HTTP request would be. */
export interface MockActorWrite {
  method: "POST" | "PATCH" | "DELETE";
  collection: string;
  id?: string;
  body?: PrototypeRequestJson;
}

/** What a step does to the backend. */
export interface MockActorEffects {
  /** Applies a write and returns its HTTP status. */
  write(write: MockActorWrite): number;
  /** Sends `frame` to every member of the room path `room`. */
  publish(room: string, frame: PrototypeRequestJson): void;
}

type MockActorEffect =
  | { kind: "write"; write: MockActorWrite }
  | { kind: "publish"; room: string; frame: PrototypeRequestJson };

/**
 * Scheduled steps across all runs of a backend; a step past this is dropped and logged. The next
 * tick of an `every` actor is not counted (at most one per actor), so a full queue drops runs
 * without stopping the cadence.
 */
export const MAX_MOCK_ACTOR_PENDING = 256;

const NO_CONTEXT: MockBindingContext = { params: {}, query: {}, body: undefined };

export class PrototypeMockActors {
  private readonly pending = new Set<PendingStep>();
  private disposed = false;
  /** Virtual time minus timer time: the sum of every `advance`. */
  private offsetMs = 0;
  /** The due time of the step running now; later steps of its run count from it. */
  private firingAt: number | undefined;
  private applied = 0;

  constructor(
    private readonly actors: readonly MockActor[],
    private readonly timer: MockActorTimer,
    private readonly effects: MockActorEffects,
  ) {}

  /** Starts every `every` actor; its run k begins at `afterMs + k * every`. */
  start(): void {
    for (const actor of this.actors) {
      if (actor.every !== undefined) {
        this.tick(actor, 1, (actor.afterMs ?? 0) + actor.every);
      }
    }
  }

  /** Starts a run of each `on` actor whose route matches a request that succeeded. */
  onRequest(
    method: string,
    path: string,
    status: number,
    context: Omit<MockBindingContext, "params">,
  ): void {
    if (status >= 400) {
      return;
    }
    for (const actor of this.actors) {
      const [routeMethod, routePath] = actor.on?.route.split(" ") ?? [];
      const params =
        routeMethod === method && routePath !== undefined
          ? matchMockPath(routePath, path)
          : undefined;
      if (params !== undefined) {
        this.run(actor.do, 0, actor.afterMs ?? 0, { ...context, params });
      }
    }
  }

  /**
   * Moves the virtual clock ahead by `ms`, applying every step due by then in due order (ties in
   * the order they were scheduled), and returns how many steps were applied.
   */
  advance(ms: number): number {
    if (this.disposed || ms <= 0) {
      return 0;
    }
    const before = this.applied;
    this.offsetMs += ms;
    const target = this.now();
    for (let next = this.nextDue(target); next !== undefined; next = this.nextDue(target)) {
      this.fire(next);
    }
    // What is left fell due later; its timer handles still count from before the jump.
    for (const entry of this.pending) {
      this.disarm(entry);
      entry.handle = this.arm(entry);
    }
    return this.applied - before;
  }

  /** Cancels every scheduled step; nothing writes after this returns. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending) {
      this.disarm(entry);
    }
    this.pending.clear();
    this.steps = 0;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private tick(actor: MockActor, runNumber: number, delay: number): void {
    this.schedule(
      delay,
      () => {
        if (runNumber < actor.maxRuns!) {
          this.tick(actor, runNumber + 1, actor.every!);
        }
        this.run(actor.do, 0, 0, NO_CONTEXT);
      },
      false,
    );
  }

  private run(
    steps: readonly MockActorStep[],
    index: number,
    leadMs: number,
    context: MockBindingContext,
  ): void {
    const step = steps[index];
    if (step === undefined || this.disposed) {
      return;
    }
    const delay = leadMs + (step.afterMs ?? 0);
    const go = (): void => {
      this.applyStep(step, context);
      this.run(steps, index + 1, 0, context);
    };
    if (delay === 0) {
      go();
    } else {
      this.schedule(delay, go);
    }
  }

  private steps = 0;

  private schedule(delay: number, callback: () => void, counted = true): void {
    if (this.disposed) {
      return;
    }
    if (counted && this.steps >= MAX_MOCK_ACTOR_PENDING) {
      logger.warn(
        `[PrototypeMock] actor step dropped: ${MAX_MOCK_ACTOR_PENDING} steps already scheduled.`,
      );
      return;
    }
    const dueAt = (this.firingAt ?? this.now()) + delay;
    const entry: PendingStep = { dueAt, callback, counted };
    entry.handle = this.arm(entry);
    this.pending.add(entry);
    if (counted) {
      this.steps++;
    }
  }

  /** Elapsed time, so a wall-clock correction (NTP, a manual change) cannot stall a timeline. */
  private now(): number {
    return (this.timer.monotonicNow?.() ?? this.timer.now()) + this.offsetMs;
  }

  private arm(entry: PendingStep): NodeJS.Timeout {
    return this.timer.setTimeout(() => this.fire(entry), Math.max(0, entry.dueAt - this.now()));
  }

  private disarm(entry: PendingStep): void {
    if (entry.handle !== undefined) {
      this.timer.clearTimeout(entry.handle);
    }
  }

  /** The earliest step due by `target`; the first scheduled among equals. */
  private nextDue(target: number): PendingStep | undefined {
    let next: PendingStep | undefined;
    for (const entry of this.pending) {
      if (entry.dueAt <= target && (next === undefined || entry.dueAt < next.dueAt)) {
        next = entry;
      }
    }
    return this.disposed ? undefined : next;
  }

  private fire(entry: PendingStep): void {
    if (!this.pending.delete(entry)) {
      return;
    }
    this.disarm(entry);
    if (entry.counted) {
      this.steps--;
    }
    if (this.disposed) {
      return;
    }
    const outer = this.firingAt;
    this.firingAt = entry.dueAt;
    try {
      entry.callback();
    } finally {
      this.firingAt = outer;
    }
  }

  private applyStep(step: MockActorStep, context: MockBindingContext): void {
    const effect = toEffect(step, context);
    if (effect === undefined) {
      return;
    }
    this.applied++;
    if (effect.kind === "publish") {
      this.effects.publish(effect.room, effect.frame);
      return;
    }
    const write = effect.write;
    const status = this.effects.write(write);
    if (status >= 400) {
      // The run goes on: a later step may not depend on this one, as a real server's would not.
      logger.warn(
        `[PrototypeMock] actor ${write.method} ${write.collection}${write.id === undefined ? "" : `/${write.id}`} answered ${status}.`,
      );
    }
  }
}

function toEffect(step: MockActorStep, context: MockBindingContext): MockActorEffect | undefined {
  try {
    if (step.publish !== undefined) {
      return toPublish(step.publish.room, step.publish.frame, context);
    }
    const write = toWrite(step, context);
    return write === undefined ? undefined : { kind: "write", write };
  } catch (error) {
    // A binding past the size cap skips this step only; the backend keeps answering requests.
    logger.warn(`[PrototypeMock] actor step skipped: ${errorMessage(error)}`, error);
    return undefined;
  }
}

function toPublish(
  roomPattern: string,
  framePattern: PrototypeRequestJson,
  context: MockBindingContext,
): MockActorEffect | undefined {
  const room = bindMockValue(roomPattern, context);
  if (typeof room !== "string" || !room.startsWith("/")) {
    logger.warn(`[PrototypeMock] actor publish skipped: room is not a path`);
    return undefined;
  }
  const frame = bindMockValue(framePattern, context, MAX_PROTOTYPE_CHANNEL_FRAME_BYTES);
  return { kind: "publish", room, frame };
}

function toWrite(step: MockActorStep, context: MockBindingContext): MockActorWrite | undefined {
  const body = step.value === undefined ? undefined : bindMockValue(step.value, context);
  const id = step.id === undefined ? undefined : bindMockValue(step.id, context);
  const idText = id === undefined || id === null ? undefined : String(id);
  if (step.append !== undefined) {
    return { method: "POST", collection: step.append, body };
  }
  if (step.update !== undefined) {
    return { method: "PATCH", collection: step.update, id: idText, body };
  }
  if (step.remove !== undefined) {
    return { method: "DELETE", collection: step.remove, id: idText };
  }
  return undefined;
}
