export class DatabaseHealthProbeTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly phase: "init" | "query" = "query",
    readonly startupMs?: number,
  ) {
    super(`Database health probe timed out after ${timeoutMs}ms`);
    this.name = "DatabaseHealthProbeTimeoutError";
  }
}
