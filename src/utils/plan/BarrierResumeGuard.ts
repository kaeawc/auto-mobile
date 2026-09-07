import { ActionableError } from "../../models";
import { Plan, PlanStep } from "../../models/Plan";

/**
 * A contiguous span of plan indices that must be resumed *as a unit* — the
 * arrivals belonging to one barrier generation (or one criticalSection
 * rendezvous). Resuming strictly inside this span would re-run some
 * participating device tracks' arrivals while skipping others', splitting the
 * generation so it can never reach `deviceCount` and deadlocking the survivors
 * at `CriticalSectionCoordinator.waitAtBarrier` (issue #6234).
 */
interface GenerationSpan {
  lock: string;
  /** Plan index of the first arrival in this generation. */
  firstIndex: number;
  /** Plan index of the last arrival in this generation. */
  lastIndex: number;
}

const COORDINATION_TOOLS = new Set(["barrier", "criticalSection"]);

/**
 * Resolve a coordination field (`lock`/`deviceCount`) honoring PlanNormalizer's
 * params-wins precedence, with an inline fallback for a step that reaches this
 * guard before normalization. Mirrors `PlanValidator.effectiveField`.
 */
function effectiveField(step: PlanStep, field: string): unknown {
  const params = step.params;
  if (params && typeof params === "object" && Object.prototype.hasOwnProperty.call(params, field)) {
    return (params as Record<string, unknown>)[field];
  }
  // oxlint-disable-next-line auto-mobile/no-unknown-cast
  const inlineFields = step as unknown as Record<string, unknown>;
  return inlineFields[field];
}

interface Arrival {
  planIndex: number;
  deviceCount: number | undefined;
  /** The device label (`params.device`) whose track executes this arrival. */
  device: string | undefined;
}

/**
 * Build the set of generation spans for one lock's ordered arrivals.
 *
 * A barrier generation is NOT a contiguous slice of the global plan order — the
 * device tracks run concurrently, each executing its own arrivals in track
 * order. `CriticalSectionCoordinator` fills a generation with one arrival per
 * distinct device and resets once `deviceCount` distinct devices have arrived,
 * so generation `g` is the `g`-th arrival of *every* participating device's
 * track, whichever global indices those land on. For a device-grouped plan
 * order like `A@0, A@1, B@2, B@3` (deviceCount 2) the real generations are
 * `{0,2}` and `{1,3}` — the "column" across tracks — not the contiguous
 * `{0,1}`/`{2,3}` a global-order slice would produce.
 *
 * We therefore reconstruct each device's track (its arrivals in plan order) and
 * repeatedly take the earliest *next* arrival from distinct tracks. This is the
 * same constraint the executor imposes: a device cannot reach its second
 * arrival until its first barrier release, while the next round may legitimately
 * replace a participant. For `A@0,B@1,A@3,C@4` (count two), that yields
 * `{A@0,B@1}` then `{A@3,C@4}`. A fixed all-track column would reject that
 * validator-permitted changing participant set and replay round one.
 *
 * If the guard is called on a shape that PlanValidator would reject — a missing
 * device label, inconsistent count, incomplete generation, or too few candidate
 * tracks — it fails closed. Rewinding the whole lock is unsafe because it
 * replays completed destructive steps between otherwise independent generations.
 *
 * `deviceCount: 1` is a special case: every arrival completes its own
 * generation, regardless of which (or how many) devices share the lock. It
 * must remain a singleton span so recovery never rewinds past a completed
 * count-one arrival.
 */
