/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ambient {@link PerformanceTracker} propagation.
 *
 * The device-lifecycle handlers (getAndroid/getApple/provisionDevice and the
 * install/launch/terminate/kill app + device tools) already build a
 * `PerformanceTracker` and thread it explicitly through their own call graph.
 * But the platform CLI wrappers they eventually invoke -- adb, emulator
 * console, avdmanager, sdkmanager, simctl, xcodebuild -- sit many layers down
 * behind narrow interfaces, and threading a tracker through every one of those
 * signatures would be enormous churn.
 *
 * This module mirrors the existing {@link module:utils/AbortContext} idiom: a
 * handler establishes the tracker for the duration of its work with
 * {@link runWithPerfTracker}, and any code beneath it -- at any depth, across
 * any interface boundary -- reads the same instance with {@link getPerfTracker}
 * and records command spans into the one shared timing tree. Code that runs
 * with no ambient tracker (unit tests, non-lifecycle paths) transparently gets
 * a shared {@link NoOpPerformanceTracker}, so instrumentation is a no-op by
 * default and never throws.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isDebugPerfEnabled,
  NoOpPerformanceTracker,
  type PerformanceTracker,
} from "./PerformanceTracker";

const perfContext = new AsyncLocalStorage<PerformanceTracker>();

/**
 * Shared no-op returned when no tracker is in scope. It is stateless -- every
 * method is a pass-through -- so a single instance is safe to share across all
 * callers and concurrent work.
 */
const noOpTracker: PerformanceTracker = new NoOpPerformanceTracker();

/**
 * Run `fn` with `tracker` as the ambient performance tracker. Nested calls
 * replace the ambient tracker for their own scope only; the previous tracker is
 * restored when `fn` settles.
 */
export function runWithPerfTracker<T>(
  tracker: PerformanceTracker,
  fn: () => Promise<T>,
): Promise<T> {
  return perfContext.run(tracker, fn);
}

/**
 * The tracker currently in scope, or a shared no-op when none is established.
 * Never returns undefined, so callers can record unconditionally.
 */
export function getPerfTracker(): PerformanceTracker {
  return perfContext.getStore() ?? noOpTracker;
}

/**
 * Gate an always-on tracker behind `--debug-perf` for ambient use.
 *
 * The device-lifecycle handlers build an always-on tracker
 * (`createPerformanceTracker(true)`) whose timings are emitted RAW on the
 * response — without the zero-filter and 50KB cap `processTimingData` applies.
 * Establishing that tracker as ambient would let every adb/simctl command a cold
 * boot issues (hundreds of `adb shell getprop` probes) land on the hottest
 * acquisition responses regardless of `--debug-perf`, against the
 * output-context reduction program. So the fine-grained ambient span layer only
 * turns on with `--debug-perf`; the explicit threaded spans are unaffected.
 *
 * Trackers created with `createGlobalPerformanceTracker` are already a no-op
 * when `--debug-perf` is off and do not need this gate, but passing them through
 * is harmless (a no-op stays a no-op).
 */
export function ambientPerfFor(tracker: PerformanceTracker): PerformanceTracker {
  return isDebugPerfEnabled() ? tracker : noOpTracker;
}

/**
 * Record a single command span against the ambient tracker.
 *
 * The ambient tracker is `fork()`ed first so the span is anchored to the block
 * that is current right now and appended to that shared parent, without letting
 * concurrent commands running under the same ambient tracker move each other's
 * cursor or pop a block a sibling opened (see {@link PerformanceTracker.fork}
 * and issue #6706). A no-op tracker's `fork()` returns itself, so this stays
 * zero-overhead when no tracking is in scope.
 *
 * Each ambient span is a leaf: an engine phase span and the CLI command spans it
 * issues are recorded as flat siblings in the same block, so their durations can
 * overlap (a `readiness:runner-setup` span and the `adb`/`simctl` spans issued
 * inside it sit side by side, not nested). This is deliberate for the debug-only
 * `--debug-perf` layer; do not read the serial-array ordering here as strictly
 * sequential the way explicitly-opened `serial()` blocks are.
 */
export function trackAmbient<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return getPerfTracker().fork().track(name, fn);
}
