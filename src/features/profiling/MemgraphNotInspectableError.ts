import { ActionableError } from "../../models/ActionableError";

/** `heapDump` refused because macOS denied access to the Simulator process. */
export class MemgraphNotInspectableError extends ActionableError {
  readonly code = "heap_dump_not_inspectable";

  constructor(appId: string, options?: ErrorOptions) {
    super(
      `heap_dump_not_inspectable: macOS denied access to inspect ${appId}. Try a debuggable Simulator build or use performanceTrace allocations (xctrace).`,
      options,
    );
    this.name = "MemgraphNotInspectableError";
  }
}
