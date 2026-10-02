import type {
  KeystoreDiscovery,
  KeystoreDiscoveryState,
} from "../../src/features/storage/keystoreDiscovery";

export class FakeKeystoreDiscovery implements KeystoreDiscovery {
  readonly calls: string[] = [];
  failure?: Error;
  state: KeystoreDiscoveryState = {
    schemaVersion: 1,
    capability: "storage.keystore",
    outcome: "ok",
    bridgeAvailable: true,
    metadata: "supported",
    mutation: "declared_unsupported",
    deviceLocked: "unlocked",
    scopes: ["fixture"],
  };
  async discoverKeystore(packageName: string): Promise<KeystoreDiscoveryState> {
    this.calls.push(packageName);
    if (this.failure) {
      throw this.failure;
    }
    return this.state;
  }
}
