# Storage capabilities

Read `automobile:devices/{deviceId}/storage/capabilities?appId={packageName}` to
learn which storage features a device and app support.

- App-container, user-files, and media-library features are reported as
  unavailable when the device or app cannot support them (for example, a missing
  write provider).
- The platform-neutral `secure_state` domain reports Android's single
  `storage.keystore` capability, or iOS's single `storage.keychain` capability.
  Without an app scope, or when the app has not enabled the embedded SDK, no
  discovery is attempted.

See [Keystore test state](keystore-test-state.md) for the Android `secure_state` response and
[Keystore metadata](keystore-metadata.md) for inspecting aliases from app tests.

## iOS Keychain

`storage.keychain` never contains a Keychain value.

| Field            | Meaning                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspection`     | Always `unavailable`: AutoMobile does not read Keychain values.                                                                                                     |
| `deletion`       | `enabled` when the app allows deleting at least one exact item; otherwise `disabled`. `unknown` when the app's SDK is too old to report it or could not be reached. |
| `reason`         | Why deletion is not enabled: `DISABLED`, `NO_ALLOWLISTED_SCOPES`, `SDK_TOO_OLD` or `BRIDGE_UNAVAILABLE`.                                                            |
| `deletionScopes` | The exact items `deleteKeychainItem` may delete (item class, service, account, access group). Empty unless deletion is enabled.                                     |

Deletion is the only Keychain change AutoMobile makes, so `read`, `write` and
`namespace_reset` stay closed even when deletion is enabled. Each delete still needs
storage mutation authorization (`--allow-storage-mutations`). To enable it, the app sets
`allowKeychainDeletion` and lists each item in `allowedKeychainDeletionEntries` on its
`StorageInspectionConfiguration`.

## iOS shared stores

On iOS, `key_value.stores` lists the app-group UserDefaults suites the app registered,
and `databases.stores` lists its registered Core Data stores. Each entry states:

- `sharing`: `app_private`, or `app_group` when other processes such as app extensions
  can open the store.
- `coordination`: `single_process` for an app-private store; for a shared one,
  `host_coordinated` when the app declared that it coordinates cross-process access, and
  `uncoordinated` otherwise. An uncoordinated read is a point-in-time snapshot that
  another process may change at any moment.
- `query`: `supported` for suites; `unsupported` for Core Data stores, which can be
  registered but not queried yet.

The app declares coordination when it registers a store:
`DatabaseInspector.shared.registerAppGroupSuite("group.example", coordination: .hostCoordinated)`,
or `CoreDataStoreRegistration(identifier:appGroup:coordination:)` for Core Data.
