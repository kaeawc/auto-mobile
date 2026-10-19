import {
  restoreBinding,
  snapshotBinding,
  type BindingFields,
} from "../../src/daemon/deviceBinding";

/**
 * Test setup for a pooled device's binding fields. `PooledDevice` exposes them read-only outside
 * the binding module, so tests write them through the module's own `restoreBinding` writer
 * instead of assigning to the properties directly.
 */
export function patchBinding(device: BindingFields, patch: Partial<BindingFields>): void {
  restoreBinding(device, { ...snapshotBinding(device), ...patch });
}
