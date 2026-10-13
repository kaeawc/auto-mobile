import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  RECLAIM_GUARD_ABANDON_AGE_MS,
  acquireExclusiveLockSteps,
  releaseExclusiveLockSteps,
  tryAcquireExclusiveLock,
  readExclusiveLockContent,
  readLockOwnerPid,
  formatLockContent,
  takeOverExclusiveLock,
  type ExclusiveLockOptions,
  type LockStep,
} from "../../src/utils/fileLock";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeLockFileSystem } from "../fakes/FakeLockFileSystem";
import { SeededRandom } from "../fakes/SeededRandom";
import { FakeTimer } from "../fakes/FakeTimer";

export const PATH = "/locks/resource.lock";
export const NOW = 20_000;
export const OLD = "99\nstale\n\nold-generation";
type Steps<T> = Generator<LockStep, T, void>;

/** A pending descriptor names the operation the NEXT advance will execute. */
export class Racer<T> {
  pending: IteratorResult<LockStep, T>;
  readonly trace: LockStep[] = [];

  constructor(readonly steps: Steps<T>) {
    this.pending = steps.next();
  }

  advance(): void {
    if (!this.pending.done) {
      this.trace.push(this.pending.value);
      this.pending = this.steps.next();
    }
  }

  finish(check: () => void = () => {}): T {
    for (let count = 0; !this.pending.done; count++) {
      if (count > 1024) {
        throw new Error("Unbounded lock attempt");
      }
      this.advance();
      check();
    }
    return this.pending.value;
  }

  until(predicate: (step: LockStep) => boolean): void {
    for (let count = 0; !this.pending.done && !predicate(this.pending.value); count++) {
      if (count > 1024) {
        throw new Error("Missing requested step");
      }
      this.advance();
    }
    expect(this.pending.done).toBe(false);
  }
}

export function fixture(raw = OLD) {
  const clock = new FakeTimer();
  clock.advanceTime(NOW);
  const fs = new FakeLockFileSystem(() => clock.now());
  fs.seed(PATH, raw, 0);
  const live = new Set([101, 202, 303, 404]);
  const idGenerator = new FakeIdGenerator();
  const options = (pid: number): ExclusiveLockOptions => ({
    pid,
    ownerToken: `owner-${pid}`,
    fileSystem: fs,
    idGenerator,
    now: () => clock.now(),
    isProcessRunning: (owner) => live.has(owner),
    ownerGeneration: {
      current: () => "current-generation",
      compare: (_owner, generation) => (generation === "old-generation" ? "different" : "same"),
    },
  });
  const acquire = (pid: number) => new Racer(acquireExclusiveLockSteps(PATH, options(pid)));
  return { fs, live, options, acquire, clock };
}

export function pauseAfterJudgement(racer: Racer<boolean>): void {
  racer.until((step) => step.op === "writeFile" && step.path.includes(".reclaim."));
}

export function exactHolder(fs: FakeLockFileSystem, pid: number): void {
  const raw = formatLockContent(pid, `owner-${pid}`, undefined, "current-generation");
  const atPath = fs.peek(PATH)?.raw === raw;
  expect(fs.peek(atPath ? PATH : `${PATH}.displaced`)?.raw).toBe(raw);
  if (atPath || !fs.peek(PATH)) {
    const failure = fs.failure;
    fs.failure = undefined;
    try {
      // Observer reads must not consume faults scheduled for the actor's next operation.
      expect(readExclusiveLockContent(PATH, fs)?.pid).toBe(pid);
      expect(readLockOwnerPid(PATH, () => true, undefined, fs)).toBe(pid);
    } finally {
      fs.failure = failure;
    }
  }
}

export function prefix(fs: FakeLockFileSystem): string {
  const { ino, mtimeMs } = fs.stat(PATH);
  const hash = createHash("sha256").update(fs.readText(PATH)).digest("hex").slice(0, 32);
  return `${PATH}.reclaim.${ino}.${mtimeMs}.${hash}`;
}

