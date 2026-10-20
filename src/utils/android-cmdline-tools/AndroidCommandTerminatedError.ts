/**
 * The command was stopped by its timeout or caller cancellation rather than
 * exiting on its own, so whatever it was doing may be half done.
 */
export class AndroidCommandTerminatedError extends Error {
  constructor(
    message: string,
    public readonly reason: "timeout" | "cancelled",
  ) {
    super(message);
    this.name = "AndroidCommandTerminatedError";
  }
}
