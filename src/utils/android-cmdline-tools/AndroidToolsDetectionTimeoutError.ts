/**
 * Signals that a caller-owned deadline expired while this module was probing
 * the host. Discovery normally treats missing commands as a negative result;
 * a deadline expiry must instead reach that caller unchanged.
 */
export class AndroidToolsDetectionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AndroidToolsDetectionTimeoutError";
  }
}
