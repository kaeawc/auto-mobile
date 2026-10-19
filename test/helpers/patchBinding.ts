import type { BindingFields } from "../../src/daemon/deviceBinding";

/** The writable view of a pooled device's binding that tests seed state through. */
type MutableBinding = { -readonly [K in keyof BindingFields]: BindingFields[K] };

/**
 * Seed a pooled device's binding fields in a test. `PooledDevice` exposes them read-only so
 * production code goes through bindDevice/unbindDevice; fixtures that need a state those
 * transitions cannot express (a status without a holder, a stale holder) use this instead.
 */
export function patchBinding(device: MutableBinding, patch: Partial<MutableBinding>): void {
  if (patch.sessionId !== undefined) {
    device.sessionId = patch.sessionId;
  }
  if (patch.status !== undefined) {
    device.status = patch.status;
  }
  if (patch.health !== undefined) {
    device.health = patch.health;
  }
}
