# iOS `user_files` provider

Status: accepted for implementation in #5807. This decision records the
research and simulator experiment from #5806. The TypeScript staging provider
and the managed fixture app (`ios/FilesFixture`) are implemented; the production
picker verifier is not yet shipped in this repo. Unit tests use injected fakes; no new device-backed
verification is claimed here.

## Decision

Implement iOS Simulator `putAppFile` `target.domain: "user_files"` through a
managed AutoMobile fixture-provider app. The provider app must enable both
`UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace`; iOS then exposes
its `Documents` directory through the local File Provider and the Files document
picker. The staging adapter resolves the provider app's data container at runtime
with `simctl get_app_container <udid> <provider-bundle-id> data`; it must never
derive or persist a CoreSimulator path.

The provider writes only:

```text
<resolved provider data container>/Documents/automobile/<namespace>/<relative destination>
```

`namespace` keeps its existing one-directory validation and `reset: true` may
delete only that resolved `automobile/<namespace>` directory after checking the
resolved target remains below the provider's `Documents/automobile` root. It
must not reset Files, `Documents`, another namespace, or a caller-supplied host
path.

The daemon builds the fixture on first use with
`xcrun --sdk iphonesimulator swiftc`, caching the signed bundle under the AutoMobile data
directory by a digest of the sources, plist, simulator SDK version and host architecture. That digest is
also the app's numeric `CFBundleVersion`, so `simctl listapps` shows whether the
installed copy is current. Before a write, the installer installs or updates the
app (`simctl install` over an existing bundle keeps its data container) and the
write reports a `provider_install` effect only when it changed something. The
Swift sources and plist are inlined into the daemon bundle, so no checkout is
needed. Builder and installer failures are `IosFilesFixtureUnavailableError`
(`toolchain_unavailable`, `build_failed`, `install_failed`) and a physical UDID is
rejected before either runs.

The Playground configuration and `PlaygroundFilesPickerUITests` are an
experiment harness. #5807 must use a dedicated, internally owned fixture app
instead of treating Playground as the runtime provider.

## What is and is not supported

| Target                              | Status                | Behavior                                                                                                          |
| ----------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| iOS Simulator                       | supported after #5807 | Stage in the managed provider's bounded Documents namespace.                                                      |
| iOS physical device                 | unsupported           | `simctl` cannot resolve or mutate an on-device app container; do not infer support from the simulator.            |
| Direct Files local-provider storage | unsupported           | No public `simctl` staging command exists, and internal provider paths are not an AutoMobile API.                 |
| A custom File Provider extension    | not selected          | Apple positions one for apps that provide and sync remote documents; it is unnecessary for local fixture sharing. |

A future physical-device implementation requires explicit app integration: an
`IosFilesFixtureClient` seam owned by the installed fixture app, with an opt-in
on-device staging protocol and a real-device picker test. A connection, signing
identity, or generic `app_containers` access alone is not that opt-in.

## Effects, capabilities, and resources

The #5807 provider should report two independent facts:

- `host_stage: completed` only after the bounded copy succeeds in the resolved
  provider container.
- `document_picker: unavailable` unless a document-picker verifier has observed
  the exact logical destination. A copied host file must not be reported as
  picker-visible by inference.

`user_files` does not gain a public list/read resource in this slice. Existing
app-container resources remain scoped to an explicit app id and container; they
are not a Files-provider browsing API. The completion payload and the
document-picker verifier are the observation surfaces for this domain.

The capability resource reports the prerequisite satisfied (write and reset
supported) once the fixture app is observed installed. A missing or unprobed
fixture leaves it pending (partial) because the first write installs it; only an
absent provider makes writes unavailable. Physical iOS remains
unsupported regardless of `iosFileIntegration`. Picker visibility is still a
separate effect, unavailable unless observed.

## Verification contract for #5807

The implementation needs fakes for both seams:

1. `IosFilesFixtureContainer` resolves the provider data container and performs
   bounded mkdir/copy/reset operations. Unit tests cover traversal rejection,
   exact-namespace reset, and a physical-UDID rejection before any command.
2. `DocumentPickerVisibilityVerifier` is responsible for the separate
   picker-visible effect. Its simulator integration test stages one text or PDF
   fixture, opens `UIDocumentPickerViewController`, selects that exact fixture,
   and asserts the delegate result.

Run `scripts/ios/put-app-file-picker-smoke.sh [simulator-udid]` for the
device-backed proof. On 2026-08-28 it passed on an iPhone 15 Pro simulator
running iOS 17.5 with Xcode 26.3 (build 17C529): the picker identified the
source as `com.apple.FileProvider.LocalStorage`, displayed the bounded fixture,
and returned `automobile-files-probe.txt` after selection.

## Evidence

Apple documents that the document picker accesses files outside an app's
sandbox, that its `directoryURL` selects the initial location, and that enabling
both File Sharing and open-in-place makes an app's Documents directory appear in
Files. The `simctl` help on the tested Xcode exposes `get_app_container` and
media-only `addmedia`, but no command for Files-provider storage.

- Apple: UIDocumentPickerViewController
  <https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller>
- Apple: File Provider
  <https://developer.apple.com/documentation/fileprovider>
- Apple: Launch Services keys
  <https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html>
