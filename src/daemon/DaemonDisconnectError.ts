export class DaemonDisconnectError extends Error {
  readonly toolName: string;
  readonly origin: string;

  constructor(opts: { toolName: string; origin: string; detail?: string }) {
    const detail = opts.detail ? ` (${opts.detail})` : "";
    super(`Daemon disconnected before ${opts.toolName} responded at ${opts.origin}${detail}`);
    this.name = "DaemonDisconnectError";
    this.toolName = opts.toolName;
    this.origin = opts.origin;
  }
}
