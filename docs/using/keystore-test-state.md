# Keystore test state

Android Keystore test state is opt-in, disabled by default, and available
only in the AutoMobile SDK debug variant of the app. The app declares an exact
scope name and an explicit set of aliases; prefixes, globs, and cross-app access
are not supported.

Discovery comes from the `secure_state` domain of the
[storage capabilities](storage-capabilities.md) resource.

## Response

The JSON response contains:

| Field                   | Meaning                                       |
| ----------------------- | --------------------------------------------- |
| `capability`, `outcome` | The capability and its result                 |
| `reason`                | Optional stable code (see below)              |
| `bridgeAvailable`       | Whether the app's SDK bridge is reachable     |
| `metadata`              | `supported`                                   |
| `mutation`              | `declared_unsupported`                        |
| `deviceLocked`          | `locked`, `unlocked`, or `unknown`            |
| `scopes`                | Sorted declared scopes (hidden when disabled) |

Branch on `reason`, not on error text: `BRIDGE_NOT_INSTALLED`, `DISABLED`,
`BRIDGE_UNAVAILABLE`, or `DECLARED_UNSUPPORTED`. An old CtrlProxy APK reports
`unsupported` / `DECLARED_UNSUPPORTED`; update the APK to get discovery.

`deviceLocked: locked` reports the device lock state but does not block metadata
reads. Deletion can report per-alias `locked` and `authentication_required` outcomes.

## Android scoped deletion

Call `resetKeychain` with `appId`, an explicit device target (`deviceId`, `device`,
or `sessionUuid`), and `scope` and/or `alias`. A scope deletes every exact alias
registered in that scope. An alias alone is allowed when declared in any scope;
with a scope it must belong to that scope. An empty selector is rejected.

The app must enable Keystore test state, declare the selected aliases, and enable
both its storage mutation capability and mutation policy. Android does not use
`confirm` and requires no session. No keys are created or re-provisioned.

The result reports `scope: "app"`, `requestedScope`/`requestedAlias`, `deletedCount`
and one outcome per attempted alias: `deleted`, `not_found`, `locked`,
`authentication_required`, or `failed`. Every selected alias is attempted. Overall
`status` is `deleted` when all are deleted, `partial` when some are deleted, and
`failed` when none are deleted (including when all are absent). `success` is true
only for `deleted`; partial and failed results are tool errors. Only identifiers
and counts are returned, never key material.

Request-level refusals have an `outcome` and `reason`, zero deleted count and no
per-alias results: `disabled` / `DISABLED`, `scope_not_declared` /
`SCOPE_NOT_DECLARED`, `authorization_denied` / `MUTATION_NOT_ALLOWED`,
`invalid_selector` / `EMPTY_SELECTOR`, `unsupported` / `DECLARED_UNSUPPORTED`, or
`unavailable` / `BRIDGE_NOT_INSTALLED` or `BRIDGE_UNAVAILABLE`. Enable the app's
opt-in and mutation policy, correct its declarations, or install/update its debug
bridge and CtrlProxy as indicated. Unlock or use the app's normal authentication
flow for protected keys; AutoMobile does not bypass authentication. A transport
timeout leaves deletion completion uncertain; inspect app state before retrying.

Discovery retains `mutation: "declared_unsupported"` for compatibility; it does
not advertise deletion authorization. `secure_state.read` remains unavailable.
The provider and its discovery/deletion calls are absent from release builds.
Package-data reset remains a separate operation. On iOS Simulator,
`resetKeychain` still requires `confirm: true` and clears every app's Keychain.

## iOS Keychain item deletion

`deleteKeychainItem` deletes one app-owned generic-password item through the debug
AutoMobile SDK. It is disabled by default and requires embedded-SDK mode. The app
must opt in with `StorageInspectionConfiguration.allowKeychainDeletion` and
`allowedKeychainDeletionEntries`, declaring each exact service/account/access-group
tuple. Storage mutations and host authorization must also be enabled, with an
authorized active session or a launch-scoped mutation token.

Call with `appId`, `selector: { itemClass: "genericPassword", service, account,
accessGroup }`, and `confirm: true`. All selector fields must be nonempty. Bring the
app to the foreground first. Wildcards, batch deletion, secret export, and
interactive authentication are unavailable.

`deleted` returns the exact `deletedScope`. All other outcomes are tool errors:
`not_found`, `invalid_selector`, `unsupported_item_type`, `confirmation_required`,
`app_id_mismatch`, `scope_not_authorized`, `mutation_not_authorized`,
`protected_data_unavailable`, `user_auth_required`, `entitlement_denied`,
`keychain_error`, or `sdk_unavailable`. Correct the selector, confirmation, app,
SDK configuration or authorization as indicated. Protected-data or authentication
failures require the app's normal user flow; the tool never prompts or bypasses it.
No values or secret bytes leave the app. This operation is separate from the
simulator-wide `resetKeychain` operation and does not enable Keychain inspection.
