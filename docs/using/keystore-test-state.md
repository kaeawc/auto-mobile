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
reads. The per-alias outcomes `locked` and `authentication_required` are reserved
and are not reported today.

## What is not supported

This feature is discovery only. `secure_state.read` stays unavailable, and all
mutation calls are unsupported. To reset an app's data, use the separate, explicit
package-data reset. Locked-device behavior, authenticated or StrongBox keys, and
Keychain on iOS are not covered.

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
