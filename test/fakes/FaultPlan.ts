import type { Timer } from "../../src/utils/SystemTimer";

export type FaultKind = "reject" | "hang-until-released" | "delay" | "crash-after";
export interface FaultPoint {
  name: string;
  pause?: Promise<void>;
  crash: boolean;
  blocked?: boolean;
}

/** One fault per run, shared by the persistence and journal fakes. No wall-clock work. */
export class FaultPlan {
  readonly points: string[] = [];
  crashed = false;
  triggered = false;
  private parked?: ReturnType<typeof Promise.withResolvers<void>>;
  private readonly dead = new Promise<void>(() => {});

  constructor(
    readonly timer: Timer,
    readonly at = Infinity,
    readonly kind: FaultKind = "reject",
    private readonly synchronousWait?: (kind: FaultKind, resume: () => void) => void,
  ) {}

  enter(name: string, synchronous = false): FaultPoint {
    if (this.crashed) {
      return { name, pause: this.dead, crash: false };
    }
    this.points.push(name);
    const hit = this.points.length === this.at;
    this.triggered ||= hit;
    if (hit && this.kind === "reject") {
      throw new Error(`Injected rejection at ${name}`);
    }
    const blocked =
      hit && synchronous && (this.kind === "hang-until-released" || this.kind === "delay");
    const pause = hit && !synchronous ? this.pause() : undefined;
    return { name, pause, blocked, crash: hit && this.kind === "crash-after" };
  }

  private pause(): Promise<void> | undefined {
    if (this.kind === "hang-until-released") {
      this.parked = Promise.withResolvers<void>();
      return this.parked.promise;
    }
    if (this.kind === "delay") {
      return new Promise((resolve) => this.timer.setTimeout(resolve, 7));
    }
    return undefined;
  }

  finish(point: FaultPoint | undefined): void {
    if (point?.crash) {
      this.crashed = true;
      throw new Error(`Injected crash after ${point.name}`);
    }
  }

  /**
   * A synchronous syscall freezes the whole process: the supervisor advances virtual time
   * without firing JS timers, then explicitly resumes it. It cannot interleave a rebind.
   */
  sync(name: string, effect: () => void): void {
    const point = this.enter(name, true);
    if (point.pause) {
      throw new Error(`Crashed process cannot issue synchronous ${name}`);
    }
    if (point.blocked) {
      let resumed = false;
      this.synchronousWait?.(this.kind, () => {
        resumed = true;
      });
      if (!resumed) {
        throw new Error(`Injected unavailable synchronous ${name}`);
      }
    }
    effect();
    this.finish(point);
  }

  release(): void {
    this.parked?.resolve();
  }
}
