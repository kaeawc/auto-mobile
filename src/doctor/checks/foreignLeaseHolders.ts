/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { CheckResult } from "../types";

const CHECK_NAME = "CtrlProxy Forwarding Leases";

/** One device's CtrlProxy forwarding-lease holder (lock file PID + owner metadata). */
export interface ForeignLeaseHolder {
  deviceId: string;
  pid: number;
  alive: boolean;
  socketPath?: string;
  acquiredAt?: number;
}

/**
 * Lists CtrlProxy forwarding-lease holders. The production implementation reads
 * the lease lock files introduced by #10506 (`listForwardLeaseHolders`), so the
 * doctor wiring waits for that PR; this seam keeps the check testable meanwhile.
 */
export interface ForwardLeaseHolderLister {
  listHolders(): ForeignLeaseHolder[] | Promise<ForeignLeaseHolder[]>;
}

export interface ForeignLeaseHolderDependencies {
  lister: ForwardLeaseHolderLister;
  selfPid?: number;
  timer?: Timer;
}

function describeHolder(holder: ForeignLeaseHolder, now: number): string {
  const age =
    holder.acquiredAt === undefined
      ? "age unknown"
      : `held ${Math.max(0, Math.round((now - holder.acquiredAt) / 1000))}s`;
  const state = holder.alive ? "process alive" : "process gone (reclaimable)";
  return (
    `- ${holder.deviceId}: PID ${holder.pid}, socket ${holder.socketPath ?? "unknown"}, ` +
    `${age}, ${state}`
  );
}

/** Report devices whose CtrlProxy forwarding lease another process holds. Report-only. */
export async function checkForeignLeaseHolders(
  dependencies: ForeignLeaseHolderDependencies,
): Promise<CheckResult> {
  try {
    const selfPid = dependencies.selfPid ?? process.pid;
    const foreign = (await dependencies.lister.listHolders()).filter(
      (holder) => holder.pid !== selfPid,
    );
    if (foreign.length === 0) {
      return {
        name: CHECK_NAME,
        status: "pass",
        message: "No CtrlProxy forwarding leases held by other processes",
      };
    }
    const now = (dependencies.timer ?? defaultTimer).now();
    return {
      name: CHECK_NAME,
      status: "warn",
      message: `${foreign.length} device(s) have a CtrlProxy forwarding lease held by another process`,
      value: foreign.length,
      detail: foreign.map((holder) => describeHolder(holder, now)).join("\n"),
      recommendation:
        "Stop the holding daemon (see the PID above) or wait for its idle release; " +
        "a lease whose process is gone is reclaimed automatically.",
    };
  } catch (error) {
    logger.warn(`Forwarding lease check failed: ${errorMessage(error)}`, error);
    return {
      name: CHECK_NAME,
      status: "warn",
      message: `Could not read forwarding leases: ${errorMessage(error)}`,
    };
  }
}
