import type {
  IosStorageDiscoverer,
  IosStorageDiscovery,
} from "../../src/features/storage/iosStorageDiscovery";

export class FakeIosStorageDiscovery implements IosStorageDiscoverer {
  readonly calls: string[] = [];
  failure?: Error;
  discovery: IosStorageDiscovery = {
    keychain: {
      schemaVersion: 1,
      capability: "storage.keychain",
      inspection: "unavailable",
      deletion: "disabled",
      reason: "DISABLED",
      deletionScopes: [],
    },
    stores: [
      {
        kind: "user_defaults_suite",
        identifier: "group.fixture",
        sharing: "app_group",
        appGroup: "group.fixture",
        coordination: "uncoordinated",
        query: "supported",
      },
    ],
  };

  async discoverIosStorage(appId: string): Promise<IosStorageDiscovery> {
    this.calls.push(appId);
    if (this.failure) {
      throw this.failure;
    }
    return this.discovery;
  }
}
