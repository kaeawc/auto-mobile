function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

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

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, sortValue(record[key])])
    );
  }
  return value;
}

function stripToolArgs(args: Record<string, any>): Record<string, any> {
  const stripped = { ...args };
  delete stripped.deviceId;
  delete stripped.sessionUuid;
  return stripped;
}
