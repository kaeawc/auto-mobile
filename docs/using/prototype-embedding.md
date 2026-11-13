# Embedding a prototype in an app

You can drop a prototype shown with the `prototype` tool into a real Android or iOS app. The app
uses the same renderer as CtrlProxy and the iOS prototype agent, published as a library. Every
part of the spec keeps working: layout, theme, state, data, `request` actions, storage, images and
fonts. AutoMobile generates only a short host file per app, and the renderer draws the rest.

To view a prototype in a browser or export it as HTML, see
[Prototype web preview](prototype-web-preview.md).

## Add the library

**Android** (Jetpack Compose). The renderer is not on Maven Central yet. Build it from the release
tag and publish it to your local Maven repository (`~/.m2`). This needs JDK 21 and an Android SDK
(`ANDROID_HOME` set, or `sdk.dir` in `android/local.properties`):

```bash
git clone --depth 1 --branch <version> https://github.com/kaeawc/auto-mobile.git
cd auto-mobile/android
./gradlew :protocol:publishToMavenLocal :prototype-compose:publishToMavenLocal -PVERSION_NAME=<version>
```

Then add `mavenLocal()` to the app's repositories and depend on it:

```kotlin
dependencies {
  implementation("dev.jasonpearson.auto-mobile:auto-mobile-prototype-compose:<version>")
}
```

The renderer brings its Compose BOM and consumer R8 rules, so a minified release build needs no
extra keep rules.

**iOS** (SwiftUI), with Swift Package Manager:

```swift
.package(url: "https://github.com/kaeawc/auto-mobile", from: "<version>"),
// target dependency:
.product(name: "AutoMobilePrototype", package: "auto-mobile"),
```

Use the version the resource reports (below): the first library version that renders the whole
spec.

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

## Read one Compose or SwiftUI file

For a single file to paste into an app, read `automobile:prototype/<id>/compose` (Kotlin,
`text/x-kotlin`) or `automobile:prototype/<id>/swiftui` (Swift, `text/x-swift`) for a prototype
shown in this daemon session.

| Parameter      | Meaning                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame`        | A device frame id such as `pixel-9` or `iphone-16`, used to size the preview. Defaults to `pixel-9` for Compose and `iphone-16` for SwiftUI. |
| `revision`     | A kept revision. Defaults to the latest.                                                                                                     |
| `mcpSessionId` | Only revisions this MCP session produced. Defaults to every session's.                                                                       |

The file is the same host the native resource generates. It builds the spec in as a string
constant and adds a `@Preview` (Compose) or `#Preview` (SwiftUI) sized to the frame. Its header
comment names the library to add and the capabilities the spec needs. It also lists each
referenced image or font with the path the file loads it from and its
`automobile:prototype/native/asset` URI.

The file does not build in assets: add those files yourself. A saved prototype serves their bytes
from the URI. Revisions, errors, `_meta` (without `variants`) and subscriptions work as for the
[web page](prototype-web-preview.md). `resources/list` lists both files for every prototype shown
in this daemon session.

## Eject to code you own

To replace a prototype with screens you write and style by hand, read `automobile:prototype/eject?id=<id>` once and edit
the result. It takes the same `id`, `platform` and `deviceId` parameters as the native resource.
Nothing syncs back to the spec.

The result is JSON:

| Field        | Meaning                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `files`      | One file: `app/src/main/java/prototypes/eject/<Type>.kt` (Jetpack Compose, Material 3) or `<Type>.swift` (SwiftUI). No library is needed. |
| `scaffolded` | Node types written as real code.                                                                                                          |
| `remaining`  | What is left for you, by spec path: `node` (an unsupported node), `action` (an action other than stack navigation) or `binding`.          |
| `notes`      | Limits of the scaffold for this prototype.                                                                                                |

What the scaffold writes:

- `box`, `row`, `column`, `card`, `scroll`, `spacer`, `divider`, `text`, `button`, `textField`,
  `list`, `listItem` and `stack` become native code.
- Stack screens become their own functions or views. `push`, `replace`, `pop` and `popToRoot`
  drive a back stack in the generated state class. That class also holds text field values,
  seeded from string `state`.
- Every other node becomes a placeholder with an `(eject)` comment that keeps its `testTag` and
  children.
- Styles, conditions, data placeholders such as `{item.name}` and other actions stay as written or
  as `(eject)` comments. A list shows as many rows as its data had.
- Explicit theme color roles become a Material 3 color scheme or SwiftUI colors. A seeded scheme
  is not exported.
- Every `testTag` stays as `Modifier.testTag` or `.accessibilityIdentifier`, with `{index}` bound
  to the row index. Tests and flows recorded against the prototype can target the ejected screens.

## Where the files go

Copy each `files[].path` and `assets[].path` exactly as the resource returns it. The host file reads
from that directory, which is the id only when the id is already file-safe (see below).

**Android:** `spec.json` and the assets go under `app/src/main/assets/prototypes/<directory>/`, and
the host file under `app/src/main/java/prototypes/`. Call the generated composable, for example
`CheckoutPrototype(onDismiss = { ... })`, from any screen.

