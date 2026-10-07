/**
 * Static scheduling feasibility for multi-device barrier / criticalSection
 * plans (issue #6231).
 *
 * Execution model (mirrors the runtime, see PlanPartitioner and
 * CriticalSectionCoordinator.waitAtBarrier):
 *   - Each device's steps form one track that runs strictly sequentially, so
 *     a device blocked at a coordination step cannot reach any later step.
 *   - A coordination step (barrier, or the rendezvous at the start of a
 *     criticalSection) on lock L with deviceCount N is an "arrival". The
 *     coordinator collects arrivals per lock and releases all of them once N
 *     have arrived (one "generation"), then starts the next generation empty.
 *   - Non-coordination steps take arbitrary time, so any device that is not
 *     blocked may be the next to arrive anywhere: every arrival order is a
 *     possible runtime timing.
 *
 * The check explores that state space exhaustively (state = each track's
 * position plus whether the device is already waiting at its current lock),
 * which covers both cross-lock ordering cycles (AB-BA) and generation-
 * boundary stranding without special-casing either. A plan is rejected only
 * when NO arrival order lets every track finish -- i.e. every reachable
 * terminal state is a deadlock. That keeps false positives at zero for any
 * plan the executor can run under at least one timing.
 *
 * Deliberately NOT rejected: plans that complete under some timings but can
 * deadlock under others (e.g. deviceCount=2 with arrivals A,B,A,C, which
 * strands A when B and C pair up first). Those are timing-dependent, not
 * infeasible, and the validator accepts them today.
 *
 * Tracks are first split into independent components (devices linked by a
 * shared lock); each component is searched separately, so the state budget
 * applies per component and an unmodeled event (see
 * `CoordinationEvent.unmodeled`) opts out only its own component.
 *
 * Each component search is bounded by `maxStates`; when the bound is hit the
 * result for that component is "unknown" and it is accepted (never a false
 * rejection).
 */

export interface CoordinationEvent {
  tool: string;
  lock: string;
  deviceCount: number;
  stepIndex: number;
  /**
   * True when the runtime may not follow the model for this arrival (an
   * `optional` step can time out and continue; a criticalSection with nested
   * coordination waits again under the section mutex). The whole component
   * containing it is skipped.
   */
  unmodeled?: boolean;
}

export interface CoordinationTrack {
  device: string;
  events: CoordinationEvent[];
}

export interface StalledDevice {
  device: string;
  event: CoordinationEvent;
  /** Devices (including this one) already waiting at the same lock. */
  waitingWith: string[];
}

export interface CoordinationDeadlock {
  stalled: StalledDevice[];
  /** Devices that finished every coordination step before the stall. */
  finished: string[];
  /** Generations released before the stall, in order, e.g. `"X" {A, B}`. */
  releasedGenerations: string[];
}

export const MAX_SCHEDULE_STATES = 10_000;

interface ScheduleState {
  positions: number[];
  arrived: boolean[];
}

interface Successor {
  state: ScheduleState;
  release?: string;
}

interface Visit {
  parent?: string;
  release?: string;
}

interface DeadlockCandidate {
  key: string;
  state: ScheduleState;
  progress: number;
}

function stateKey(state: ScheduleState): string {
  return `${state.positions.join(",")}|${state.arrived.map((a) => (a ? 1 : 0)).join("")}`;
}

function currentEvent(
  tracks: CoordinationTrack[],
  state: ScheduleState,
  index: number,
): CoordinationEvent | undefined {
  return tracks[index].events[state.positions[index]];
}

function isComplete(tracks: CoordinationTrack[], state: ScheduleState): boolean {
  return tracks.every((track, i) => state.positions[i] >= track.events.length);
}

function waitersAt(tracks: CoordinationTrack[], state: ScheduleState, lock: string): number[] {
  const waiters: number[] = [];
  for (let j = 0; j < tracks.length; j++) {
    if (state.arrived[j] && currentEvent(tracks, state, j)?.lock === lock) {
      waiters.push(j);
    }
  }
  return waiters;
}

function arrive(tracks: CoordinationTrack[], state: ScheduleState, index: number): Successor {
  const event = currentEvent(tracks, state, index)!;
  const positions = [...state.positions];
  const arrived = [...state.arrived];
  const generation = [...waitersAt(tracks, state, event.lock), index];

  if (generation.length < event.deviceCount) {
    arrived[index] = true;
    return { state: { positions, arrived } };
  }

  for (const member of generation) {
    positions[member] += 1;
    arrived[member] = false;
  }
  const members = generation
    .map((m) => tracks[m].device)
    .sort()
    .join(", ");
  return { state: { positions, arrived }, release: `"${event.lock}" {${members}}` };
}

function successorsOf(tracks: CoordinationTrack[], state: ScheduleState): Successor[] {
  const successors: Successor[] = [];
  for (let i = 0; i < tracks.length; i++) {
    if (!state.arrived[i] && currentEvent(tracks, state, i) !== undefined) {
      successors.push(arrive(tracks, state, i));
    }
  }
  return successors;
}

function progressOf(state: ScheduleState): number {
  return state.positions.reduce((sum, p) => sum + p, 0);
}

function releasedGenerationsTo(visited: Map<string, Visit>, key: string): string[] {
  const releases: string[] = [];
  let cursor: string | undefined = key;
  while (cursor !== undefined) {
    const visit: Visit | undefined = visited.get(cursor);
    if (visit?.release) {
      releases.push(visit.release);
    }
    cursor = visit?.parent;
  }
  return releases.reverse();
}

