import { ActionableError } from "../../models/ActionableError";

/** Prefix of the typed refusal message, so callers can match on it. */
export const HEAP_DUMP_NOT_DEBUGGABLE = "heap_dump_not_debuggable";

/** `heapDump` refused because the app is neither debuggable nor profileable by the shell. */
export class HeapDumpRefusedError extends ActionableError {
  readonly code = HEAP_DUMP_NOT_DEBUGGABLE;
  constructor(appId: string, detail: string) {
    super(
      `${HEAP_DUMP_NOT_DEBUGGABLE}: ${appId} is neither debuggable nor profileable, so its heap cannot be dumped (${detail}). ` +
        'Install a debuggable build, or add <profileable android:shell="true"/> to the manifest.',
    );
    this.name = "HeapDumpRefusedError";
  }
}
