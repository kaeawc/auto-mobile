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
}

/**
 * Build the set of generation spans for one lock's ordered arrivals.
 *
 * When the lock has a single consistent, positive `deviceCount` N and its total
 * arrivals divide evenly into N, arrivals are grouped into exact N-sized
 * generations (the same generation model the barrier plan-validation checks
 * use). Otherwise — an inconsistent or indivisible count that plan validation
 * would already reject — we fall back to a single conservative span covering
 * every arrival of the lock, so a mid-lock resume still rewinds to the lock's
 * first arrival rather than splitting it.
 */
function spansForLock(lock: string, arrivals: Arrival[]): GenerationSpan[] {
  if (arrivals.length === 0) {
    return [];
  }

  const counts = new Set(
    arrivals.map((a) => a.deviceCount).filter((c): c is number => typeof c === "number" && c >= 1),
  );
  const consistentCount = counts.size === 1 ? (counts.values().next().value as number) : undefined;

  if (
    consistentCount === undefined ||
    consistentCount < 1 ||
    arrivals.length % consistentCount !== 0
  ) {
    return [
      {
        lock,
        firstIndex: arrivals[0].planIndex,
        lastIndex: arrivals[arrivals.length - 1].planIndex,
      },
    ];
  }

  const spans: GenerationSpan[] = [];
  for (let start = 0; start < arrivals.length; start += consistentCount) {
    const group = arrivals.slice(start, start + consistentCount);
    spans.push({
      lock,
      firstIndex: group[0].planIndex,
      lastIndex: group[group.length - 1].planIndex,
    });
  }
  return spans;
}

function readDeviceCount(step: PlanStep): number | undefined {
  const rawCount = effectiveField(step, "deviceCount");
  return typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 1
    ? rawCount
    : undefined;
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
    pushArrival(bucket, lock, { planIndex, deviceCount: readDeviceCount(step) });
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