export interface Actor {
  pid: number;
  options: ExclusiveLockOptions;
  racer: Racer<boolean | void>;
  phase: "acquiring" | "holding" | "releasing" | "finished" | "crashed";
  attempts: number;
  holdPicks?: number;
  staleRelease?: boolean;
  everResidual?: boolean;
  failedRetainMarkers?: Map<string, number>;
  publicationIno?: number;
  publicationCopies?: Set<number>;
  restoreOwner?: Actor;
  backOutReturned?: boolean;
  retainedPeerDecision?: boolean;
  releaseReturned?: boolean;
}

function actorRaw(actor: Actor): string {
  return formatLockContent(
    actor.pid,
    actor.options.ownerToken,
    actor.options.metadata,
    "current-generation",
  );
}

function namesHolding(fs: FakeLockFileSystem, raw: string, includePrivate = false): string[] {
  // Public names suffice unless the instance has been displaced into a private marker.
  const names = [PATH, `${PATH}.displaced`].filter((name) => fs.peek(name)?.raw === raw);
  if (names.length && !includePrivate) {
    return names;
  }
  return [
    ...names,
    ...fs.paths().filter((name) => isPrivateMarker(name) && fs.peek(name)?.raw === raw),
  ];
}

function publicationNames(fs: FakeLockFileSystem, actor: Actor, includePrivate = false): string[] {
  const matches = (name: string) => {
    const node = fs.peek(name);
    return (
      node?.raw === actorRaw(actor) ||
      (actor.publicationIno !== undefined && node?.ino === actor.publicationIno) ||
      (node !== undefined && actor.publicationCopies?.has(node.ino))
    );
  };
  const publicNames = [PATH, `${PATH}.displaced`].filter(matches);
  // Ordinary schedules keep holders public; no namespace scan on their per-step hot path.
  return publicNames.length && !includePrivate ? publicNames : fs.paths().filter(matches);
}

function isPrivateMarker(name: string): boolean {
  return /^.+\.\d+\.(?:reclaim|release\.\d+)$/.test(name);
}

export function assertBelievers(fs: FakeLockFileSystem, actors: Actor[]): void {
  const believers = actors.filter((actor) => actor.phase === "holding");
  for (const actor of believers) {
    for (const other of believers.filter((candidate) => candidate !== actor)) {
      expect(actor.everResidual || other.everResidual).toBe(true);
    }
    if (!actor.everResidual) {
      // A continuously public believer must still have its exact published bytes at P or F.
      exactHolder(fs, actor.pid);
    }
  }
}

export function advanceActor(
  actor: Actor,
  f: ReturnType<typeof fixture>,
  ioFailureIsAttempt = false,
): void {
  if (actor.phase === "holding") {
    // Release relinquishes belief at invocation; its rename is the owner's voluntary removal.
    actor.phase = "releasing";
    actor.racer = new Racer(releaseExclusiveLockSteps(PATH, actor.pid, `owner-${actor.pid}`, f.fs));
  }
  try {
    actor.racer.advance();
  } catch (error) {
    if (!ioFailureIsAttempt || !(error instanceof ActionableError) || actor.phase !== "acquiring") {
      throw error;
    }
    retryActor(actor);
    return;
  }
  if (!actor.racer.pending.done) {
    return;
  }
  if (actor.phase === "releasing") {
    actor.releaseReturned = true;
    actor.phase = "finished";
  } else if (actor.racer.pending.value) {
    expect(actor.retainedPeerDecision).not.toBe(true);
    actor.phase = "holding";
  } else {
    actor.backOutReturned ||=
      actor.publicationIno !== undefined &&
      actor.racer.trace.some((step) => step.op === "stat" && step.path === `${PATH}.displaced`);
    retryActor(actor);
  }
}

