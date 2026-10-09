import type { FleetCostReport, SimulatorCost } from "./types";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export function formatBytes(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;
}

function describeSimulator(sim: SimulatorCost): string {
  const parts = [`${sim.name} (${sim.udid}) ${sim.state}`];
  if (sim.quality === "measured" && sim.process) {
    parts.push(
      `${formatBytes(sim.process.rssBytes)} RSS, ${sim.process.cpuPercent.toFixed(1)}% CPU, ${sim.process.processCount} processes`,
    );
  } else if (sim.quality === "no-processes" || sim.quality === "unavailable") {
    parts.push(`cost unavailable (${sim.quality}${sim.error ? `: ${sim.error}` : ""})`);
  }
  if (sim.diskBytes !== undefined) {
    parts.push(`${formatBytes(sim.diskBytes)} data`);
  }
  if (sim.lastBoot) {
    parts.push(
      `last boot ${(sim.lastBoot.durationMs / 1000).toFixed(1)}s [${sim.lastBoot.profileId}]`,
    );
  }
  return parts.join(", ");
}

/** Booted simulators first (they carry the live cost), then a one-line shutdown/disk summary. */
export function formatFleetReport(report: FleetCostReport): string[] {
  const booted = report.simulators.filter((sim) => sim.state === "Booted");
  const lines = booted.map(describeSimulator);
  const idle = report.simulators.length - booted.length;
  lines.push(
    `${idle} shutdown simulator(s); ${formatBytes(report.totals.diskBytes)} device data on disk in total`,
  );
  lines.push(...report.errors.map((error) => `error: ${error}`));
  return lines;
}
