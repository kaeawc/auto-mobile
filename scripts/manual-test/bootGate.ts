// Harness locking and time are injected; command failures surface at the CLI boundary.
import { join } from "node:path";
import { z } from "zod";
import { definedEnv } from "./privateDaemonStatus";
import { harnessChildEnvironment } from "./harnessLogSink";
import type { PrivateDaemonCliDeps } from "./private-daemon";

export interface BootGateCommand {
  op: "boot-gate";
  batchDir: string;
  role: string;
  maxConcurrent: number;
  maxLoad?: number;
  minIntervalMs: number;
  timeoutMs: number;
  pollMs: number;
  command: string[];
}
export const BOOT_GATE_FLAGS = [
  "--batch-dir",
  "--role",
  "--max-concurrent",
  "--max-load",
  "--min-interval-ms",
  "--timeout-ms",
  "--poll-ms",
];
function integerFlag(
  values: Record<string, string>,
  flag: string,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = values[flag];
  const value = Number(raw ?? fallback);
  if (
    (raw !== undefined && !/^\d+$/.test(raw)) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${flag} must be an integer in ${min}..${max}.`);
  }
  return value;
}
export function bootGateOptions(
  values: Record<string, string>,
  command: string[],
): BootGateCommand | { error: string } {
  try {
    const role = values["--role"];
    if (!role || !/^[A-Za-z0-9._-]{1,64}$/.test(role)) {
      throw new Error("--role must match ^[A-Za-z0-9._-]{1,64}$.");
    }
    const rawLoad = values["--max-load"];
    const maxLoad = rawLoad === undefined ? undefined : Number(rawLoad);
    if (maxLoad !== undefined && (!Number.isFinite(maxLoad) || maxLoad <= 0)) {
      throw new Error("--max-load must be a positive number.");
    }
    return {
      op: "boot-gate",
      batchDir: values["--batch-dir"],
      role,
      command,
      maxConcurrent: integerFlag(values, "--max-concurrent", 1, 1, 8),
      maxLoad,
      minIntervalMs: integerFlag(values, "--min-interval-ms", 30000, 0),
      timeoutMs: integerFlag(values, "--timeout-ms", 600000, 1),
      pollMs: integerFlag(values, "--poll-ms", 2000, 1),
    };
  } catch (error) {
    // Invalid flags are returned as usage errors, with their reason intact.
    return { error: error instanceof Error ? error.message : "Invalid boot-gate flags." };
  }
}
const grantSchema = z.object({ at: z.number().finite(), role: z.string() });
function lastGrant(path: string, deps: PrivateDaemonCliDeps): number | undefined {
  try {
    if (!deps.exists(path)) {
      return undefined;
    }
    const parsed = grantSchema.safeParse(JSON.parse(deps.readFile(path)));
    return parsed.success ? parsed.data.at : undefined;
  } catch (error) {
    // Missing/corrupt last-grant state is explicitly treated as no previous grant.
    return undefined;
  }
}
function acquirePermit(
  root: string,
  command: BootGateCommand,
  deps: PrivateDaemonCliDeps,
): number | undefined {
  for (let permit = 0; permit < command.maxConcurrent; permit++) {
    if (deps.bootLock.tryAcquire(join(root, `permit-${permit}.lock`), command.role)) {
      return permit;
    }
  }
  return undefined;
}
function waitingFor(
  permit: number | undefined,
  load: number,
  maxLoad: number,
  intervalReady: boolean,
): "permit" | "load" | "interval" | undefined {
  if (permit === undefined) {
    return "permit";
  }
  if (!(load < maxLoad)) {
    return "load";
  }
  return intervalReady ? undefined : "interval";
}
interface GrantState {
  permit: number;
  waitedMs: number;
  loadAverage1m: number;
  maxLoad: number;
}
async function runGrantedCommand(
  command: BootGateCommand,
  state: GrantState,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  deps.writeFile(
    join(command.batchDir, "shared/boot-gate/last-grant.json"),
    JSON.stringify({ at: deps.timer.now(), role: command.role }),
  );
  deps.log(
    JSON.stringify({
      role: command.role,
      outcome: "granted",
      ...state,
      ...(command.command.length
        ? {}
        : {
            note: "The permit is not held past exit; only load and the minimum interval stagger boots. Wrap the boot command to hold the permit for the whole boot.",
          }),
    }),
  );
  if (!command.command.length) {
    return 0;
  }
  const [program, ...args] = command.command;
  return (
    await deps.runCommand(
      program,
      args,
      definedEnv(harnessChildEnvironment(deps.env, deps.logSinkOverride)),
    )
  ).exitCode;
}
export async function bootGate(
  command: BootGateCommand,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  const root = join(command.batchDir, "shared/boot-gate");
  deps.mkdir(root, 0o700);
  const grantPath = join(root, "last-grant.json");
  const maxLoad = command.maxLoad ?? 2 * deps.hostStats().cpuCount;
  const clock = () => deps.timer.monotonicNow?.() ?? deps.timer.now();
  const startedAt = clock();
  let permit: number | undefined;
  let lastWaiting: "permit" | "load" | "interval" = "permit";
  try {
    while (true) {
      permit ??= acquirePermit(root, command, deps);
      const loadAverage1m = deps.hostStats().loadAverage[0];
      const at = lastGrant(grantPath, deps);
      const waitedMs = Math.max(0, clock() - startedAt);
      const waiting = waitingFor(
        permit,
        loadAverage1m,
        maxLoad,
        at === undefined || deps.timer.now() - at >= command.minIntervalMs,
      );
      lastWaiting = waiting ?? lastWaiting;
      if (waitedMs >= command.timeoutMs) {
        deps.log(
          JSON.stringify({
            role: command.role,
            outcome: "timeout",
            waitingFor: lastWaiting,
            waitedMs,
            loadAverage1m,
            maxLoad,
          }),
        );
        return 2;
      }
      if (waiting === undefined && permit !== undefined) {
        return await runGrantedCommand(command, { permit, waitedMs, loadAverage1m, maxLoad }, deps);
      }
      await deps.timer.sleep(Math.min(command.pollMs, command.timeoutMs - waitedMs));
    }
  } finally {
    if (permit !== undefined) {
      deps.bootLock.release(join(root, `permit-${permit}.lock`));
    }
  }
}