function spansForLock(lock: string, arrivals: Arrival[]): GenerationSpan[] {
  if (arrivals.length === 0) {
    return [];
  }

  const consistentCount = consistentDeviceCount(arrivals);
  if (consistentCount === 1) {
    // Every arrival satisfies the barrier by itself — span it as a singleton
    // generation of one, so a resume point between two count-one arrivals
    // never rewinds past one that already completed.
    return arrivals.map((arrival) => singletonSpan(lock, arrival));
  }

  const tracks = deviceTracks(arrivals);
  if (tracks === undefined) {
    throw invalidBarrierRecoveryShape(lock, "an arrival is missing its device label");
  }
  if (consistentCount === undefined || arrivals.length % consistentCount !== 0) {
    throw invalidBarrierRecoveryShape(
      lock,
      `${arrivals.length} arrivals cannot form complete groups of ${String(consistentCount)}`,
    );
  }

  const consumed = new Map<string, number>();
  const spans: GenerationSpan[] = [];
  for (let remaining = arrivals.length; remaining > 0; remaining -= consistentCount) {
    const nextArrivals = [...tracks.entries()]
      .map(([device, track]) => ({ device, arrival: track[consumed.get(device) ?? 0] }))
      .filter(
        (candidate): candidate is { device: string; arrival: Arrival } =>
          candidate.arrival !== undefined,
      )
      .sort((a, b) => a.arrival.planIndex - b.arrival.planIndex);
    if (nextArrivals.length < consistentCount) {
      throw invalidBarrierRecoveryShape(
        lock,
        `only ${nextArrivals.length} device tracks remain for deviceCount=${consistentCount}`,
      );
    }
    const generation = nextArrivals.slice(0, consistentCount);
    spans.push(
      spanForArrivals(
        lock,
        generation.map((candidate) => candidate.arrival),
      ),
    );
    for (const { device } of generation) {
      consumed.set(device, (consumed.get(device) ?? 0) + 1);
    }
  }
  return spans;
}

/** The span of a single arrival that completes its generation by itself. */
function singletonSpan(lock: string, arrival: Arrival): GenerationSpan {
  return { lock, firstIndex: arrival.planIndex, lastIndex: arrival.planIndex };
}

function invalidBarrierRecoveryShape(lock: string, reason: string): ActionableError {
  return new ActionableError(
    `Cannot safely recover barrier lock "${lock}": ${reason}. ` +
      "The plan must pass barrier validation before it can be resumed.",
  );
}

/**
 * Reconstruct each device's track (its arrivals' plan indices in plan order).
 * Iterating in plan order preserves per-device track order, so the k-th entry of
 * a device's list is that device's k-th arrival at the lock. Returns undefined when
 * any arrival is missing its device label.
 */
function deviceTracks(arrivals: Arrival[]): Map<string, Arrival[]> | undefined {
  const perDevice = new Map<string, Arrival[]>();
  for (const arrival of arrivals) {
    if (arrival.device === undefined) {
      return undefined;
    }
    const list = perDevice.get(arrival.device) ?? [];
    list.push(arrival);
    perDevice.set(arrival.device, list);
  }
  return perDevice;
}

/**
 * The single `deviceCount` value declared consistently across `arrivals`, or
 * undefined when it is missing or disagrees between arrivals of the same
 * lock.
 */
function consistentDeviceCount(arrivals: Arrival[]): number | undefined {
  const counts = new Set(
    arrivals.map((a) => a.deviceCount).filter((c): c is number => typeof c === "number" && c >= 1),
  );
  return counts.size === 1 ? (counts.values().next().value as number) : undefined;
}

/** Span of one coordinator generation's arrivals. */
function spanForArrivals(lock: string, arrivals: Arrival[]): GenerationSpan {
  let firstIndex = Infinity;
  let lastIndex = -Infinity;
  for (const arrival of arrivals) {
    const planIndex = arrival.planIndex;
    if (planIndex < firstIndex) {
      firstIndex = planIndex;
    }
    if (planIndex > lastIndex) {
      lastIndex = planIndex;
    }
  }
  return { lock, firstIndex, lastIndex };
}

function readDeviceCount(step: PlanStep): number | undefined {
  const rawCount = effectiveField(step, "deviceCount");
  return typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 1
    ? rawCount
    : undefined;
}

/**
 * Read the device label a step's track belongs to. Multi-device plans (the only
 * plans this guard sees, via executeParallel) tag every step with a device.
 * Honor the validator's params-wins inline fallback so recovery sees the same
 * normalized contract as execution.
 */
