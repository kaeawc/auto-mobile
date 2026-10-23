# Storage capabilities

Read `automobile:devices/{deviceId}/storage/capabilities?appId={packageName}` to
learn which storage features a device and app support.

- App-container, user-files, and media-library features are reported as
  unavailable when the device or app cannot support them (for example, a missing
  write provider).
- The platform-neutral `secure_state` domain reports Android's single
  `storage.keystore` capability. Without an app scope, or when the app has not
  enabled the embedded SDK, no discovery is attempted. iOS does not report a
  secure-state capability today.

See [Keystore test state](keystore-test-state.md) for the `secure_state` response and
[Keystore metadata](keystore-metadata.md) for inspecting aliases from app tests.
