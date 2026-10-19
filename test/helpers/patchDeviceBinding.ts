import {
  restoreBinding,
  snapshotBinding,
  type BindingFields,
} from "../../src/daemon/deviceBinding";

/**
 * Overwrite a pooled device's binding fields in a test fixture through the
 * binding owner's writer, leaving unspecified (or explicitly `undefined`) fields
 * as they were. Unlike the pool's own claim paths this notifies nobody,
 * matching the direct field writes these fixtures used to make.
 */
export function patchDeviceBinding(device: BindingFields, patch: Partial<BindingFields>): void {
  const current = snapshotBinding(device);
  restoreBinding(device, {
    sessionId: patch.sessionId !== undefined ? patch.sessionId : current.sessionId,
    status: patch.status !== undefined ? patch.status : current.status,
    health: patch.health !== undefined ? patch.health : current.health,
  });
}
