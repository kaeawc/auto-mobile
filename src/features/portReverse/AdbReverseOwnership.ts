/** Which AutoMobile manager holds a device port's `adb reverse`. */
export type AdbReverseHolderKind = "session" | "prototype";

/** One manager's live view of the device ports it holds. */
export interface AdbReverseHolder {
  readonly kind: AdbReverseHolderKind;
  holds(deviceId: string, devicePort: number): boolean;
}

/**
 * The one ownership view the `portReverse` and prototype reverse managers share (#17253). Each
 * manager registers itself and answers from its own state, so nothing is copied; before removing a
 * reverse, or when it finds one already listed, a manager asks whether the other still holds it. A
 * port both hold stays on the device until the last of them releases it.
 */
export class AdbReverseOwnership {
  private readonly holders = new Set<AdbReverseHolder>();

  /** Adds a manager's view; the returned function removes it. */
  register(holder: AdbReverseHolder): () => void {
    this.holders.add(holder);
    return () => {
      this.holders.delete(holder);
    };
  }

  /** The kind of another registered manager that holds the port, if any. */
  heldByOther(
    self: AdbReverseHolder,
    deviceId: string,
    devicePort: number,
  ): AdbReverseHolderKind | undefined {
    for (const holder of this.holders) {
      if (holder !== self && holder.holds(deviceId, devicePort)) {
        return holder.kind;
      }
    }
    return undefined;
  }
}

/** The process's one shared view: the default portReverse manager and the prototype host use it. */
export const defaultAdbReverseOwnership = new AdbReverseOwnership();
