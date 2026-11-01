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

Android `secure_state.write` and `secure_state.namespace_reset` remain `unsupported`.
Use `resetKeychain` with a declared scope or alias for scoped alias deletion;
it does not write aliases or reset package data.

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
storage mutation authorization (`--allow-storage-mutations`). If deletion is `disabled`,
ask the app's developers to turn on Keychain deletion in the app's AutoMobile SDK
configuration and allowlist the exact items.

## iOS shared stores

On iOS, `key_value.stores` lists the app-group UserDefaults suites the app registered,
and `databases.stores` lists its registered Core Data stores. Each entry states:

- `sharing`: `app_private`, or `app_group` when other processes such as app extensions
  can open the store.
- `coordination`: `single_process` for an app-private store; for a shared one,
  `host_coordinated` when the app declared that it coordinates cross-process access, and
  `uncoordinated` otherwise. An uncoordinated read is a point-in-time snapshot that
  another process may change at any moment.
- `query`: `supported` for suites and Core Data stores with read access enabled by
  the app; `unsupported` for Core Data registrations without read access.

Coordination is whatever the app declared when it registered the store; AutoMobile does
not infer it. Treat an `uncoordinated` shared store as one that can change between reads.

## Querying databases

`sqlQuery` accepts `appId` and exactly one of these parameter pairs:

- `databasePath` and `query`: execute SQL on an app SQLite database. On Android,
  the path may also be a file name in the app databases directory.
- `store` and `entity`: fetch attributes from a registered Core Data entity on iOS.
  Omit `databasePath` and `query`. Optional `limit` is a positive integer, defaults
  to the app's row limit, and is clamped to that limit. `limit` is only accepted
  in this mode. Use a store whose `query` capability is `supported`.

For example: `sqlQuery({appId: "com.example.app", store: "Main", entity: "Item", limit: 10})`.
Core Data reads return `type: "query"`, `columns`, `rows` (strings or nulls),
`truncated`, and a message. `truncated: true` means additional rows exist or the
response was shortened to meet the app's row or byte limit. Sensitive attributes
are redacted. These reads never require storage mutation authorization.

Core Data queries require iOS and the app's Debug storage inspection support.
For `unknown_core_data_store`, use a store identifier listed in `databases.stores` in
the storage capabilities resource. For `unknown_core_data_entity`, use one of that
store's registered entity names. For `core_data_query_unavailable`, the app registered
only metadata for that store; ask the app developer to enable read access.
`db_inspection_disabled` requires enabling inspection in the app.
`core_data_fetch_failed` means the fetch threw inside the app; check the app logs.
`response_too_large` means even the column metadata exceeds the app's response limit. Invalid or mixed parameter pairs are rejected before execution.