function retryActor(actor: Actor): void {
  actor.restoreOwner = undefined;
  actor.retainedPeerDecision = false;
  if (++actor.attempts < 6) {
    actor.racer = new Racer(acquireExclusiveLockSteps(PATH, actor.options));
  } else {
    actor.phase = "finished";
  }
}

function originalStale(seed: number): string {
  const kind = seed % 4;
  return kind === 0 ? "" : kind === 3 ? "101\nprevious-instance" : OLD;
}

export function runSchedule(seed: number): void {
  const kind = seed % 4;
  const raw = originalStale(seed);
  const f = fixture(raw);
  if (kind === 2) {
    f.live.add(99); // Live PID with provably different generation.
  }
  const random = new SeededRandom(seed);
  const actors: Actor[] = [101, 202, 303, ...(seed % 3 === 0 ? [404] : [])].map((pid) => {
    const options = { ...f.options(pid), reclaimOwnPid: kind === 3 && pid === 101 };
    return {
      pid,
      options,
      racer: new Racer(acquireExclusiveLockSteps(PATH, options)),
      phase: "acquiring",
      attempts: 0,
    };
  });
  const trace: string[] = [];
  if (seed % 3 === 0 && kind !== 3) {
    // A crashed reclaimer's PID is recycled by a live process with no generation evidence.
    const options: ExclusiveLockOptions = {
      ...f.options(707),
      ownerGeneration: { current: () => undefined, compare: () => "different" },
    };
    const racer = new Racer(acquireExclusiveLockSteps(PATH, options));
    const guard = `${prefix(f.fs)}.0`;
    racer.until((step) => step.op === "stat" && step.path === PATH && f.fs.exists(guard));
    actors.push({ pid: 707, options, racer, phase: "crashed", attempts: 0 });
    f.live.add(707);
    trace.push("707 CRASHED RECLAIMER, PID REUSED WITHOUT GENERATION EVIDENCE");
  }
  // Start every stale observer before any removal; a fourth actor is also fresh
  // in rows that insert it after the original stale instance has gone.
  for (const actor of actors.slice(0, 3)) {
    if (kind !== 3 || actor.pid === 101) {
      pauseAfterJudgement(actor.racer as Racer<boolean>);
    }
  }
  for (const actor of actors) {
    trace.push(...actor.racer.trace.map((step) => `${actor.pid} ${JSON.stringify(step)}`));
  }
  try {
    executeSchedule({ seed, random, f, actors, trace });
  } catch (error) {
    throw new Error(`seed=${seed}\n${trace.join("\n")}`, { cause: error });
  }
}

