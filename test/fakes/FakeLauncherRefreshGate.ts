import type { LauncherRefreshGate } from "../../src/features/prototype/LauncherRefreshGate";
import { InMemoryLauncherRefreshGate } from "../../src/features/prototype/LauncherRefreshGate";

export class FakeLauncherRefreshGate implements LauncherRefreshGate {
  readonly attempts: string[] = [];
  readonly releases: string[] = [];
  private readonly delegate = new InMemoryLauncherRefreshGate();

  tryAcquire(deviceKey: string): (() => void) | undefined {
    this.attempts.push(deviceKey);
    const release = this.delegate.tryAcquire(deviceKey);
    return (
      release &&
      (() => {
        this.releases.push(deviceKey);
        release();
      })
    );
  }
}
