import type { DaemonHttpTokenStore } from "./daemonHttpToken";

export class FakeDaemonHttpTokenStore implements DaemonHttpTokenStore {
  token: string | undefined;
  private publishedToken: string | undefined;
  write(token: string): void {
    this.token = token;
    this.publishedToken = token;
  }
  read(): string | undefined {
    return this.token;
  }
  remove(): void {
    if (this.publishedToken !== undefined && this.token === this.publishedToken) {
      this.token = undefined;
    }
    this.publishedToken = undefined;
  }
}
