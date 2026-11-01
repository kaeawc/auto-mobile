import type { WatchSocket } from "../../src/features/watch/WatchRunnerClient";
export class FakeWatchSocket implements WatchSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private message: (message: string) => void = () => {};
  private failure: (error: Error) => void = () => {};
  send(message: string): void {
    this.sent.push(JSON.parse(message));
  }
  close(): void {
    this.closed = true;
  }
  onMessage(listener: (message: string) => void): void {
    this.message = listener;
  }
  onFailure(listener: (error: Error) => void): void {
    this.failure = listener;
  }
  receive(value: unknown): void {
    this.message(JSON.stringify(value));
  }
  disconnect(): void {
    this.failure(new Error("disconnected"));
  }
  connected(platform = "watchos"): void {
    this.receive({
      type: "connected",
      platform,
      supportedCommands: ["hierarchy", "tap", "swipe", "home"],
    });
  }
}
