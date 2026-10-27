import { AsyncLocalStorage } from "node:async_hooks";
import type { Timer } from "../../utils/SystemTimer";
import type { ExactDeviceProvisionRequest } from "../exactDeviceProvisioning";

type CreateIdentity = Pick<ExactDeviceProvisionRequest, "platform" | "name"> & {
  spec: { runtime: string; deviceType?: string };
};

interface VerifiedBootCapacity {
  identity: CreateIdentity;
  verifiedAtMs: number;
  timer: Pick<Timer, "now">;
  active: boolean;
}

const MAX_VERIFICATION_AGE_MS = 5_000;
// Like BootReservationScope, this crosses only the in-process tool boundary, never MCP.
// Each run owns one verdict; unrelated requests cannot reuse a process-wide cached sample.
const verificationScope = new AsyncLocalStorage<VerifiedBootCapacity>();

export async function withVerifiedBootCapacity<T>(
  identity: CreateIdentity,
  verifiedAtMs: number | undefined,
  timer: Pick<Timer, "now">,
  operation: () => Promise<T>,
): Promise<T> {
  if (verifiedAtMs === undefined) {
    return await verificationScope.exit(operation);
  }
  const verification: VerifiedBootCapacity = {
    identity: { ...identity, spec: { ...identity.spec } },
    verifiedAtMs,
    timer,
    active: true,
  };
  try {
    return await verificationScope.run(verification, operation);
  } finally {
    verification.active = false;
  }
}

/** Consume once, immediately before the exact provisioner's pre-create capacity assertion. */
export function consumeVerifiedBootCapacity(request: CreateIdentity): boolean {
  const verification = verificationScope.getStore();
  if (!verification?.active) {
    return false;
  }
  const ageMs = verification.timer.now() - verification.verifiedAtMs;
  const { identity } = verification;
  if (
    ageMs < 0 ||
    ageMs > MAX_VERIFICATION_AGE_MS ||
    identity.platform !== request.platform ||
    identity.name !== request.name ||
    identity.spec.runtime !== request.spec.runtime ||
    identity.spec.deviceType !== request.spec.deviceType
  ) {
    return false;
  }
  verification.active = false;
  return true;
}
