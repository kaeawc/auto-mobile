export class DevicePoolError extends Error {
  constructor(
    message: string,
    public readonly isRetryable: boolean,
    public readonly refreshFailure?: string,
  ) {
    super(message);
    this.name = "DevicePoolError";
  }
}
