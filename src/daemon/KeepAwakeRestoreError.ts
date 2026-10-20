import type { KeepAwakeRestoreReport } from "../utils/KeepScreenAwakeManager";

/** Preserve typed restore evidence through the existing bounded retry path. */
export class KeepAwakeRestoreError extends Error {
  constructor(
    message: string,
    readonly report: KeepAwakeRestoreReport,
  ) {
    super(message);
    this.name = "KeepAwakeRestoreError";
  }
}
