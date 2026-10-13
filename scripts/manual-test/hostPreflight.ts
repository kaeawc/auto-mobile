// Harness readers return unavailable reasons as their diagnostic trace.
import { join } from "node:path";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { shellQuote } from "../../src/utils/shellQuote";
import { definedEnv } from "./privateDaemonStatus";
import type { PrivateDaemonCliDeps } from "./private-daemon";

export interface HostStats {
  platform: NodeJS.Platform;
  loadAverage: number[];
  cpuCount: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
}
interface Unavailable {
  unavailable: string;
}
export type HostPower =
  | { source: "ac" | "battery" | "unknown"; chargePercent?: number }
  | Unavailable;
export type HostSleep =
  | { preventUserIdleSystemSleep: boolean; preventSystemSleep: boolean }
  | Unavailable;
export type HostLid = { closed: boolean; clamshellCausesSleep?: boolean } | Unavailable;
export interface HostSections {
  power: HostPower;
  sleep: HostSleep;
  lid: HostLid;
}
export interface HostPreflightReport extends HostStats, HostSections {
  warnings: string[];
  caffeinate: string;
}

export function parsePmsetBatt(text: string): HostPower {
  const source = /Now drawing from '([^']+)'/.exec(text)?.[1];
  const charge = /\b(\d{1,3})%;/.exec(text)?.[1];
  const chargePercent = charge === undefined ? undefined : Number(charge);
  return {
    source: source === "AC Power" ? "ac" : source === "Battery Power" ? "battery" : "unknown",
    ...(chargePercent !== undefined && chargePercent <= 100 ? { chargePercent } : {}),
  };
}
export function parsePmsetAssertions(text: string): HostSleep {
  const counters = text
    .split("Assertion status system-wide:")[1]
    ?.split("Listed by owning process:")[0];
  const idle = counters && /^\s*PreventUserIdleSystemSleep\s+(\d+)\s*$/m.exec(counters);
  const system = counters && /^\s*PreventSystemSleep\s+(\d+)\s*$/m.exec(counters);
  return idle && system
    ? { preventUserIdleSystemSleep: Number(idle[1]) > 0, preventSystemSleep: Number(system[1]) > 0 }
    : { unavailable: "pmset assertion status counters could not be read" };
}
export function parseIoregClamshell(text: string): HostLid {
  const state = /"AppleClamshellState"\s*=\s*(Yes|No)\b/.exec(text)?.[1];
  const causesSleep = /"AppleClamshellCausesSleep"\s*=\s*(Yes|No)\b/.exec(text)?.[1];
  return state === undefined
    ? { unavailable: "ioreg clamshell state could not be read" }
    : {
        closed: state === "Yes",
        ...(causesSleep === undefined ? {} : { clamshellCausesSleep: causesSleep === "Yes" }),
      };
}
export function buildHostPreflightReport(
  batchDir: string,
  stats: HostStats,
  sections: HostSections,
): HostPreflightReport {
  const warnings: string[] = [];
  const { power, sleep, lid } = sections;
  if (!("unavailable" in power) && power.source === "battery") {
    warnings.push(
      `Host is on battery (${power.chargePercent === undefined ? "charge unknown" : `${power.chargePercent}% charge`}); attach AC power before the batch.`,
    );
  }
  if (!("unavailable" in sleep) && !sleep.preventUserIdleSystemSleep) {
    warnings.push(
      "Idle system sleep is not prevented; run the printed caffeinate command before the batch.",
    );
  }
  warnings.push(...lidWarnings(lid));
  if (stats.loadAverage[0] > 2 * stats.cpuCount) {
    warnings.push(
      "Host load exceeds twice the CPU count; wait for load to settle before measuring timings.",
    );
  }
  if (stats.platform === "darwin") {
    for (const [name, section] of Object.entries(sections)) {
      if ("unavailable" in section) {
        warnings.push(
          `Host ${name} check is unavailable (${section.unavailable}); verify it before the batch.`,
        );
      }
    }
  }
  return {
    ...stats,
    ...sections,
    warnings,
    caffeinate: `nohup caffeinate -dims > /dev/null 2>&1 & echo $! > ${shellQuote(batchDir)}/shared/caffeinate.pid`,
  };
}
function lidWarnings(lid: HostLid): string[] {
  const warnings: string[] = [];
  if (!("unavailable" in lid) && lid.closed) {
    warnings.push(
      "The lid is closed; open it before the batch or connect an external display with AC power.",
    );
  }
  if (!("unavailable" in lid) && lid.clamshellCausesSleep) {
    warnings.push(
      "Closing the lid will sleep the host and caffeinate cannot prevent clamshell sleep on battery; keep AC attached and the lid open or an external display connected.",
    );
  }
  return warnings;
}
async function captureSection<T>(
  command: string,
  args: string[],
  parse: (text: string) => T,
  deps: PrivateDaemonCliDeps,
): Promise<T | Unavailable> {
  try {
    const result = await deps.runCapture(command, args, definedEnv(deps.env), 5000);
    return result.exitCode === 0
      ? parse(result.stdout)
      : { unavailable: result.stderr || `${command} exited ${result.exitCode}` };
  } catch (error) {
    // Optional host probes preserve failures in the report without blocking a batch.
    return { unavailable: errorMessage(error) };
  }
}
export async function hostPreflight(
  batchDir: string,
  deps: PrivateDaemonCliDeps,
): Promise<HostPreflightReport> {
  const stats = deps.hostStats();
  const unsupported = { unavailable: "unsupported platform" };
  const sections =
    stats.platform === "darwin"
      ? {
          power: await captureSection("pmset", ["-g", "batt"], parsePmsetBatt, deps),
          sleep: await captureSection("pmset", ["-g", "assertions"], parsePmsetAssertions, deps),
          lid: await captureSection(
            "ioreg",
            ["-r", "-k", "AppleClamshellState", "-d", "1"],
            parseIoregClamshell,
            deps,
          ),
        }
      : { power: unsupported, sleep: unsupported, lid: unsupported };
  return buildHostPreflightReport(batchDir, stats, sections);
}
export async function recordHostPreflight(
  batchDir: string,
  deps: PrivateDaemonCliDeps,
): Promise<void> {
  try {
    const report = await hostPreflight(batchDir, deps);
    deps.mkdir(join(batchDir, "shared"), 0o700);
    deps.writeFile(
      join(batchDir, `shared/preflight-${deps.timer.now()}.json`),
      JSON.stringify(report),
    );
    for (const warning of report.warnings) {
      deps.log(`PREFLIGHT WARNING: ${warning}`);
    }
    if (report.warnings.length) {
      deps.log(report.caffeinate);
    }
  } catch (error) {
    // Best-effort recording must never change init/start's lifecycle result.
    deps.log(
      `PREFLIGHT WARNING: Host preflight could not be recorded (${errorMessage(error)}); verify host readiness before the batch.`,
    );
  }
}
