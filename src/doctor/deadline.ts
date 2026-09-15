/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DoctorProbeOptions } from "./types";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

export class DoctorDeadlineError extends Error {
  constructor() {
    super("Doctor diagnostic deadline elapsed");
    this.name = "DoctorDeadlineError";
  }
}

export interface DoctorDeadline {
  probe: DoctorProbeOptions;
  dispose(): void;
}

function resolveDeadline(options: DoctorProbeOptions, timer: Timer): number | undefined {
  return (
    options.deadlineMs ??
    (options.timeoutMs === undefined ? undefined : timer.now() + options.timeoutMs)
  );
}

function createDeadlineSignal(
  options: DoctorProbeOptions,
  timer: Timer,
  deadlineMs: number | undefined,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const remainingMs = deadlineMs === undefined ? undefined : deadlineMs - timer.now();
  if (remainingMs !== undefined && remainingMs <= 0) {
    controller.abort(new DoctorDeadlineError());
    return { signal, dispose: () => {} };
  }
  const timeout =
    remainingMs === undefined
      ? undefined
      : timer.setTimeout(() => controller.abort(new DoctorDeadlineError()), remainingMs);
  return {
    signal,
    dispose: () => {
      if (timeout !== undefined) {
        timer.clearTimeout(timeout);
      }
    },
  };
}

/**
 * Own one absolute budget for a doctor invocation. Every child probe receives
 * this signal and derives its timeout from the same deadline instead of
 * restarting the original timeout for each subprocess or device read.
 */
export function createDoctorDeadline(
  options: DoctorProbeOptions,
  timer: Timer = options.timer ?? defaultTimer,
): DoctorDeadline {
  const deadlineMs = resolveDeadline(options, timer);
  const deadline = createDeadlineSignal(options, timer, deadlineMs);

  return {
    probe: {
      signal: deadline.signal,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      timer,
    },
    dispose: deadline.dispose,
  };
}

/** Return the remaining slice of the caller-owned absolute Doctor deadline. */
export function remainingDoctorProbe(options: DoctorProbeOptions = {}): DoctorProbeOptions {
  options.signal?.throwIfAborted();
  if (options.deadlineMs === undefined) {
    return options;
  }

  const remainingMs = options.deadlineMs - (options.timer ?? defaultTimer).now();
  if (remainingMs <= 0) {
    throw new DoctorDeadlineError();
  }
  return {
    ...options,
    timeoutMs: remainingMs,
  };
}
