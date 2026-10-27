export class DaemonSocketQueueOverflowError extends Error {
  readonly reason = "queue_overflow";

  constructor(
    readonly queuedBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Daemon RPC socket queued bytes exceeded ${limitBytes}`);
    this.name = "DaemonSocketQueueOverflowError";
  }
}
