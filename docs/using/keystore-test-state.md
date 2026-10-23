# Keystore test state

Android only. Keystore test state is opt-in, disabled by default, and available
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
