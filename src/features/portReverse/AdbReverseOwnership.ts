/** Which AutoMobile manager holds a device port's `adb reverse`. */
export type AdbReverseHolderKind = "session" | "prototype";

/** One manager's live view of the device ports it holds. */
export interface AdbReverseHolder {
  readonly kind: AdbReverseHolderKind;
  /** The host port this holder expects the device port to map to; undefined when it holds none. */
  heldHostPort(deviceId: string, devicePort: number): number | undefined;
}

/** Another manager's hold on a device port. */
export interface AdbReverseHold {
  kind: AdbReverseHolderKind;
  hostPort: number;
}

const removalKey = (deviceId: string, devicePort: number) => `${deviceId}\u0000${devicePort}`;

/**
 * The one ownership view the `portReverse` and prototype reverse managers share (#17253). Each
 * manager registers itself and answers from its own state, so nothing is copied; before removing a
 * reverse, or when it finds one already listed, a manager asks whether the other still holds it. A
 * port both hold stays on the device until the last of them releases it.
 *
 * Every `adb reverse --remove` either manager runs goes through {@link removing}, so the other can
 * see a removal in flight and wait for it instead of joining a mapping that is about to disappear.
 */
export class AdbReverseOwnership {
  private readonly holders = new Set<AdbReverseHolder>();
  private readonly removals = new Map<string, Promise<unknown>>();

  /** Adds a manager's view; the returned function removes it. */
  register(holder: AdbReverseHolder): () => void {
    this.holders.add(holder);
    return () => {
      this.holders.delete(holder);
    };
  }

  /** Another registered manager's hold on the port, if any. */
  heldByOther(
    self: AdbReverseHolder,
    deviceId: string,
    devicePort: number,
  ): AdbReverseHold | undefined {
    for (const holder of this.holders) {
      const hostPort = holder === self ? undefined : holder.heldHostPort(deviceId, devicePort);
      if (hostPort !== undefined) {
        return { kind: holder.kind, hostPort };
      }
    }
    return undefined;
  }

  /** Tracks a removal of the port until it settles; returns it unchanged. */
  removing<T>(deviceId: string, devicePort: number, removal: Promise<T>): Promise<T> {
    const key = removalKey(deviceId, devicePort);
    const tracked = removal.finally(() => {
      if (this.removals.get(key) === tracked) {
        this.removals.delete(key);
      }
    });
    this.removals.set(key, tracked);
    return tracked;
  }

  /** Whether a removal of the port is in flight. */
  removalPending(deviceId: string, devicePort: number): boolean {
    return this.removals.has(removalKey(deviceId, devicePort));
  }

  /** Resolves once no removal of the port is in flight (a failed removal settles too). */
  async settled(deviceId: string, devicePort: number): Promise<void> {
    const key = removalKey(deviceId, devicePort);
    for (let pending = this.removals.get(key); pending; pending = this.removals.get(key)) {
      // The removal's outcome belongs to the manager that ran it; waiting only needs it settled.
      await pending.then(
        () => undefined,
        () => undefined,
      );
    }
  }
}

/** The process's one shared view: the default portReverse manager and the prototype host use it. */
export const defaultAdbReverseOwnership = new AdbReverseOwnership();
