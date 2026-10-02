# Storage capabilities and Android Keystore test state

Read `automobile:devices/{deviceId}/storage/capabilities?appId={packageName}` to
negotiate storage features. The platform-neutral `secure_state` domain reports
Android's single `storage.keystore` capability through the typed CtrlProxy
`discover_keystore` request. No app scope or disabled embedded-SDK configuration
means no discovery is attempted. iOS secure-state policy remains owned by #5161.

KeystoreTestState is a code-only opt-in, disabled by default. The app declares an
exact scope name and explicit alias set; no prefixes, globs, or cross-app access.
The provider exists only in the SDK debug variant and executes in the target
app's security context under the existing shell/root/self/CtrlProxy caller check.
This contract is implemented for Android only in this change. Any iOS (Keychain)
counterpart is a future implementation that must follow the same written
contract: explicit app opt-in, exact allowlists, caller authorization, no secret
export, and explicit support boundaries. It is tracked by #5161 and does not
exist today. No shared gate is extracted here.

The version-1 JSON envelope contains `capability`, `outcome`, optional stable
`reason`, `bridgeAvailable`, `metadata: supported`,
`mutation: declared_unsupported`, `deviceLocked: locked|unlocked|unknown`, and
sorted declared `scopes`. Disabled responses hide scope names and do not invoke the device-lock probe. Host discovery
reports `BRIDGE_NOT_INSTALLED` from provider resolution, independently of
`DISABLED`, `BRIDGE_UNAVAILABLE`, or `DECLARED_UNSUPPORTED`; clients never parse
error text. Metadata support describes the bridge contract, while `outcome`
reports its current availability.

The SDK provider's `metadata` call accepts a required exact `scope` and optional
exact `alias`. It reports only `alias`, `present`, and
`category: KEY|CERTIFICATE|UNKNOWN`. `present: false` means **not present or not
observable**, with category `UNKNOWN`. AndroidKeyStore swallows metadata lookup
errors, making a Keystore daemon failure indistinguishable from an absent alias.
Category detection uses only `isKeyEntry` / `isCertificateEntry`, directly
implemented by the SPI. Key entries report `KEY`: distinguishing secret from
private keys would require loading material (including certificates through
`entryInstanceOf`). `SECRET_KEY` and `PRIVATE_KEY` remain reserved contract values. Undeclared aliases return `SCOPE_NOT_DECLARED`
without touching Keystore, whether the alias exists or not. No keys, private
keys, certificates, certificate chains, values, or credential bytes are returned.

The injected device-lock probe reports `deviceLocked: locked` from device lock
state but never blocks metadata reads. Per-alias `locked` and
`authentication_required` are **reserved** outcomes that the current read-only
metadata path cannot observe on real devices. Fake-backend contract tests retain
the typed exception mappings for future slices; they do not prove real-device
behavior. Error messages are logged locally and not serialized.

The debug-only provider contributes the flat `storage.keystore` descriptor through
`AutoMobileSDK.registerCapability` on creation and after an authorized call (to
restore it after SDK shutdown). Release builds contain no provider contribution.
An old CtrlProxy APK without the optional `discover_keystore` advertisement
consistently reports `unsupported` / `DECLARED_UNSUPPORTED` on every read.

This slice exposes host **capability discovery only**. Existing key-value tools
return values and database tools return tables, neither a natural alias-metadata
surface, so `secure_state.read` stays unavailable. The SDK read-only endpoint is
available to app tests. All mutation calls are unsupported; package-data reset
is separate and explicit. Scoped mutation is tracked by #5190.

Device-backed categories, locked-device behavior, authenticated/StrongBox keys,
shell/CtrlProxy reachability, and release authority absence still require a
separate device fixture validation.
