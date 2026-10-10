interface KeyState {
  issued: number;
  latest: number;
  /** Generations that were taken and then refused; none is ever the latest again. */
  withdrawn: Set<number>;
}

/**
 * Orders concurrent shows of one prototype id on one device. Each show takes a generation when it
 * starts; only the latest generation may commit its result to host status, so a slower, older
 * show finishing last cannot overwrite what the newer one already recorded.
 *
 * A show the host then refuses never reaches the device, so it [withdraw]s its generation and the
 * newest remaining show is the latest again (#11477).
 */
export class PrototypeCommitGenerations {
  private readonly states = new Map<string, KeyState>();

  begin(deviceId: string, prototypeId: string): number {
    const key = JSON.stringify([deviceId, prototypeId]);
    const state = this.states.get(key) ?? { issued: 0, latest: 0, withdrawn: new Set<number>() };
    state.issued += 1;
    state.latest = state.issued;
    this.states.set(key, state);
    return state.issued;
  }

  isLatest(deviceId: string, prototypeId: string, generation: number): boolean {
    return this.states.get(JSON.stringify([deviceId, prototypeId]))?.latest === generation;
  }

  withdraw(deviceId: string, prototypeId: string, generation: number): void {
    const state = this.states.get(JSON.stringify([deviceId, prototypeId]));
    if (!state) {
      return;
    }
    state.withdrawn.add(generation);
    while (state.latest > 0 && state.withdrawn.has(state.latest)) {
      state.withdrawn.delete(state.latest);
      state.latest -= 1;
    }
  }
}
