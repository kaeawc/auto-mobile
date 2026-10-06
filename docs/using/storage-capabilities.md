# Storage capabilities and Android Keystore test state

Read `automobile:devices/{deviceId}/storage/capabilities?appId={packageName}` to
negotiate storage features. The platform-neutral `secure_state` domain reports
Android's single `storage.keystore` capability through the typed CtrlProxy
`discover_keystore` request. No app scope or disabled embedded-SDK configuration
means no discovery is attempted. iOS secure-state policy remains owned by #5161.

App-container, user-files, and media-library operations derive from the registered
production provider instances, combined with device/prerequisite signals. Missing
write/list/read providers yield unavailable (or preserve a platform unsupported
state); reset and indexing require the write provider's feature declaration.
Bounded Android user-files list/read coverage comes separately from
`SharedStorageReadService`. Android user_files reports `namespace_reset` (only
the declared Downloads namespace) and optional `media_indexing`; media_library
reports write and indexing according to its provider. iOS Simulator imports have
no host MediaScanner indexing equivalent. Neither platform exposes media-library
list/read. Capability support describes the registered contract, not proof that
a device workflow has been verified.

Physical-Android `app_containers` resolves the debuggable app build prerequisite
per `appId` from the package's `pkgFlags`: list/read/write are supported when
`DEBUGGABLE` is present and unavailable when it is absent. Missing app scope or
an unverified package probe leaves the prerequisite partial. Provider coverage
still applies. Emulators and iOS do not use this probe.

iOS `user_files` writes and `namespace_reset` are Simulator-only and require the
managed Files fixture app (`dev.jasonpearson.automobile.FilesFixture`), not yet
shipped in this repo. `iosFilesFixtureInstalled: true` means its container was
verified and supports those operations; false means unavailable; an omitted
signal yields partial, pending verification. A missing registered provider
still yields unavailable. The capability resource currently leaves installation
unverified. `portable` remains false even though `platformScope` is cross-platform.
Physical iOS stays unsupported regardless of `iosFileIntegration`. iOS user-files
list/read are unavailable, and media indexing is unsupported. Picker visibility
is a separate write effect, unavailable unless an exact-destination verifier
observes it; host staging alone does not prove visibility. Only the historical
iOS 17.5 / iPhone 15 Pro Simulator experiment is device-tested (see the
[accepted design](../decisions/ios-user-files-provider.md)); this provider's tests
use fakes and do not establish physical-device support.

Canonical file resources use exact storage-domain names:
`automobile:devices/{deviceId}/storage-domains/app_containers/{appId}/{container}[/{path}]{?userId}`
and `automobile:devices/{deviceId}/storage-domains/user_files/{namespace}[/{path}]`
(the user-files resource is bounded Android Downloads only).
The app `.../apps/{appId}/files/{container}[/{path}]{?userId}` and bounded Downloads
`.../downloads/{namespace}[/{path}]` aliases remain supported until device
verification permits retirement; emitted write/list links remain aliases.
See [putAppFile's canonical examples and session policy](../tools.md).

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
