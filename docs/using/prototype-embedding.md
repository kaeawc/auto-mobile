# Embedding a prototype in an app

A prototype shown with the `prototype` tool can be dropped into a real Android or iOS app. The app
uses the same renderer as CtrlProxy and the iOS prototype agent, published as a library, so every
part of the spec keeps working: layout, theme, state, data, `request` actions, storage, images and
fonts. Only a short host file is generated per app, and the renderer draws the rest.

## Add the library

**Android** (Jetpack Compose), from Maven Central:

```kotlin
dependencies {
  implementation("dev.jasonpearson.auto-mobile:auto-mobile-prototype-compose:<version>")
}
```

The renderer brings the Compose BOM it was built with and its consumer R8 rules, so a minified
release build works without extra keep rules.

**iOS** (SwiftUI), with Swift Package Manager:

```swift
.package(url: "https://github.com/kaeawc/auto-mobile", from: "<version>"),
// target dependency:
.product(name: "AutoMobilePrototype", package: "auto-mobile"),
```

Use the version the resource reports (below). The libraries are published in lockstep with the MCP
server, so the server that authored the spec names the first library version that renders all of it.

## Read the native resource

Ask the agent to read `automobile:prototype/native?id=<id>` for a prototype it is showing, or
`automobile:prototype/native?id=<id>&deviceId=<device>` for one that is saved but no longer shown.
Parameters:

| Parameter  | Meaning                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform` | `android` or `ios`. Defaults to the platform of the device that showed the prototype.                                                                               |
| `deviceId` | The device that showed or saved it. Required for a saved prototype that no device is showing, and when the id is shown on more than one device; otherwise optional. |

The JSON result holds:

- `library`: the Gradle coordinate or the Swift package to add.
- `requiredCapabilities` and `minimumLibraryVersion`: what the spec needs from the renderer.
- `files`: the spec (`spec.json`) and the host file, each with the path it goes to.
- `assets`: each referenced image or font, its path, and whether the host has its bytes. Read a
  saved prototype's bytes from the asset's `uri`, which is
  `automobile:prototype/native/asset?id=<id>&assetId=<asset>&deviceId=<device>`.
- `notes`: anything the app must still do, such as supplying asset files or an HTTP client.

## Where the files go

**Android:** `spec.json` and the assets go under `app/src/main/assets/prototypes/<id>/`, and the
host file under `app/src/main/java/prototypes/`. Call the generated composable, for example
`CheckoutPrototype(onDismiss = { ... })`, from any screen.

**iOS:** `spec.json` and the assets go under `Prototypes/<id>/`. Add the `Prototypes` folder to the
app target as a folder reference (blue folder) so the files keep their subdirectory in the bundle. Add
the host `.swift` file to the target outside that folder, since Xcode compiles nothing inside a folder
reference. Use the generated view, for example `CheckoutPrototype()`, in any SwiftUI hierarchy.

An id that is not plain letters and digits gets a short hash in its type and file names, so
`checkout-flow` becomes `CheckoutFlowPrototype` plus an 8-character suffix. That keeps two ids that
differ only in punctuation from overwriting each other's files. The host file's path names the
type; pick a plain id such as `checkoutFlow` for a hash-free name.

A missing asset falls back to the renderer's placeholder, and a missing spec shows the renderer's
load-error view, on both platforms.

## Requests

`request` actions follow the embedded routing decision
([prototype-embedded-request-routing](../decisions/prototype-embedded-request-routing.md)):

- **Android:** pass a device client, `PrototypeNetwork(device = myClient)`. Without one, every
  request fails with a typed `network` error. A `hostHandler` takes over host-routed requests (those
  with `via: "host"` or no `via`), for example to add authentication or serve canned responses.
- **iOS:** the default `PrototypeNetworkConfiguration` uses the renderer's `URLSession` client with
  its egress checks. Pass `PrototypeNetworkConfiguration(hostHandler:)` to take over host-routed
  requests, or `deviceClient:` to replace the transport.

## Storage

When the spec has a `storage` block, the generated host opts in to file-backed storage
(`PrototypeStorage.fileBacked(context)` on Android, `.fileBacked` on iOS), so the listed state and
data keys survive app restarts. Specs without a `storage` block use no storage.

## Capability errors

An app may ship an older renderer than the spec needs. The renderer never draws such a spec partly.
It reports an unsupported-spec error to `onError` (Android) or `onLoadError` (iOS) and shows a visible
error state instead. Compare `requiredCapabilities` with `AutoMobilePrototype.capabilities` (Android)
or `AutoMobilePrototypeCapabilities` (iOS) to check ahead of time.

## Not supported when embedded

- Overlay window placement: `window` placement and the overlay options (`layer`, `persistence`)
  describe CtrlProxy's overlay window. An embedded prototype fills the space the app gives it.
- CtrlProxy-only chrome, such as the host dismiss bar and the two-finger dismiss gesture. The app
  decides what dismissal does through `onDismiss`.

## Samples

`samples/prototype-embedding/` and the iOS `EmbedConsumer` fixture
(`ios/prototype-agent/Fixtures/EmbedConsumer`) hold the resource's output for
`test/fixtures/prototype-embedding/sample.json`, generated by
`bun scripts/prototype/generateEmbeddingSamples.ts`. CI checks that they match the resource output
and compiles both against the libraries: the Android sample in a minified consumer app
(`scripts/android/validate-prototype-compose-consumer.sh`) and the iOS one in the library build
(`scripts/ios/prototype-library-build.sh`).