**iOS:** `spec.json` and the assets go under `Prototypes/<directory>/`. Add the `Prototypes` folder
to the app target as a folder reference (blue folder), so the files keep their subdirectory in the
bundle. Add the host `.swift` file to the target outside that folder, since Xcode compiles nothing
inside a folder reference. Use the generated view, for example `CheckoutPrototype()`, in any
SwiftUI hierarchy.

An id that is not plain letters and digits gets a short hash in its type name. An id with
characters outside letters, digits, `-` and `_`, or more than 64 characters, also gets it in its
directory and file names. So `checkout-flow` becomes `CheckoutFlowPrototype` plus an 8-character
suffix. The host file's path names the type; pick a plain id such as `checkoutFlow` for a hash-free name.

On both platforms, a missing asset draws the renderer's placeholder and a missing spec shows its
load-error view.

An embedded prototype draws edge to edge inside the space the app gives it. An image with no
authored size takes its natural size. Place the composable inside the content area of your screen,
below any app bar or status bar. A custom layout that offsets it by less than the bar's height
hides the image row behind the bar.

## Requests

How `request` actions reach the network:

- **Android:** pass a device client, `PrototypeNetwork(device = myClient)`. Without one, every
  request fails with a typed `network` error. A `hostHandler` takes over host-routed requests (those
  with `via: "host"` or no `via`), for example to add authentication or serve canned responses.
  The app supplies its own HTTP client; the renderer ships none. On Android 17, a request to the
  emulator host alias `10.0.2.2` (a local-network address) times out until the app declares
  `android.permission.ACCESS_LOCAL_NETWORK` and the user grants it.
- **iOS:** the default `PrototypeNetworkConfiguration` uses the renderer's `URLSession` client with
  its egress checks. Pass `PrototypeNetworkConfiguration(hostHandler:)` to take over host-routed
  requests, or `deviceClient:` to replace the transport.

## Platform modules

On Android, supply app-owned modules through the renderer's `platform` parameter. The default
registers no app modules; measured device state remains available. Keep this configuration stable
across recompositions: replacing it reloads the prototype and cancels pending calls. Check the
configuration's `capabilities` against the spec's requirements. An unregistered call reports
`unsupported`; a module needing permission reports `permission_denied` without requesting it.
The app closes its modules after all renderers using them detach.

## Shrinking (R8)

Specs accept the [allowed prototype icons](prototype-icons.md), including all five Material styles.

The renderer looks up Android icons named in a spec by reflection, which R8 cannot see. The library
ships no consumer keep rule for them: one would retain all of `material-icons-extended` (about 3 MB
of dex) in every app. An app that minifies and renders icons by name adds the rule itself:

```
-keep class androidx.compose.material.icons.** { *; }
```

Narrow it to the icons your specs use if size matters, for example
`-keep class androidx.compose.material.icons.filled.HomeKt { *; }` per icon and style. An icon the
shrinker removed draws no glyph. The renderer then logs `Prototype icon '<name>' resolved in no
style` once per name at warn level. Apps that never shrink, and specs without icons, need nothing.

## Storage

When the spec has a `storage` block, the generated host opts in to file-backed storage
(`PrototypeStorage.fileBacked(context)` on Android, `.fileBacked` on iOS). The listed state and
data keys then survive app restarts. Specs without a `storage` block use no storage.

## Window options

Set `window.layoutDirection` to `"rtl"` to mirror a prototype, or `"ltr"` to force left-to-right
layout. Leave it out to follow the app's direction. For example:

```json
{ "placement": { "type": "fullscreen" }, "layoutDirection": "rtl" }
```

Use this object as the spec's `window`. The option changes only the prototype's layout; it does
not change the device locale or translate text. iOS supports it and requires
`prototype_layout_direction_v1`. Android refuses specs that set it; remove the option to show there.

Other optional window controls are `keepScreenOn`, `brightness`, `orientation` and `statusBar`.
They require `prototype_platform_window_controls_v1`, and AutoMobile refuses them when unsupported.
On Android, these controls and the `hideKeyboard` action work through CtrlProxy overlays, not the
embedded renderer. Overlay orientation is best effort. Inspect reports the requested `orientation`,
and reports `statusBar: "unsupported"` when the spec requested a status bar style.

## Capability errors

An app may ship an older renderer than the spec needs. The renderer never draws such a spec partly.
It shows a visible error state instead:

- On Android the `onError` slot draws it: the renderer's default view unless you pass your own.
- On iOS the renderer shows its diagnostic and calls `onLoadError`.

The generated host passes neither, so it shows the defaults; edit the host's call to pass them.
Compare `requiredCapabilities` with `AutoMobilePrototype.capabilities` (Android) or
`AutoMobilePrototypeCapabilities` (iOS) to check ahead of time.

## Not supported when embedded

- Overlay window placement: `window` placement and the overlay options (`layer`, `persistence`).
  An embedded prototype fills the space the app gives it.
- CtrlProxy-only chrome, such as the host dismiss bar and the two-finger dismiss gesture. The app
  decides what dismissal does through `onDismiss`.

## Samples

`samples/prototype-embedding/` in the AutoMobile repository holds the resource's output for one
sample prototype on each platform. Its request goes to `10.0.2.2`, the Android emulator's host
alias. The iOS egress checks refuse that address, loopback and `localhost`. On iOS, use the
machine's LAN address on a port other than the daemon's, or a `hostHandler`.
