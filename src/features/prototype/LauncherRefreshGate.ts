/** In-process, non-waiting ownership of a prototype save's launcher refresh. */
export interface LauncherRefreshGate {
  tryAcquire(deviceKey: string): (() => void) | undefined;
}

export class InMemoryLauncherRefreshGate implements LauncherRefreshGate {
  private readonly held = new Set<string>();

  tryAcquire(deviceKey: string): (() => void) | undefined {
    if (this.held.has(deviceKey)) {
      return undefined;
    }
    this.held.add(deviceKey);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.held.delete(deviceKey);
      }
    };
  }
}
