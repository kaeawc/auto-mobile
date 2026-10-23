import { cpus, loadavg } from "node:os";
import { testOverrides } from "./testOverrides";

export interface HostLoadReader {
  loadAverage1m(): number | null;
  cpuCount(): number;
}

export const nodeHostLoadReader: HostLoadReader = {
  loadAverage1m: () => (process.platform === "win32" ? null : loadavg()[0]),
  cpuCount: () => cpus().length,
};

export function defaultHostLoadReader(): HostLoadReader {
  return testOverrides.hostLoad ?? nodeHostLoadReader;
}

export interface LoadScaledBudget {
  budgetMs: number;
  baseMs: number;
  ceilingMs: number;
  loadPerCore: number | null;
  factor: number;
  capped: boolean;
}

export function loadScaledBudget(
  { baseMs, ceilingMs }: { baseMs: number; ceilingMs: number },
  reader: HostLoadReader,
): LoadScaledBudget {
  const load = reader.loadAverage1m();
  const cores = reader.cpuCount();
  const loadPerCore = load === null || cores < 1 ? null : load / cores;
  const factor = loadPerCore === null || loadPerCore <= 1 ? 1 : loadPerCore;
  const scaled = Math.max(baseMs, Math.round(baseMs * factor));
  const effectiveCeiling = Math.max(baseMs, ceilingMs);
  return {
    baseMs,
    ceilingMs: effectiveCeiling,
    loadPerCore,
    factor,
    budgetMs: Math.min(effectiveCeiling, scaled),
    capped: scaled > effectiveCeiling,
  };
}

export function retryBudget(first: LoadScaledBudget): number {
  return Math.max(
    first.budgetMs,
    Math.min(Math.max(first.ceilingMs, first.baseMs), first.budgetMs * 2),
  );
}

export function describeLoadScaledBudget(budget: LoadScaledBudget): string {
  const load =
    budget.loadPerCore === null
      ? "host load unknown"
      : `host load ${budget.loadPerCore.toFixed(1)}/core`;
  if (budget.factor === 1) {
    return `budget ${budget.budgetMs}ms (base, ${load})`;
  }
  const factor = budget.budgetMs / budget.baseMs;
  const ceiling = budget.capped ? `, capped at ceiling ${budget.ceilingMs}ms` : "";
  return `${budget.budgetMs}ms (base ${budget.baseMs}ms x${factor.toFixed(1)} for ${load}${ceiling})`;
}
