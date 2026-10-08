# SDK capabilities

Read `automobile:devices/{deviceId}/sdk/capabilities` to learn which AutoMobile SDK
features the app on an Android device exposes and what its capture policy allows.
The read goes through the connected CtrlProxy (`get_sdk_capabilities`) to the app's
debug SDK bridge. Add `?appId={packageName}` to name an app; without it the
foreground app of the device is used.

## Response

The JSON envelope carries `schemaVersion` (this envelope's version), `deviceId`,
`appId` (null when none could be determined) and `result`.

- `result.status: "available"` with a `snapshot`:
  - `schemaVersion`: the SDK snapshot's own version. Versions of 1 and above share
    the version 1 structure and unknown keys are dropped.
  - `capabilities`: `{ id, state, reason? }` entries. `state` is one of
    `SUPPORTED`, `DISABLED`, `UNSUPPORTED`, `PERMISSION_DENIED`, `NOT_INITIALIZED`
    or `UNKNOWN`. A state string written by a newer SDK is reported as `UNKNOWN`.
  - `policy`: `captureHeaders`, `captureBodies` and `allowMutations`, each false
    unless the app enabled it.
- `result.status: "unavailable"` with a `reason`. An unavailable result is never an
  empty capability set:
  - `CTRLPROXY_UNSUPPORTED`: the installed CtrlProxy APK predates
    `get_sdk_capabilities`.
  - `CTRLPROXY_UNREACHABLE`: CtrlProxy could not be reached on the device.
  - `BRIDGE_NOT_INSTALLED`: the app ships no debug SDK that exposes the snapshot
    (an older SDK or a release build).
  - `BRIDGE_UNAVAILABLE`: the app's bridge exists but did not answer.
  - `MALFORMED_RESPONSE`: the bridge answered with data that does not match the
    snapshot schema, including a capability without a string `state` or an
    outcome other than `ok` or `unavailable`.
  - `REQUEST_TIMEOUT`: CtrlProxy did not answer in time.
  - `NO_APP`: no `appId` was given and no foreground app was found.
  - `UNSUPPORTED_PLATFORM`: the device is not Android.

When the device or app cannot be resolved the envelope carries an `error` string
instead of `result`.

The resource reports the app's current state; it does not change any capability or
policy. The capability states for storage features are a separate resource, see
[Storage capabilities](storage-capabilities.md).
