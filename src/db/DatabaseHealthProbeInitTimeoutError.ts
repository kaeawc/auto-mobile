import { DatabaseHealthProbeTimeoutError } from "./DatabaseHealthProbeTimeoutError";

export class DatabaseHealthProbeInitTimeoutError extends DatabaseHealthProbeTimeoutError {
  declare readonly phase: "init";

  constructor(timeoutMs: number) {
    super(timeoutMs, "init", 0);
    this.name = "DatabaseHealthProbeInitTimeoutError";
    this.message = `Database health probe worker did not become ready within ${timeoutMs}ms`;
  }
}
