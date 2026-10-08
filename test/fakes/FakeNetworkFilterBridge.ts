import {
  NETWORK_FILTER_CONTRACT_VERSION,
  type NetworkFilterBridge,
  type NetworkFilterSnapshot,
  type NetworkFilterSnapshotResult,
  type NetworkFilterState,
  type NetworkFilterStatus,
} from "../../src/features/network-filter/NetworkFilterBridge";

/** Scripted {@link NetworkFilterBridge}: returns the configured result and counts calls. */
export class FakeNetworkFilterBridge implements NetworkFilterBridge {
  private result: NetworkFilterSnapshotResult;
  statusCalls = 0;
  snapshotCalls = 0;

  constructor(result: NetworkFilterSnapshotResult = { state: "not_installed", detail: "fake" }) {
    this.result = result;
  }

  /** Report `state` with the current contract version (none for `not_installed`). */
  setState(state: NetworkFilterState, detail = `fake ${state}`): void {
    this.result =
      state === "not_installed"
        ? { state, detail }
        : { state, detail, contractVersion: NETWORK_FILTER_CONTRACT_VERSION };
  }

  setResult(result: NetworkFilterSnapshotResult): void {
    this.result = result;
  }

  setSnapshot(snapshot: NetworkFilterSnapshot): void {
    this.result = { ...this.result, snapshot };
  }

  async status(): Promise<NetworkFilterStatus> {
    this.statusCalls += 1;
    const { state, detail, contractVersion } = this.result;
    return contractVersion === undefined ? { state, detail } : { state, detail, contractVersion };
  }

  async snapshot(): Promise<NetworkFilterSnapshotResult> {
    this.snapshotCalls += 1;
    return this.result;
  }
}