function describeStall(
  tracks: CoordinationTrack[],
  visited: Map<string, Visit>,
  candidate: DeadlockCandidate,
): CoordinationDeadlock {
  const { state } = candidate;
  const stalled: StalledDevice[] = [];
  const finished: string[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const event = currentEvent(tracks, state, i);
    if (event === undefined) {
      finished.push(tracks[i].device);
      continue;
    }
    const waitingWith = waitersAt(tracks, state, event.lock).map((j) => tracks[j].device);
    stalled.push({ device: tracks[i].device, event, waitingWith });
  }
  return { stalled, finished, releasedGenerations: releasedGenerationsTo(visited, candidate.key) };
}

function findRoot(parents: Map<string, string>, node: string): string {
  let root = node;
  while (parents.get(root) !== root) {
    root = parents.get(root)!;
  }
  return root;
}

/**
 * Splits tracks into independent components: two tracks are in the same
 * component when they (transitively) share a lock. Components cannot block
 * each other, so the plan completes iff every component can complete.
 */
export function splitIndependentComponents(tracks: CoordinationTrack[]): CoordinationTrack[][] {
  const parents = new Map<string, string>();
  const nodeOf = (kind: "device" | "lock", name: string): string => {
    const node = `${kind}:${name}`;
    if (!parents.has(node)) {
      parents.set(node, node);
    }
    return node;
  };
  for (const track of tracks) {
    const deviceNode = nodeOf("device", track.device);
    for (const event of track.events) {
      parents.set(findRoot(parents, nodeOf("lock", event.lock)), findRoot(parents, deviceNode));
    }
  }
  const components = new Map<string, CoordinationTrack[]>();
  for (const track of tracks) {
    const root = findRoot(parents, `device:${track.device}`);
    components.set(root, [...(components.get(root) ?? []), track]);
  }
  return Array.from(components.values());
}

/**
 * Returns a representative deadlock when, in some independent component, no
 * arrival order lets every track finish; `null` when every analyzed
 * component can complete, is unmodeled, or exhausts the search bound.
 */
export function findUnavoidableCoordinationDeadlock(
  tracks: CoordinationTrack[],
  maxStates: number = MAX_SCHEDULE_STATES,
): CoordinationDeadlock | null {
  for (const component of splitIndependentComponents(tracks)) {
    const unmodeled = component.some((track) => track.events.some((e) => e.unmodeled === true));
    const deadlock = unmodeled ? null : searchComponent(component, maxStates);
    if (deadlock !== null) {
      return deadlock;
    }
  }
  return null;
}

function searchComponent(
  tracks: CoordinationTrack[],
  maxStates: number,
): CoordinationDeadlock | null {
  const initial: ScheduleState = {
    positions: tracks.map(() => 0),
    arrived: tracks.map(() => false),
  };
  const visited = new Map<string, Visit>([[stateKey(initial), {}]]);
  const stack: ScheduleState[] = [initial];
  let deepest: DeadlockCandidate | undefined;

  while (stack.length > 0) {
    const state = stack.pop()!;
    if (isComplete(tracks, state)) {
      return null;
    }
    const key = stateKey(state);
    const successors = successorsOf(tracks, state);
    if (successors.length === 0) {
      const progress = progressOf(state);
      if (deepest === undefined || progress > deepest.progress) {
        deepest = { key, state, progress };
      }
      continue;
    }
    for (const successor of successors) {
      const nextKey = stateKey(successor.state);
      if (visited.has(nextKey)) {
        continue;
      }
      if (visited.size >= maxStates) {
        // Search bound reached: feasibility unknown, so never reject.
        return null;
      }
      visited.set(nextKey, { parent: key, release: successor.release });
      stack.push(successor.state);
    }
  }

  return deepest === undefined ? null : describeStall(tracks, visited, deepest);
}

function describeStalledDevice(stalled: StalledDevice): string {
  const { device, event, waitingWith } = stalled;
  return `device "${device}" waits at ${event.tool} lock "${event.lock}" (step ${event.stepIndex}; ${waitingWith.length}/${event.deviceCount} arrived: ${waitingWith.join(", ")})`;
}

/** Formats a deadlock as an actionable validation message. */
export function formatCoordinationDeadlock(deadlock: CoordinationDeadlock): string {
  const locks = Array.from(new Set(deadlock.stalled.map((s) => `"${s.event.lock}"`)));
  const released =
    deadlock.releasedGenerations.length > 0 ? deadlock.releasedGenerations.join(" -> ") : "none";
  const finished =
    deadlock.finished.length > 0
      ? ` Tracks already finished (cannot arrive again): ${deadlock.finished.join(", ")}.`
      : "";
  return (
    `barrier/criticalSection coordination can never complete: under every possible arrival order at least one device track deadlocks. ` +
    `One reachable stall: ${deadlock.stalled.map(describeStalledDevice).join("; ")}. ` +
    `Locks involved: ${locks.join(", ")}. Generations released before the stall: ${released}.${finished} ` +
    `Each device's track runs sequentially, so a device blocked at one lock never reaches the later lock its peers are waiting at. ` +
    `Reorder the coordination steps so devices visit shared locks in a consistent order, or add the arrivals the stalled locks are missing.`
  );
}
