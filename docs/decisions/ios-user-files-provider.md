# iOS `user_files` provider

Status: implemented by #5807. The production provider uses the dedicated
`ios/FilesFixtureProvider` app; the Playground remains only the #5806 research
harness.

## Decision

Implement iOS Simulator `putAppFile` `target.domain: "user_files"` through a
managed AutoMobile fixture-provider app. The provider app must enable both
`UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace`; iOS then exposes
its `Documents` directory through the local File Provider and the Files document
picker. The staging adapter resolves the provider app's data container at runtime
with `simctl get_app_container <udid> <provider-bundle-id> data`; it must never
derive or persist a CoreSimulator path.

The npm package ships this small provider's Xcode project under `dist/ios`.
On the first `putAppFile` call for a simulator where the app is missing,
AutoMobile builds it through the existing argv-safe Xcode boundary, installs it
with `simctl`, verifies that its container resolves, and then stages the batch.
No separate repository clone or manual app build is required beyond the Xcode
toolchain already needed for iOS Simulator automation.

The provider writes only:

```text
<resolved provider data container>/Documents/automobile/<namespace>/<relative destination>
```

`namespace` keeps its existing one-directory validation and `reset: true` may
delete only that resolved `automobile/<namespace>` directory after checking the
resolved target remains below the provider's `Documents/automobile` root. It
must not reset Files, `Documents`, another namespace, or a caller-supplied host
path.

The Playground configuration and `PlaygroundFilesPickerUITests` remain an
experiment harness. Production uses the dedicated, internally owned
`FilesFixtureProvider` app instead of treating Playground as the runtime
provider.

## What is and is not supported

| Target                              | Status       | Behavior                                                                                                          |
| ----------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| iOS Simulator                       | supported    | Stage in the installed managed provider's bounded Documents namespace.                                            |
| iOS physical device                 | unsupported  | `simctl` cannot resolve or mutate an on-device app container; do not infer support from the simulator.            |
| Direct Files local-provider storage | unsupported  | No public `simctl` staging command exists, and internal provider paths are not an AutoMobile API.                 |
| A custom File Provider extension    | not selected | Apple positions one for apps that provide and sync remote documents; it is unnecessary for local fixture sharing. |

A future physical-device implementation requires explicit app integration: an
`IosFilesFixtureClient` seam owned by the installed fixture app, with an opt-in
on-device staging protocol and a real-device picker test. A connection, signing
identity, or generic `app_containers` access alone is not that opt-in.

## Effects, capabilities, and resources

The provider reports two independent facts:

- `host_stage: completed` only after the bounded copy succeeds in the resolved
  provider container.
- `document_picker: unavailable` unless a document-picker verifier has observed
  the exact logical destination, staged bytes, and staging generation. The
  generation persists across an identical repeat write so the result can be
  queried after picker selection, but namespace reset creates a new generation
  and invalidates stale evidence. A copied host file must not be reported as
  picker-visible by inference.

`user_files` does not gain a public list/read resource in this slice. Existing
app-container resources remain scoped to an explicit app id and container; they
are not a Files-provider browsing API. The completion payload and the
document-picker verifier are the observation surfaces for this domain.

The storage capability descriptor reports iOS Simulator writes and namespace
reset as supported when the fixture app is installed or the packaged project
and Xcode toolchain make first-use installation available. A missing package or
Xcode toolchain is unavailable, an unprobed simulator is partial, and physical
iOS remains unsupported regardless of `iosFileIntegration`.

## Verification

The implementation uses fakes for both seams:

1. `IosFilesFixtureContainer` resolves the provider data container and performs
   bounded mkdir/copy/reset operations. Unit tests cover traversal rejection,
   exact-namespace reset, and a physical-UDID rejection before any command.
2. `DocumentPickerVisibilityVerifier` is responsible for the separate
   picker-visible effect. Its simulator integration test stages one text or PDF
   fixture, opens `UIDocumentPickerViewController`, selects that exact fixture,
   and asserts the delegate result.

Run `scripts/ios/put-app-file-picker-smoke.sh [simulator-udid]` for the
device-backed proof. On 2026-08-28 it passed on an iPhone 15 Pro simulator
running iOS 17.5 with Xcode 26.3 (build 17C529): `putAppFile` staged the unique
fixture, the real picker returned `issue-5807-fixture.txt`, and a second write
matched the provider-authored logical-path, byte-count, and SHA-256 marker.

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
