import { load } from "js-yaml";

interface Executor {
  macos?: unknown;
}
interface CircleJob extends Executor {
  executor?: string | { name: string };
}
interface CircleConfig {
  executors?: Record<string, Executor>;
  jobs?: Record<string, CircleJob>;
  workflows?: Record<string, { jobs?: (string | Record<string, { name?: string } | null>)[] }>;
}

export function parseCircleciMacosJobNames(yamlText: string): string[] {
  const config = load(yamlText) as CircleConfig | null;
  const macosKeys = new Set(
    Object.entries(config?.jobs ?? {})
      .filter(([, job]) => {
        const executor = typeof job.executor === "string" ? job.executor : job.executor?.name;
        return (
          "macos" in job ||
          Boolean(
            executor && config?.executors?.[executor] && "macos" in config.executors[executor],
          )
        );
      })
      .map(([key]) => key),
  );
  const names = new Set<string>();
  for (const workflow of Object.values(config?.workflows ?? {})) {
    for (const entry of workflow.jobs ?? []) {
      const [key, settings] = typeof entry === "string" ? [entry, null] : Object.entries(entry)[0];
      if (macosKeys.has(key)) {
        names.add(settings?.name ?? key);
      }
    }
  }
  return [...names].sort();
}

export function createCircleciMacosMatcher(names: readonly string[]): (name: string) => boolean {
  return (name) => names.some((display) => name === display || name.startsWith(`${display}-`));
}
