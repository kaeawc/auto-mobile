import type { StartupFailureStore } from "../../src/daemon/DaemonStartupFailureTracker";

export class FakeStartupFailureStore implements StartupFailureStore {
  contents: string | null = null;
  failWrites = false;
  read(): string | null {
    return this.contents;
  }
  write(data: string): void {
    if (this.failWrites) {
      throw new Error("fake store is unwritable");
    }
    this.contents = data;
  }
  clear(): void {
    this.contents = null;
  }
}
