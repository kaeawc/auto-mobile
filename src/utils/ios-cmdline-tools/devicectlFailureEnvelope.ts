export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Structured failure metadata only; raw payloads and userInfo never leave this parser. */
export interface DevicectlFailureEnvelope {
  domain?: string;
  code: number;
  kind: "device-not-found" | "capability-unsupported" | "other";
}

const CORE_DEVICE_FAILURE_KINDS = new Map<number, DevicectlFailureEnvelope["kind"]>([
  [1000, "device-not-found"],
  [1001, "capability-unsupported"],
]);

export function parseDevicectlFailureEnvelope(data: unknown): DevicectlFailureEnvelope | undefined {
  const root = asRecord(data);
  const outcome = asRecord(root?.info)?.outcome;
  const error = asRecord(root?.error);
  if (
    typeof outcome !== "string" ||
    outcome.toLowerCase() === "success" ||
    typeof error?.code !== "number"
  ) {
    return undefined;
  }
  const domain = asString(error.domain);
  const coreDevice = domain?.toLowerCase().includes("coredevice");
  const kind = coreDevice ? (CORE_DEVICE_FAILURE_KINDS.get(error.code) ?? "other") : "other";
  return { ...(domain ? { domain } : {}), code: error.code, kind };
}
