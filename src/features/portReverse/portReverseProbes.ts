import type { AdbReverseCommands } from "../../utils/android-cmdline-tools/adbReverse";
import { rethrowDeviceTransportUnavailable } from "../../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import type { PortHttpProbeOutcome } from "../../utils/android-cmdline-tools/portHttpProbe";
import type { PortProbeOutcome } from "../../utils/android-cmdline-tools/adbReverse";
import { DeviceLostError } from "../../models/DeviceLostError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";

/** An HTTP request `verify` sends from the device through each mapping, and what must come back. */
export interface PortReverseHttpProbe {
  /** Request target, e.g. `/metadata`. */
  path: string;
  /** Statuses that count as reachable. */
  expectStatus: readonly number[];
  /** `Host` header; default `localhost:<devicePort>`. */
  hostHeader?: string;
  /** Text the response body must contain. */
  expectBodyContains?: string;
  /** How long the device waits for the response, rounded up to whole seconds. */
  timeoutMs?: number;
}

/** Per-port bound on a TCP verify probe; ports are probed concurrently, so this bounds the call. */
export const PORT_PROBE_TIMEOUT_MS = 2500;
/** A peer that closes at once is asked again once: the first connect after a host restart can race. */
const PORT_PROBE_ATTEMPTS = 2;

export const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 2000;
/** Host-side slack on the whole HTTP probe beyond the device-side timeout. */
const HTTP_PROBE_DEADLINE_SLACK_MS = 1500;
/** A peer that closes without answering is asked again once, as the TCP probe does. */
const HTTP_PROBE_ATTEMPTS = 2;

/** A probe's part of a mapping's result. */
export interface ProbeVerdict {
  status: "reachable" | "unreachable" | "probe_unsupported";
  probeReason?:
    | "http_status"
    | "http_body"
    | "no_http_response"
    | "closed"
    | "refused"
    | "timeout"
    | "unsupported";
  probeDetail?: string;
  httpStatus?: number;
}

function judge(outcome: PortHttpProbeOutcome, spec: PortReverseHttpProbe): ProbeVerdict {
  switch (outcome.kind) {
    case "response": {
      const httpStatus = outcome.status;
      if (!spec.expectStatus.includes(httpStatus)) {
        return { status: "unreachable", probeReason: "http_status", httpStatus };
      }
      if (
        spec.expectBodyContains !== undefined &&
        !outcome.body.includes(spec.expectBodyContains)
      ) {
        return { status: "unreachable", probeReason: "http_body", httpStatus };
      }
      return { status: "reachable", httpStatus };
    }
    case "no_response":
      return {
        status: "unreachable",
        probeReason: "no_http_response",
        probeDetail: outcome.detail,
      };
    case "timeout":
      return { status: "unreachable", probeReason: "timeout" };
    case "refused":
      return { status: "unreachable", probeReason: "refused" };
    case "unsupported":
      return {
        status: "probe_unsupported",
        probeReason: "unsupported",
        probeDetail: outcome.detail,
      };
  }
}

/**
 * Sends `spec` from the device to `127.0.0.1:<devicePort>` and judges the response. A probe that
 * fails or outlives its deadline is `unreachable` with reason `timeout`; device loss propagates.
 */
export async function httpProbePort(
  adb: Pick<AdbReverseCommands, "httpProbe">,
  pass: ProbePass,
  spec: PortReverseHttpProbe,
): Promise<ProbeVerdict> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_HTTP_PROBE_TIMEOUT_MS;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const request = {
    path: spec.path,
    timeoutSeconds,
    ...(spec.hostHeader === undefined ? {} : { hostHeader: spec.hostHeader }),
  };
  let verdict: ProbeVerdict = { status: "unreachable", probeReason: "timeout" };
  for (let attempt = 1; attempt <= HTTP_PROBE_ATTEMPTS; attempt++) {
    try {
      const outcome = await raceWithDeadline(() => adb.httpProbe(pass.devicePort, request), {
        timer: pass.timer,
        timeoutMs: timeoutSeconds * 1000 + HTTP_PROBE_DEADLINE_SLACK_MS,
        label: `portReverse HTTP probe tcp:${pass.devicePort}`,
        unref: true,
      });
      verdict = judge(outcome, spec);
    } catch (error) {
      if (error instanceof DeviceLostError) {
        throw error;
      }
      rethrowDeviceTransportUnavailable(error);
      // A probe that hangs or fails says nothing about the mapping beyond "no answer".
      logger.warn(
        `[portReverse] HTTP probe of tcp:${pass.devicePort} on ${pass.deviceId} failed: ${errorMessage(error)}`,
      );
      return { status: "unreachable", probeReason: "timeout" };
    }
    if (verdict.probeReason !== "no_http_response") {
      return verdict;
    }
  }
  return verdict;
}

interface ProbePass {
  deviceId: string;
  devicePort: number;
  timer: Timer;
}

/** The outcome of one bounded TCP probe, or a verdict when it failed or timed out. */
async function tcpProbeOnce(
  adb: Pick<AdbReverseCommands, "probe">,
  pass: ProbePass,
): Promise<PortProbeOutcome | ProbeVerdict> {
  try {
    return await raceWithDeadline(() => adb.probe(pass.devicePort), {
      timer: pass.timer,
      timeoutMs: PORT_PROBE_TIMEOUT_MS,
      label: `portReverse probe tcp:${pass.devicePort}`,
      unref: true,
    });
  } catch (error) {
    if (error instanceof DeviceLostError) {
      throw error;
    }
    rethrowDeviceTransportUnavailable(error);
    // A probe that hangs or fails says nothing about the mapping beyond "no answer".
    logger.warn(
      `[portReverse] probe of tcp:${pass.devicePort} on ${pass.deviceId} failed: ${errorMessage(error)}`,
    );
    return { status: "unreachable", probeReason: "timeout" };
  }
}

/**
 * Connects from the device to `127.0.0.1:<devicePort>`: `reachable` when the host kept the
 * connection open, else `unreachable` or `probe_unsupported` with the reason.
 */
export async function tcpProbePort(
  adb: Pick<AdbReverseCommands, "probe">,
  pass: ProbePass,
): Promise<ProbeVerdict> {
  for (let attempt = 1; attempt <= PORT_PROBE_ATTEMPTS; attempt++) {
    const outcome = await tcpProbeOnce(adb, pass);
    if ("status" in outcome) {
      return outcome;
    }
    if (outcome.kind === "held") {
      return { status: "reachable" };
    }
    if (outcome.kind === "refused") {
      return { status: "unreachable", probeReason: "refused" };
    }
    if (outcome.kind === "unsupported") {
      return {
        status: "probe_unsupported",
        probeReason: "unsupported",
        probeDetail: outcome.detail,
      };
    }
  }
  return { status: "unreachable", probeReason: "closed" };
}
