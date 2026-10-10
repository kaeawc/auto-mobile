interface KeyState {
  issued: number;
  /** The newest non-withdrawn generation that already settled; older valid shows stay superseded. */
  settledValid: number;
  /** The newest generation that has not been withdrawn; 0 when none remains. */
  latestValid: number;
  /** Unsettled generations of this id on this device, mapped to whether each was withdrawn. */
  inFlight: Map<number, boolean>;
}

/**
 * Orders concurrent shows of one prototype id on one device. Each show takes a generation when it
 * starts; only the latest generation may commit its result to host status, so a slower, older
 * show finishing last cannot overwrite what the newer one already recorded.
 *
 * A show the host then refuses never reaches the device, so it [withdraw]s its generation for
 * ordering: it no longer supersedes older shows. It still defers to any newer show, and commits its
 * own refusal only while it is the newest arrival. Every show must [settle] when it ends; the
 * bookkeeping for an id is dropped once no show for it is in flight (#11477).
 */
export class PrototypeCommitGenerations {
  private readonly states = new Map<string, KeyState>();

  begin(deviceId: string, prototypeId: string): number {
    const key = JSON.stringify([deviceId, prototypeId]);
    const state = this.states.get(key) ?? {
      issued: 0,
      settledValid: 0,
      latestValid: 0,
      inFlight: new Map(),
    };
    state.issued += 1;
    state.latestValid = state.issued;
    state.inFlight.set(state.issued, false);
    this.states.set(key, state);
    return state.issued;
  }

  /** A valid show is latest until a newer valid one arrives; a withdrawn one only while newest. */
  isLatest(deviceId: string, prototypeId: string, generation: number): boolean {
    const state = this.states.get(JSON.stringify([deviceId, prototypeId]));
    if (!state) {
      return true;
    }
    return state.inFlight.get(generation) === true
      ? generation === state.issued
      : generation === state.latestValid;
  }

  /** Idempotent: withdrawing an unknown, settled or already withdrawn generation does nothing. */
  withdraw(deviceId: string, prototypeId: string, generation: number): void {
    const state = this.states.get(JSON.stringify([deviceId, prototypeId]));
    if (!state || state.inFlight.get(generation) !== false) {
      return;
    }
    state.inFlight.set(generation, true);
    if (state.latestValid === generation) {
      state.latestValid = this.newestValidBelow(state, generation);
    }
  }

  /** The show ended (committed, superseded, withdrawn or aborted): forget its bookkeeping. */
  settle(deviceId: string, prototypeId: string, generation: number): void {
    const key = JSON.stringify([deviceId, prototypeId]);
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    if (state.inFlight.get(generation) === false) {
      state.settledValid = Math.max(state.settledValid, generation);
    }
    state.inFlight.delete(generation);
    if (state.inFlight.size === 0) {
      this.states.delete(key);
    }
  }

  /** Number of ids with a show still in flight; zero once every show has settled. */
  trackedIds(): number {
    return this.states.size;
  }

  private newestValidBelow(state: KeyState, generation: number): number {
    let newest = state.settledValid;
    for (const [candidate, withdrawn] of state.inFlight) {
      if (!withdrawn && candidate < generation && candidate > newest) {
        newest = candidate;
      }
    }
    return newest;
  }
}
