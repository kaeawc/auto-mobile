import {
  restoreBinding,
  snapshotBinding,
  type BindingFields,
} from "../../src/daemon/deviceBinding";

/**
 * Overwrites selected binding fields of a pooled device through the binding module's own
 * writer, leaving the fields not named in `patch` as they are.
 */
export function patchBinding(device: BindingFields, patch: Partial<BindingFields>): void {
  restoreBinding(device, { ...snapshotBinding(device), ...patch });
}
