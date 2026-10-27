export class AdbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbUnavailableError";
  }
}
