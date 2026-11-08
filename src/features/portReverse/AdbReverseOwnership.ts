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

/**
 * The one ownership view the `portReverse` and prototype reverse managers share (#17253). Each
 * manager registers itself and answers from its own state, so nothing is copied; before removing a
 * reverse, or when it finds one already listed, a manager asks whether the other still holds it at
 * the same host port. A port both hold stays on the device until the last of them releases it.
 *
 * Both managers run every operation on a device through {@link exclusive}, so a `--list`, the
 * ownership decision based on it, and the add or removal that follows never interleave with the
 * other manager's work on that device.
 */
export class AdbReverseOwnership {
  private readonly holders = new Set<AdbReverseHolder>();
  /** Device -> the tail of the work queued on it by either manager. */
  private readonly tails = new Map<string, Promise<unknown>>();

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

  /**
   * Runs `task` once every earlier task on the device, from either manager, has settled. A task must
   * not wait for another task on the same device, or both wait forever.
   */
  exclusive<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(deviceId) ?? Promise.resolve()).then(task);
    // The tail only orders the next task; each caller handles its own task's failure.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(deviceId, tail);
    void tail.then(() => {
      if (this.tails.get(deviceId) === tail) {
        this.tails.delete(deviceId);
      }
    });
    return run;
  }
}

/** The process's one shared view: the default portReverse manager and the prototype host use it. */
export const defaultAdbReverseOwnership = new AdbReverseOwnership();
