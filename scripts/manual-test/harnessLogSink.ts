/** Import before product modules: their logger creates file state at module evaluation. */
export interface HarnessLogSinkOverride {
  name: string;
  previous: string | undefined;
}
export function selectHarnessLogSink(
  env: Record<string, string | undefined>,
): HarnessLogSinkOverride | undefined {
  if (
    env.AUTOMOBILE_LOG_SINK !== undefined ||
    env.AUTO_MOBILE_LOG_SINK !== undefined ||
    env.AUTOMOBILE_LOG_DIR?.trim()
  ) {
    return undefined;
  }
  const override = { name: "AUTOMOBILE_LOG_SINK", previous: env.AUTOMOBILE_LOG_SINK };
  env[override.name] = "stderr";
  return override;
}
const override = selectHarnessLogSink(process.env);
export function harnessLogSinkOverride(): HarnessLogSinkOverride | undefined {
  return override;
}
/** Undo only our import-time selection, preserving caller-selected sinks. */
export function harnessChildEnvironment(
  env: Record<string, string | undefined>,
  selected = harnessLogSinkOverride(),
): Record<string, string | undefined> {
  const child = { ...env };
  if (selected) {
    if (selected.previous === undefined) {
      delete child[selected.name];
    } else {
      child[selected.name] = selected.previous;
    }
  }
  return child;
}
