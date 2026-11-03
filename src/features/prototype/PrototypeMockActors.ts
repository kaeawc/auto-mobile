/**
 * Scripted mock actors (#14211): timed and route-triggered writes to a mock backend's collections,
 * so a demo has "the other side" (a reply arrives, an order moves to "out for delivery") without
 * the agent patching `/data`. Every delay waits on the injected `Timer`, so a fake clock replays a
 * timeline exactly. A run's steps execute in order; each step's `afterMs` is relative to the step
 * before it, and a step with no delay applies immediately.
 */
import { errorMessage } from "../../models/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { bindMockValue, matchMockPath, type MockBindingContext } from "./prototypeMockBinding";
import type { MockActor, MockActorStep } from "./prototypeMockSchema";
import type { PrototypeRequestJson } from "./prototypeRequestProtocol";

export type MockActorTimer = Pick<Timer, "setTimeout" | "clearTimeout">;

/** A collection write, answered the way the equivalent HTTP request would be. */
export interface MockActorWrite {
  method: "POST" | "PATCH" | "DELETE";
  collection: string;
  id?: string;
  body?: PrototypeRequestJson;
}

/** Applies a write and returns its HTTP status. */
export type MockActorApply = (write: MockActorWrite) => number;

/** Scheduled steps across all runs of a backend; a trigger past this is dropped and logged. */
export const MAX_MOCK_ACTOR_PENDING = 256;

const NO_CONTEXT: MockBindingContext = { params: {}, query: {}, body: undefined };

export class PrototypeMockActors {
  private readonly pending = new Set<NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly actors: readonly MockActor[],
    private readonly timer: MockActorTimer,
    private readonly apply: MockActorApply,
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

  /** Cancels every scheduled step; nothing writes after this returns. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.pending) {
      this.timer.clearTimeout(handle);
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private tick(actor: MockActor, runNumber: number, delay: number): void {
    this.schedule(delay, () => {
      this.run(actor.do, 0, 0, NO_CONTEXT);
      if (runNumber < actor.maxRuns!) {
        this.tick(actor, runNumber + 1, actor.every!);
      }
    });
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

  private schedule(delay: number, callback: () => void): void {
    if (this.disposed) {
      return;
    }
    if (this.pending.size >= MAX_MOCK_ACTOR_PENDING) {
      logger.warn(
        `[PrototypeMock] actor step dropped: ${MAX_MOCK_ACTOR_PENDING} steps already scheduled.`,
      );
      return;
    }
    const handle = this.timer.setTimeout(() => {
      this.pending.delete(handle);
      if (!this.disposed) {
        callback();
      }
    }, delay);
    this.pending.add(handle);
  }

  private applyStep(step: MockActorStep, context: MockBindingContext): void {
    const write = toWrite(step, context);
    if (write === undefined) {
      return;
    }
    const status = this.apply(write);
    if (status >= 400) {
      // The run goes on: a later step may not depend on this one, as a real server's would not.
      logger.warn(
        `[PrototypeMock] actor ${write.method} ${write.collection}${write.id === undefined ? "" : `/${write.id}`} answered ${status}.`,
      );
    }
  }
}

function toWrite(step: MockActorStep, context: MockBindingContext): MockActorWrite | undefined {
  try {
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
  } catch (error) {
    // A binding past the size cap skips this step only; the backend keeps answering requests.
    logger.warn(`[PrototypeMock] actor step skipped: ${errorMessage(error)}`, error);
    return undefined;
  }
}
