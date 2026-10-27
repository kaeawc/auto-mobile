export class SessionLogTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLogTimeoutError";
  }
}
