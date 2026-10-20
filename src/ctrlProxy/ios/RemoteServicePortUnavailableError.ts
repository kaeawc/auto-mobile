export class RemoteServicePortUnavailableError extends Error {
  constructor(host: string, port: number) {
    super(`Remote runner port ${port} is already in use on ${host}`);
    this.name = "RemoteServicePortUnavailableError";
  }
}