function readDevice(step: PlanStep): string | undefined {
  const device = effectiveField(step, "device");
  return typeof device === "string" && device.length > 0 ? device : undefined;
}

function pushArrival(bucket: Map<string, Arrival[]>, lock: string, arrival: Arrival): void {
  const arrivals = bucket.get(lock) ?? [];
  arrivals.push(arrival);
  bucket.set(lock, arrivals);
}

/**
 * Collect the generation spans for every coordination lock in the plan, in plan
 * order. `barrier` and `criticalSection` share the runtime coordinator's lock
 * namespace, so both contribute spans. A criticalSection lock is a single-use
 * rendezvous (validation enforces exactly `deviceCount` steps, one per device),
 * so all its steps form one generation.
 */
function collectGenerationSpans(plan: Plan): GenerationSpan[] {
  const barrierArrivals = new Map<string, Arrival[]>();
  const criticalSectionArrivals = new Map<string, Arrival[]>();

  for (let planIndex = 0; planIndex < plan.steps.length; planIndex++) {
    const step = plan.steps[planIndex];
    if (!COORDINATION_TOOLS.has(step.tool)) {
      continue;
    }
    const lock = effectiveField(step, "lock");
    if (typeof lock !== "string" || lock.length === 0) {
      continue;
    }
    const bucket = step.tool === "barrier" ? barrierArrivals : criticalSectionArrivals;
    pushArrival(bucket, lock, {
      planIndex,
      deviceCount: readDeviceCount(step),
      device: readDevice(step),
    });
  }

  const spans: GenerationSpan[] = [];
  for (const [lock, arrivals] of barrierArrivals.entries()) {
    spans.push(...spansForLock(lock, arrivals));
  }
  for (const [lock, arrivals] of criticalSectionArrivals.entries()) {
    // A criticalSection lock is one rendezvous: every step sharing it belongs to
    // the same generation regardless of the per-step deviceCount, so span the
    // whole set rather than slicing it into N-sized groups.
    if (arrivals.length > 0) {
      spans.push({
        lock,
        firstIndex: arrivals[0].planIndex,
        lastIndex: arrivals[arrivals.length - 1].planIndex,
      });
    }
  }
  return spans;
}

/**
 * Compute a resume step that never lands *inside* a barrier/criticalSection
 * generation.
 *
 * AI recovery resumes a failed plan at the failed global step index, and
 * `PlanExecutor` skips lower-indexed steps independently per device track. If
 * that resume index falls in the middle of a barrier generation — after some
 * participating arrivals but before others — the survivors re-arrive alone and
 * wait forever for partners whose arrivals were skipped, deadlocking to the
 * barrier timeout (issue #6234).
 *
 * This rewinds the requested `startStep` down to the first arrival of any
 * generation it would split, so the whole generation re-arrives together (fix
 * direction 1 in the issue: rewind across the complete barrier generation).
 * Rewinding can move the resume point into an earlier, overlapping generation
 * (interleaved barriers), so it iterates to a fixed point. A resume point that
 * does not split any generation is returned unchanged, so ordinary recovery is
 * unaffected.
 *
 * @returns the safe resume step (<= startStep, >= 0).
 */
export function computeSafeBarrierResumeStep(plan: Plan, startStep: number): number {
  if (startStep <= 0) {
    return startStep;
  }
  const spans = collectGenerationSpans(plan);
  if (spans.length === 0) {
    return startStep;
  }

  let safe = startStep;
  // Rewinding to one generation's start can uncover another generation that now
  // straddles the new resume point; iterate until no span is split. Each pass
  // moves `safe` to the earliest first-arrival among the spans it currently
  // splits, so `safe` strictly decreases and is bounded below by the smallest
  // firstIndex — the loop terminates.
  for (;;) {
    let earliest = safe;
    for (const span of spans) {
      if (span.firstIndex < safe && safe <= span.lastIndex && span.firstIndex < earliest) {
        earliest = span.firstIndex;
      }
    }
    if (earliest === safe) {
      return safe;
    }
    safe = earliest;
  }
}
