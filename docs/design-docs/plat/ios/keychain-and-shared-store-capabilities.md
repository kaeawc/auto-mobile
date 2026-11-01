# iOS Keychain and shared-store capabilities

The SDK's storage capability response (`POST /db/capabilities`, relayed by CtrlProxy as
`storage_capabilities_result`) reports two things clients must not guess (#5161): the
app's Keychain policy, and how each registered store is shared and coordinated. The
types live in `ios/sdk-wire` (`KeychainCapability`, `StorageStoreState`) so the SDK and
CtrlProxy encode one definition. The daemon reduces the payload to these fields
(`src/features/storage/iosStorageDiscovery.ts`) and folds them into the
`automobile:devices/{deviceId}/storage/capabilities` resource.

## Keychain contract

- **No values.** The capability and every Keychain route carry selectors only:
  item class, service, account and access group. The daemon's schema drops any other
  field, so a value cannot reach a client even if a future SDK sent one.
- **Inspection is unavailable.** There is no read path. An inspection adapter, if one
  is added, must be host-provided and opt-in, must name exact items in an allowlist,
  must redact per field and bound value size before anything leaves the app, and must
  emit an audit event per read. Until then `inspection` is `unavailable` and the
  `secure_state` `read` operation stays unavailable.
- **Deletion is exact.** `deletion` is `enabled` only when the host set
  `allowKeychainDeletion` and allowlisted at least one entry in
  `allowedKeychainDeletionEntries`, both on its `StorageInspectionConfiguration`; `deletionScopes` is that
  allowlist, sorted. It is the same set `/keychain/delete` (the `deleteKeychainItem`
  tool) matches byte for byte. Reporting a scope does not authorize a call: each delete
  still passes the confirmation, app-id and storage mutation gates.
- **No reset or write.** Deleting allowlisted items is not a namespace reset, so
  `namespace_reset` and `write` stay unsupported. `resetKeychain` is the separate,
  simulator-wide reset.
- **Unknown is not disabled.** An SDK that predates this field, or a malformed
  capability, is reported as `deletion: unknown` with `SDK_TOO_OLD`; an unreachable
  runner as `BRIDGE_UNAVAILABLE`. The storage routes exist only in Debug builds, so a
  release build is always unreachable here.

## Store states

Each registered app-group UserDefaults suite and Core Data store becomes one
`StorageStoreState`:

| `kind`                | `sharing`                                                                 | `coordination`                                                                 | `query`                                             |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `user_defaults_suite` | always `app_group`                                                        | declared at `registerAppGroupSuite(_:coordination:)`                           | `supported`                                         |
| `core_data`           | `app_group` when the registration names an `appGroup`, else `app_private` | `single_process` when app-private; otherwise declared, default `uncoordinated` | `supported` with a fetcher; otherwise `unsupported` |

Hosts declare it at registration:
`DatabaseInspector.shared.registerAppGroupSuite("group.example", coordination: .hostCoordinated)`
for suites, and `CoreDataStoreRegistration(identifier:appGroup:coordination:)` for Core Data.
Coordination is always the host's declaration. The SDK does not probe containers or
file locks to infer it; re-registering a suite replaces the earlier declaration.

Core Data reads use `sqlQuery` with `store`, `entity`, and optional positive `limit`.
The host supplies `CoreDataReadOnlyFetching` on its registration; the SDK never
opens a writer or issues SQL for this mode. The host fetches through its existing
coordinator/context without saving or changing objects, returns at most the requested
rows, and reports whether more exist with `truncated`. Metadata Codable excludes
the runtime fetcher; decoded registrations remain unsupported until the host supplies one.

The `query_core_data` CtrlProxy command relays `CoreDataQueryRequest` to
`POST /db/core-data/query`; `CoreDataQueryResult` carries attribute columns, nullable
string rows, and truncation. The runner reuses the query-result response envelope.
The SDK checks inspection enablement, exact store registration and entity membership,
clamps the requested limit to `maxRows`, redacts sensitive columns, and enforces
`maxBytes`. A host over-return is trimmed and marked truncated. Unknown registrations
return `unknown_core_data_store` or `unknown_core_data_entity`; missing fetchers return
`core_data_query_unavailable`. These reads bypass SQL classification and mutation tokens.
