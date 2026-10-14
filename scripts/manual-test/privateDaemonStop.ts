// Harness modules never import the product logger; returned identity reasons are the trace.
import { z } from "zod";
import type { PrivateDaemonCliDeps } from "./private-daemon";
import type { PrivateDaemonBatchOptions, PrivateDaemonSpec } from "./privateDaemonEnv";
import { privateClientEnvironment } from "./privateDaemonEnv";
import { harnessChildEnvironment } from "./harnessLogSink";
import { errorMessage } from "../../src/utils/describeUnknownError";

export type StopOutcome = "stopped" | "still-alive" | "gone-before-signal";
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
      identity.data.reportedSocketPath !== undefined &&
      identity.data.reportedSocketPath !== spec.socketPath
    ) {
      return "ide/status socket path mismatch";
    }
    if (
      identity.data.reportedPidFilePath !== undefined &&
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
): Promise<StopResult> {
  const result: StopResult = {
    name: spec.name,
    pid,
    outcome: "gone-before-signal",
    via: "none",
    identity: "confirmed",
  };
  if (!deps.isPidAlive(pid)) {
    return result;
  }
  result.via = "signal";
  try {
    deps.signalPid(pid, "SIGTERM");
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
  return { ...result, outcome: stopOutcome(true, deps.isPidAlive(pid)), waitedMs };
}
export async function privateDaemonStop(
  spec: PrivateDaemonSpec,
  options: PrivateDaemonBatchOptions,
  waitMs: number,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
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
    const identity = await confirmIdentity(spec, pid, deps);
    result =
      identity === "confirmed"
        ? await signalAndWait(spec, pid, waitMs, deps)
        : await delegateStop(spec, options, pid, identity, deps);
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