function executeSchedule(context: {
  seed: number;
  random: SeededRandom;
  f: ReturnType<typeof fixture>;
  actors: Actor[];
  trace: string[];
}): void {
  const { seed, random, f, actors, trace } = context;
  let freshAdded = false;
  for (let count = 0; count < 1200; count++) {
    if (!freshAdded && f.fs.peek(PATH)?.raw !== originalStale(seed)) {
      f.live.add(606);
      actors.push({
        pid: 606,
        options: f.options(606),
        racer: f.acquire(606),
        phase: "acquiring",
        attempts: 0,
      });
      freshAdded = true;
      trace.push("606 FRESH ACTOR");
    }
    const active = actors.filter(
      (actor) => actor.phase !== "finished" && actor.phase !== "crashed",
    );
    if (!active.length) {
      break;
    }
    const actor = random.pick(active);
    const step = actor.racer.pending.done
      ? "voluntary-release"
      : JSON.stringify(actor.racer.pending.value);
    trace.push(`${actor.pid} ${step}`);
    if (seed % 2 === 1 && random.next() < 0.025) {
      actor.phase = "crashed";
      f.live.delete(actor.pid);
      trace.push(`${actor.pid} CRASH`);
    } else {
      checkMutation(actor, f, actors);
    }
    assertBelievers(f.fs, actors);
  }
  expect(actors.every((actor) => actor.phase === "finished" || actor.phase === "crashed")).toBe(
    true,
  );
  if (actors.every((actor) => actor.phase !== "crashed")) {
    expect(f.fs.paths()).toEqual([]); // Every successful holder voluntarily released.
  }
  // (d) No stuck state: all actors have finished/crashed before aging abandoned guards.
  f.clock.advanceTime(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
  f.live.add(505);
  let acquired = false;
  for (let attempt = 0; attempt < 6 && !acquired; attempt++) {
    acquired = tryAcquireExclusiveLock(PATH, f.options(505));
  }
  expect(acquired).toBe(true);
  exactHolder(f.fs, 505);
}

export function checkMutation(
  actor: Actor,
  f: ReturnType<typeof fixture>,
  actors: Actor[],
  ioFailureIsAttempt = false,
  // Only retained schedules witness and track the in-flight private-marker residual.
  trackResiduals = false,
): void {
  const protectedNames = actors
    .filter((other) => other.pid !== actor.pid && other.phase === "holding" && !other.everResidual)
    .flatMap((other) =>
      namesHolding(f.fs, actorRaw(other))
        .filter((name) => name === PATH || name === `${PATH}.displaced`)
        .map((name) => ({ name, raw: actorRaw(other), owner: other })),
    );
  const pathWasAbsent = !f.fs.peek(PATH);
  const pending = actor.racer.pending;
  const retainMarker =
    trackResiduals &&
    !pending.done &&
    pending.value.op === "rename" &&
    isPrivateMarker(pending.value.path)
      ? pending.value.path
      : undefined;
  const retainIno = retainMarker ? f.fs.peek(retainMarker)?.ino : undefined;
  const sampledMarker =
    trackResiduals &&
    !pending.done &&
    pending.value.op === "readText" &&
    isPrivateMarker(pending.value.path)
      ? f.fs.peek(pending.value.path)
      : undefined;
  const wasAcquiring = actor.phase === "acquiring";
  const previous = actor.racer.trace.at(-1);
  const ownRetainedDecision =
    trackResiduals &&
    wasAcquiring &&
    !pending.done &&
    pending.value.op === "readText" &&
    pending.value.path === PATH &&
    previous?.op === "readText" &&
    previous.path === `${PATH}.displaced` &&
    f.fs.peek(`${PATH}.displaced`)?.raw === actorRaw(actor);
  const peerAtDecision = f.fs.peek(PATH)?.raw;
  const start = f.fs.operations.length;
  const failedOperations = new Set<string>();
  const failure = f.fs.failure;
  if (trackResiduals) {
    f.fs.failure = (op, path) => {
      const code = failure?.(op, path);
      if (code) {
        failedOperations.add(`${op}:${path}`);
      }
      return code;
    };
  }
  try {
    advanceActor(actor, f, ioFailureIsAttempt);
  } finally {
    f.fs.failure = failure;
  }
  const operations = f.fs.operations.slice(start);
  if (sampledMarker && !failedOperations.has(`readText:${pending.value?.path}`)) {
    actor.restoreOwner = actors.find(
      (other) =>
        other.publicationIno === sampledMarker.ino ||
        other.publicationCopies?.has(sampledMarker.ino),
    );
  }
  if (
    trackResiduals &&
    actor.restoreOwner &&
    pathWasAbsent &&
    f.fs.peek(PATH) &&
    operations.some((op) => op.path === PATH && op.op === "openExclusive")
  ) {
    // An exclusive restore can copy even an empty legacy publication; its new inode
    // belongs to the displaced writer, never to the stale releasing actor (1366).
    actor.restoreOwner.publicationCopies ??= new Set();
    actor.restoreOwner.publicationCopies.add(f.fs.peek(PATH)!.ino);
  }
  if (
    ownRetainedDecision &&
    ((peerAtDecision !== undefined && peerAtDecision !== actorRaw(actor)) ||
      failedOperations.has(`readText:${PATH}`))
  ) {
    // R1's decision remains strict even for a residual actor: foreign/unreadable P
    // is blocked, not ENOENT. Pin that decision in the retained property too.
    actor.retainedPeerDecision = true;
  }
  if (
    trackResiduals &&
    wasAcquiring &&
    pathWasAbsent &&
    f.fs.peek(PATH) &&
    operations.some((op) => op.path === PATH && ["link", "openExclusive"].includes(op.op)) &&
    (f.fs.peek(PATH)?.raw === actorRaw(actor) ||
      (f.fs.peek(PATH)?.raw === "" && !actor.restoreOwner))
  ) {
    actor.publicationIno = f.fs.peek(PATH)?.ino;
  }
  if (retainMarker && retainIno !== undefined && f.fs.peek(retainMarker)?.ino === retainIno) {
    // A failed RETAIN rename keeps its private marker and warns, the documented worst case (6002).
    actor.failedRetainMarkers ??= new Map();
    actor.failedRetainMarkers.set(retainMarker, retainIno);
  }
  if (trackResiduals) {
    recordResiduals(f.fs, actors);
  }
  for (const { name, raw, owner } of protectedNames) {
    if (owner.everResidual) {
      continue;
    }
    const mutations = operations.filter(
      (op) =>
        op.path === name &&
        ["rename", "unlink", "writeFile"].includes(op.op) &&
        !failedOperations.has(`${op.op}:${op.path}`),
    );
    expect(mutations).toHaveLength(0);
    expect(f.fs.peek(name)?.raw).toBe(raw);
  }
}

/** Real failed restore, shared by the named tests and the retained schedule. */
export function retainedFixture() {
  const raw = (pid: number) =>
    formatLockContent(pid, `owner-${pid}`, undefined, "current-generation");
  const f = fixture(raw(202));
  const release = new Racer(releaseExclusiveLockSteps(PATH, 202, "owner-202", f.fs));
  release.until((step) => step.op === "rename" && step.path === PATH);
  f.fs.seed(PATH, raw(101));
  f.fs.failure = (op, path) => {
    if (path !== PATH) {
      return undefined;
    }
    return op === "link" ? "ENOTSUP" : op === "openExclusive" ? "ENOSPC" : undefined;
  };
  release.finish();
  f.fs.failure = undefined;
  expect(f.fs.paths()).toEqual([`${PATH}.displaced`]);
  expect(f.fs.readText(`${PATH}.displaced`)).toBe(raw(101));
  return f;
}

export function runRetainedSchedule(seed: number): void {
  const trace: string[] = [];
  try {
    executeRetainedSchedule(seed, trace);
  } catch (error) {
    throw new Error(`retained seed=${seed}\n${trace.join("\n")}`, { cause: error });
  }
}

interface RetainedContext {
  seed: number;
  random: SeededRandom;
  f: ReturnType<typeof fixture>;
  actors: Actor[];
  trace: string[];
  faultStreaks: Map<string, number>;
}

function recordResiduals(fs: FakeLockFileSystem, actors: Actor[]): void {
  for (const actor of actors) {
    if (
      actor.everResidual ||
      actor.publicationIno === undefined ||
      !["acquiring", "holding", "releasing"].includes(actor.phase)
    ) {
      continue;
    }
    // Includes an empty/partial legacy wx inode, a private-only publication, and
    // an inode dropped on EEXIST. Displacement during release is residual too (1255).
    if (![PATH, `${PATH}.displaced`].some((name) => fs.peek(name)?.ino === actor.publicationIno)) {
      actor.everResidual = true;
    }
  }
}

function retainedActor(f: ReturnType<typeof fixture>, pid: number): Actor {
  return { pid, options: f.options(pid), racer: f.acquire(pid), phase: "acquiring", attempts: 0 };
}

function executeRetainedSchedule(seed: number, trace: string[]): void {
  const f = retainedFixture();
  const random = new SeededRandom(seed);
  const holder = retainedActor(f, 101);
  holder.phase = "holding";
  holder.publicationIno = f.fs.peek(`${PATH}.displaced`)?.ino;
  // At least dozens of holder picks, or until all contenders finish on every fourth seed.
  holder.holdPicks = seed % 4 === 0 ? 10000 : 30 + Math.floor(random.next() * 100);
  const context: RetainedContext = {
    seed,
    random,
    f,
    trace,
    faultStreaks: new Map(),
    actors: [holder, ...[202, 303, 404].map((pid) => retainedActor(f, pid))],
  };
  scheduleRetainedActors(context);
  f.fs.failure = undefined;
  // A second real displacement after setup: read an owner's P before a takeover frees it.
  // This releaser's rename can now claim a later publication and exercise restore failures/F1.
  try {
    addStaleReleaser(context);
    scheduleRetainedActors(context);
    finishRetainedSchedule(context);
  } catch (error) {
    trace.push(
      `FINAL ACTORS ${JSON.stringify(
        context.actors.map((a) => ({
          pid: a.pid,
          phase: a.phase,
          publicationIno: a.publicationIno,
          everResidual: a.everResidual,
          releaseReturned: a.releaseReturned,
          backOutReturned: a.backOutReturned,
          publicationCopies: [...(a.publicationCopies ?? [])],
          failedRetainMarkers: [...(a.failedRetainMarkers ?? [])],
        })),
      )}`,
    );
    trace.push(
      `FINAL PATHS ${JSON.stringify(f.fs.paths().map((name) => ({ name, ...f.fs.peek(name) })))}`,
    );
    throw error;
  }
}

function addStaleReleaser(context: RetainedContext): void {
  const { f, actors, random, trace } = context;
  // Clear crash remnants under the usual guarded reclaim before starting the next event.
  f.clock.advanceTime(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
  f.live.add(808);
  expect(f.acquire(808).finish()).toBe(true);
  const stale = retainedActor(f, 808);
  stale.phase = "releasing";
  stale.staleRelease = true;
  stale.racer = new Racer(releaseExclusiveLockSteps(PATH, 808, "owner-808", f.fs));
  stale.racer.until((step) => step.op === "rename" && step.path === PATH);
  f.live.add(707);
  expect(takeOverExclusiveLock(PATH, { pid: 808, token: "owner-808" }, f.options(707))).toBe(true);
  new Racer(releaseExclusiveLockSteps(PATH, 707, "owner-707", f.fs)).finish();
  trace.push("808 STALE RELEASE: read predates next publication");
  actors.push(stale);
  for (const pid of [909, 1001, 1101]) {
    f.live.add(pid);
    const actor = retainedActor(f, pid);
    actor.holdPicks = 10 + Math.floor(random.next() * 40);
    actors.push(actor);
  }
}

function setRetainedFailures(context: RetainedContext): void {
  const { random, f } = context;
  const linkFails = random.next() < 0.45;
  const copyFails = random.next() < 0.65;
  const readFails = random.next() < 0.03;
  const renameFails = random.next() < 0.03;
  f.fs.failure = (op, path) => {
    if (op === "link" && linkFails) {
      return "ENOTSUP";
    }
    if (op === "openExclusive" && path === PATH && copyFails) {
      return "ENOSPC";
    }
    if (op === "readText" || op === "rename") {
      const key = `${op}:${path}`;
      const streak = context.faultStreaks.get(key) ?? 0;
      const fails = (op === "readText" ? readFails : renameFails) && streak < 2;
      context.faultStreaks.set(key, fails ? streak + 1 : 0);
      if (fails) {
        const code = op === "readText" ? "EIO" : "EBUSY";
        context.trace.push(`FAULT ${code} ${op} ${path}`);
        return code;
      }
    }
    return undefined;
  };
}

function pickRetainedActor(context: RetainedContext): Actor | undefined {
  const active = context.actors.filter((a) => a.phase !== "finished" && a.phase !== "crashed");
  const runnable = active.filter((a) => {
    // Do not spend the stale read until a successor has actually published at P.
    if (!a.staleRelease || a.racer.trace.some((s) => s.op === "rename")) {
      return true;
    }
    return context.f.fs.peek(PATH) !== undefined;
  });
  if (!runnable.length && active.length) {
    return active[0]; // Everyone finished without publication: let the stale release observe ENOENT.
  }
  return runnable.length ? context.random.pick(runnable) : undefined;
}

function scheduleRetainedActors(context: RetainedContext): void {
  const { seed, random, f, actors, trace } = context;
  for (let count = 0; count < 6000; count++) {
    const actor = pickRetainedActor(context);
    if (!actor) {
      return;
    }
    if (actor.phase === "holding" && shouldKeepHolding(actor, actors)) {
      continue;
    }
    trace.push(`${actor.pid} ${actor.phase} ${JSON.stringify(actor.racer.pending.value)}`);
    if (seed % 2 === 1 && !actor.staleRelease && random.next() < 0.015) {
      actor.phase = "crashed";
      f.live.delete(actor.pid);
      trace.push(`${actor.pid} CRASH`);
    } else {
      setRetainedFailures(context);
      checkMutation(actor, f, actors, true, true);
    }
    recordResiduals(f.fs, actors);
    assertBelievers(f.fs, actors);
    assertReleasedActors(f.fs, actors);
  }
  throw new Error("Retained scheduler exceeded step budget");
}

function shouldKeepHolding(actor: Actor, actors: Actor[]): boolean {
  if (!actors.some((a) => a.phase === "acquiring")) {
    return false;
  }
  actor.holdPicks ??= 30;
  return actor.holdPicks-- > 0;
}

function assertReleasedActors(fs: FakeLockFileSystem, actors: Actor[]): void {
  for (const actor of actors.filter((a) => a.releaseReturned && !a.everResidual)) {
    if ([PATH, `${PATH}.displaced`].some((name) => fs.peek(name)?.raw === actorRaw(actor))) {
      throw new Error(`released lock resurrected: ${actor.pid}`);
    }
  }
}

function finishRetainedSchedule(context: RetainedContext): void {
  const { f, actors } = context;
  f.fs.failure = undefined;
  assertReleasedActors(f.fs, actors);
  // A live residual owner can miss its private publication during release; if a
  // displacer restored it after release (including an acquirer's owner back-out),
  // release it once on that owner's behalf so
  // the final fresh acquirer can win. Only this documented resurrection needs cleanup.
  for (const actor of actors.filter(
    (a) =>
      (a.releaseReturned || a.backOutReturned) &&
      a.everResidual &&
      f.live.has(a.pid) &&
      [PATH, `${PATH}.displaced`].some((name) => f.fs.peek(name)?.raw === actorRaw(a)),
  )) {
    new Racer(releaseExclusiveLockSteps(PATH, actor.pid, actor.options.ownerToken, f.fs)).finish();
  }
  if (actors.every((actor) => actor.phase !== "crashed")) {
    expect(
      f.fs.paths().every((name) => {
        const node = f.fs.peek(name);
        return actors.some(
          (a) =>
            (isPrivateMarker(name) && a.failedRetainMarkers?.get(name) === node?.ino) ||
            (a.everResidual && publicationNames(f.fs, a, true).includes(name)),
        );
      }),
    ).toBe(true);
  }
  f.clock.advanceTime(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
  f.live.add(505);
  let acquired = false;
  for (let attempt = 0; attempt < 6 && !acquired; attempt++) {
    acquired = tryAcquireExclusiveLock(PATH, f.options(505));
  }
  expect(acquired).toBe(true);
  exactHolder(f.fs, 505);
}
