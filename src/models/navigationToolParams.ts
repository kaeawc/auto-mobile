/**
 * Copy replayable navigation arguments, excluding request-local metadata and device routing.
 * Every daemon-injected internal param (`INTERNAL_TOOL_PARAM_NAMES`) is `__`-prefixed, so the
 * prefix sweep also removes them; a daemon test pins that invariant.
 */
export function stripNavigationToolParams(args: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...args };
  delete clean.platform;
  delete clean.deviceId;
  delete clean.device;
  for (const key of Object.keys(clean)) {
    if (key.startsWith("__") || key === "sessionUuid") {
      delete clean[key];
    }
  }
  return clean;
}
