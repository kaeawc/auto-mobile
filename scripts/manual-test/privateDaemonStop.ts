// Harness modules never import the product logger; returned identity reasons are the trace.
import { join } from "node:path";
import { z } from "zod";
import type { PrivateDaemonCliDeps } from "./private-daemon";
import type { PrivateDaemonBatchOptions, PrivateDaemonSpec } from "./privateDaemonEnv";
import {
  privateClientEnvironment,
  privateDaemonBatchRefusal,
  derivePrivateDaemonBatch,
} from "./privateDaemonEnv";
import { harnessChildEnvironment } from "./harnessLogSink";
import { errorMessage } from "../../src/utils/describeUnknownError";

export type StopOutcome = "stopped" | "crashed" | "still-alive" | "gone-before-signal";
export function stopOutcome(signalAttempted: boolean, alive: boolean): StopOutcome {
  if (!signalAttempted) {
    return "gone-before-signal";
  }
  return alive ? "still-alive" : "stopped";
}
const pidSchema = z.object({ pid: z.number().int().positive() });
const identitySchema = pidSchema.extend({
  reportedSocketPath: z.string().optional(),
  reportedPidFilePath: z.string().optional(),
});
const responseSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
interface StopResult {
  name: string;
  pid?: number;
  outcome: StopOutcome;
  via: "signal" | "product-cli" | "none";
  identity?: string;
  waitedMs?: number;
  productExitCode?: number;
}
async function confirmIdentity(
  spec: PrivateDaemonSpec,
  pid: number,
  deps: PrivateDaemonCliDeps,
  strict = false,
): Promise<string> {
  try {
    const response = responseSchema.parse(
      await deps.requestSocket(spec.socketPath, { method: "ide/status", timeoutMs: 5000 }),
    );
    if (!response.success) {
      return response.error ?? "ide/status refused";
    }
    const identity = identitySchema.safeParse(response.result);
    if (!identity.success) {
      return "invalid ide/status identity";
    }
    if (identity.data.pid !== pid) {
      return "ide/status PID mismatch";
    }
    if (
      (strict || identity.data.reportedSocketPath !== undefined) &&
      identity.data.reportedSocketPath !== spec.socketPath
    ) {
      return "ide/status socket path mismatch";
    }
    if (
      (strict || identity.data.reportedPidFilePath !== undefined) &&
      identity.data.reportedPidFilePath !== spec.pidFilePath
    ) {
      return "ide/status pid file path mismatch";
    }
    return "confirmed";
  } catch (error) {
    // A silent/refused socket cannot authorize a signal; delegation retains this diagnostic reason.
    return errorMessage(error);
  }
}
async function signalAndWait(
  spec: PrivateDaemonSpec,
  pid: number,
  waitMs: number,
  deps: PrivateDaemonCliDeps,
  crashIdentity?: string,
): Promise<StopResult> {
  const result: StopResult = {
    name: spec.name,
    pid,
    outcome: "gone-before-signal",
    via: "none",
    identity: crashIdentity ?? "confirmed",
  };
  if (!deps.isPidAlive(pid)) {
    return result;
  }
  result.via = "signal";
  try {
    // Recheck immediately before the one signal; never escalate or signal a process group.
    if (crashIdentity && deps.processGeneration?.compare(pid, crashIdentity) !== "same") {
      throw new Error("Refusing crash: daemon process start identity changed before signal.");
    }
    deps.signalPid(pid, crashIdentity ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    // ESRCH is the expected race between the liveness check and the signal; other I/O errors surface.
    if (z.object({ code: z.literal("ESRCH") }).safeParse(error).success) {
      return result;
    }
    throw error;
  }
  const clock = () => deps.timer.monotonicNow?.() ?? deps.timer.now();
  const startedAt = clock();
  let waitedMs = 0;
  while (deps.isPidAlive(pid) && waitedMs < waitMs) {
    await deps.timer.sleep(Math.min(100, waitMs - waitedMs));
    waitedMs = Math.max(0, clock() - startedAt);
  }
  const alive = deps.isPidAlive(pid);
  return {
    ...result,
    outcome: crashIdentity && !alive ? "crashed" : stopOutcome(true, alive),
    waitedMs,
  };
}
export async function privateDaemonStop(
  spec: PrivateDaemonSpec,
  options: PrivateDaemonBatchOptions,
  waitMs: number,
  deps: PrivateDaemonCliDeps,
  crash = false,
): Promise<number> {
  const refusal = privateDaemonBatchRefusal(derivePrivateDaemonBatch(options), options, deps.host);
  if (refusal) {
    throw new Error(refusal);
  }
  const pid = deps.exists(spec.pidFilePath)
    ? pidSchema.parse(JSON.parse(deps.readFile(spec.pidFilePath))).pid
    : undefined;
  let result: StopResult = {
    name: spec.name,
    ...(pid === undefined ? {} : { pid }),
    outcome: "gone-before-signal",
    via: "none",
  };
  if (pid !== undefined && deps.isPidAlive(pid)) {
    const identity = await confirmIdentity(spec, pid, deps, crash);
    if (crash) {
      if (identity !== "confirmed") {
        throw new Error(`Refusing crash: ${identity}`);
      }
      const path = join(spec.dir, "daemon-start.json");
      if (!deps.exists(path)) {
        throw new Error("Refusing crash: no recorded daemon start identity.");
      }
      const recorded = z
        .object({
          pid: z.literal(pid),
          socketPath: z.literal(spec.socketPath),
          pidFilePath: z.literal(spec.pidFilePath),
          startIdentity: z.string().min(1),
        })
        .safeParse(JSON.parse(deps.readFile(path)));
      if (!recorded.success) {
        throw new Error("Refusing crash: missing or mismatched recorded daemon start identity.");
      }
      if (deps.processGeneration?.compare(pid, recorded.data.startIdentity) !== "same") {
        throw new Error("Refusing crash: daemon process start identity mismatch or unavailable.");
      }
      result = await signalAndWait(spec, pid, waitMs, deps, recorded.data.startIdentity);
    } else {
      result =
        identity === "confirmed"
          ? await signalAndWait(spec, pid, waitMs, deps)
          : await delegateStop(spec, options, pid, identity, deps);
    }
  }
  deps.log(JSON.stringify(result));
  if (result.outcome === "still-alive") {
    return 1;
  }
  deps.removeFile(spec.plainPidFilePath);
  return 0;
}
async function delegateStop(
  spec: PrivateDaemonSpec,
  options: PrivateDaemonBatchOptions,
  pid: number,
  identity: string,
  deps: PrivateDaemonCliDeps,
): Promise<StopResult> {
  const product = await deps.runCommand(
    deps.runtimePath,
    [options.serverPath, "--daemon", "stop"],
    privateClientEnvironment(harnessChildEnvironment(deps.env, deps.logSinkOverride), spec.env),
  );
  return {
    name: spec.name,
    pid,
    outcome: stopOutcome(true, deps.isPidAlive(pid)),
    via: "product-cli",
    identity,
    productExitCode: product.exitCode,
  };
}
