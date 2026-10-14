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
  hasPendingBackOut,
  releaseExclusiveLock,
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
  // One fs object per process INCARNATION: the lock keeps pending back-outs per fs object, so a
  // shared object would let one "process" drain another's (a reopen shares its owner's options).
  const process = (pid: number): ExclusiveLockOptions => ({
    ...options(pid),
    fileSystem: fs.view(),
  });
  return { fs, live, options, acquire, clock, process };
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
  reopenOwner?: Actor;
  reopened?: boolean;
  /** Inodes this actor published by legacy wx (no hard link at its publish). */
  legacyPublications?: Set<number>;
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
    actor.racer = new Racer(
      releaseExclusiveLockSteps(PATH, actor.pid, `owner-${actor.pid}`, actor.options.fileSystem),
    );
  }
  try {
    actor.racer.advance();
  } catch (error) {
    if (!ioFailureIsAttempt || !(error instanceof ActionableError) || actor.phase !== "acquiring") {
      throw error;
    }
    if (actor.reopenOwner) {
      finishReopen(actor, f.fs);
    } else {
      retryActor(actor);
    }
    return;
  }
  if (!actor.racer.pending.done) {
    return;
  }
  if (actor.reopenOwner) {
    expect(actor.racer.pending.value).toBe(false);
    finishReopen(actor, f.fs);
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

function finishReopen(actor: Actor, fs: FakeLockFileSystem): void {
  const owner = actor.reopenOwner!;
  expect(
    [PATH, `${PATH}.displaced`].some((name) => {
      const node = fs.peek(name);
      return node?.ino === owner.publicationIno && node?.raw === actorRaw(owner);
    }),
  ).toBe(true);
  actor.phase = "finished";
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
    const options = { ...f.process(pid), reclaimOwnPid: kind === 3 && pid === 101 };
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
      ...f.process(707),
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
      const options = f.process(606);
      actors.push({
        pid: 606,
        options,
        racer: new Racer(acquireExclusiveLockSteps(PATH, options)),
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
    acquired = tryAcquireExclusiveLock(PATH, f.process(505));
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
        .filter(
          (name) =>
            !trackResiduals ||
            other.publicationIno === undefined ||
            f.fs.peek(name)?.ino === other.publicationIno ||
            other.publicationCopies?.has(f.fs.peek(name)!.ino),
        )
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
    ((previous?.op === "readText" && previous.path === `${PATH}.displaced`) ||
      (previous?.op === "stat" && previous.path.endsWith(".tmp"))) &&
    f.fs.peek(`${PATH}.displaced`)?.ino === actor.publicationIno &&
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
    actor.restoreOwner = actors.findLast(
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
    // belongs to the publishing actor, including a reopen, never its identical-bytes owner.
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
    !actor.restoreOwner &&
    pathWasAbsent &&
    f.fs.peek(PATH) &&
    operations.some((op) => op.path === PATH && ["link", "openExclusive"].includes(op.op)) &&
    (f.fs.peek(PATH)?.raw === actorRaw(actor) ||
      (f.fs.peek(PATH)?.raw === "" && !actor.restoreOwner))
  ) {
    actor.publicationIno = f.fs.peek(PATH)?.ino;
    if (
      actor.publicationIno !== undefined &&
      operations.some((op) => op.path === PATH && op.op === "openExclusive")
    ) {
      // Legacy wx publication: no hard link, so no identity proof (spec-fix8 self-block).
      (actor.legacyPublications ??= new Set()).add(actor.publicationIno);
    }
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
  const options = f.process(pid);
  const racer = new Racer(acquireExclusiveLockSteps(PATH, options));
  return { pid, options, racer, phase: "acquiring", attempts: 0 };
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
  try {
    scheduleRetainedActors(context);
    f.fs.failure = undefined;
    // A second real displacement after setup: read an owner's P before a takeover frees it.
    // This releaser's rename can now claim a later publication and exercise restore failures/F1.
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
          legacyPublications: [...(a.legacyPublications ?? [])],
          pendingBackOut: a.options.fileSystem && hasPendingBackOut(a.options.fileSystem, PATH),
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
  stale.racer = new Racer(
    releaseExclusiveLockSteps(PATH, 808, "owner-808", stale.options.fileSystem),
  );
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

function setRetainedFailures(context: RetainedContext, actor: Actor): void {
  const { random, f } = context;
  // Actors are only appended; a reopen has its own index even when its PID matches.
  const actorIndex = context.actors.indexOf(actor);
  const linkFails = random.next() < 0.45;
  const restoreLinkFails = f.fs.peek(`${PATH}.displaced`) !== undefined && random.next() < 0.3;
  const copyFails = random.next() < 0.65;
  const readFails = random.next() < 0.03;
  const renameFails = random.next() < 0.03;
  f.fs.failure = (op, path) => {
    if (op === "link" && (linkFails || (path === PATH && actor.restoreOwner && restoreLinkFails))) {
      return "ENOTSUP";
    }
    if (op === "openExclusive" && path === PATH && copyFails) {
      return "ENOSPC";
    }
    if (op === "readText" || op === "rename") {
      const key = `${actorIndex}:${op}:${path}`;
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
    if (actor.phase === "holding") {
      maybeReopen(context, actor);
      if (shouldKeepHolding(actor, actors)) {
        continue;
      }
    }
    trace.push(`${actor.pid} ${actor.phase} ${JSON.stringify(actor.racer.pending.value)}`);
    if (seed % 2 === 1 && !actor.staleRelease && !actor.reopenOwner && random.next() < 0.015) {
      actor.phase = "crashed";
      f.live.delete(actor.pid);
      trace.push(`${actor.pid} CRASH`);
    } else {
      setRetainedFailures(context, actor);
      checkMutation(actor, f, actors, true, true);
    }
    recordResiduals(f.fs, actors);
    assertBelievers(f.fs, actors);
    assertReleasedActors(f.fs, actors);
  }
  throw new Error("Retained scheduler exceeded step budget");
}

function maybeReopen(context: RetainedContext, owner: Actor): void {
  if (
    owner.reopened ||
    owner.everResidual ||
    owner.publicationIno === undefined ||
    context.f.fs.peek(`${PATH}.displaced`)?.ino !== owner.publicationIno ||
    context.random.next() >= 0.2
  ) {
    return;
  }
  owner.reopened = true;
  // Identical options deliberately have no per-acquisition nonce (#2947).
  const reopen = retainedActor(context.f, owner.pid);
  reopen.options = owner.options;
  reopen.racer = new Racer(acquireExclusiveLockSteps(PATH, reopen.options));
  reopen.reopenOwner = owner;
  context.actors.push(reopen);
  context.trace.push(`${owner.pid} REOPEN while holding inode ${owner.publicationIno}`);
}

function shouldKeepHolding(actor: Actor, actors: Actor[]): boolean {
  if (actors.some((a) => a.reopenOwner === actor && a.phase === "acquiring")) {
    return true;
  }
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

function isNamed(fs: FakeLockFileSystem, actor: Actor): boolean {
  return [PATH, `${PATH}.displaced`].some((name) => fs.peek(name)?.raw === actorRaw(actor));
}

/** The documented legacy self-block (spec-fix8): a wx publication, never provably ours, retained at F. */
function isLegacySelfBlock(fs: FakeLockFileSystem, actor: Actor): boolean {
  const retained = fs.peek(`${PATH}.displaced`);
  return retained !== undefined && actor.legacyPublications?.has(retained.ino) === true;
}

/** A reopen shares the owner's bytes, so only its own publication identities name a non-holder. */
function isNamedNonHolder(fs: FakeLockFileSystem, actor: Actor): boolean {
  if (!actor.reopenOwner) {
    return isNamed(fs, actor);
  }
  return [PATH, `${PATH}.displaced`].some((name) => {
    const node = fs.peek(name);
    return (
      node !== undefined &&
      (node.ino === actor.publicationIno || actor.publicationCopies?.has(node.ino) === true)
    );
  });
}

function retryNonHolder(actor: Actor): void {
  if (tryAcquireExclusiveLock(PATH, actor.options)) {
    releaseExclusiveLock(PATH, actor.pid, actor.options.ownerToken, actor.options.fileSystem);
  }
}

function finishRetainedSchedule(context: RetainedContext): void {
  const { f, actors } = context;
  f.fs.failure = undefined;
  assertReleasedActors(f.fs, actors);
  const live = actors.filter((a) => f.live.has(a.pid) && a.phase !== "crashed");
  // C5 includes reopens and runs BEFORE an on-behalf release can hide identical doomed bytes.
  const toldFalse = live.filter((a) => !a.releaseReturned);
  for (const actor of toldFalse.filter((a) => isNamedNonHolder(f.fs, a))) {
    if (
      !isLegacySelfBlock(f.fs, actor) &&
      (!actor.options.fileSystem || !hasPendingBackOut(actor.options.fileSystem, PATH))
    ) {
      throw new Error(`live non-holder ${actor.pid} is named with no pending back-out`);
    }
  }
  // Consult a reopen's own pending entries before its R2 owner's identical-bytes release.
  for (const actor of toldFalse.filter((a) => a.reopenOwner)) {
    retryNonHolder(actor);
  }
  // The ONLY two releases made on an actor's behalf, both documented residuals:
  // R2 — a holder whose release missed its privately displaced publication, restored afterwards;
  // legacy self-block — a doomed wx publication (no identity proof) retained at F.
  for (const actor of live.filter(
    (a) =>
      isNamed(f.fs, a) && ((a.releaseReturned && a.everResidual) || isLegacySelfBlock(f.fs, a)),
  )) {
    releaseExclusiveLock(PATH, actor.pid, actor.options.ownerToken, actor.options.fileSystem);
  }
  // Every other non-holder makes one more real attempt with its original options.
  for (const actor of toldFalse.filter((a) => !a.reopenOwner)) {
    retryNonHolder(actor);
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
  const fresh = f.process(505);
  let acquired = false;
  for (let attempt = 0; attempt < 6 && !acquired; attempt++) {
    acquired = tryAcquireExclusiveLock(PATH, fresh);
  }
  if (!acquired) {
    const stuck = live
      .filter((a) => isNamed(f.fs, a))
      .map((a) => {
        const at = [PATH, `${PATH}.displaced`].filter((n) => f.fs.peek(n)?.raw === actorRaw(a));
        const kind = at.some((n) => a.legacyPublications?.has(f.fs.peek(n)!.ino))
          ? "legacy"
          : at.some((n) => a.publicationCopies?.has(f.fs.peek(n)!.ino))
            ? "copy"
            : "atomic";
        return `${a.pid}/${kind}/released=${!!a.releaseReturned}/at=${at.map((n) => (n === PATH ? "P" : "F")).join("+")}`;
      });
    throw new Error(`STUCK ${stuck.join(";")}`);
  }
  exactHolder(f.fs, 505);
}
