import { stableStringify } from "./stableStringify";

export function normalizeToolArgs(args?: Record<string, any> | null): string {
  if (!args || Object.keys(args).length === 0) {
    return "";
  }
  return stableStringify(stripToolArgs(args));
}

export function normalizeIdentifier(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function stripToolArgs(args: Record<string, any>): Record<string, any> {
  const stripped = { ...args };
  delete stripped.deviceId;
  delete stripped.sessionUuid;
  return stripped;
}
