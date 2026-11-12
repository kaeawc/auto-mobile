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

## Read one Compose or SwiftUI file

For a single file to paste into an app, read `automobile:prototype/<id>/compose` (Kotlin,
`text/x-kotlin`) or `automobile:prototype/<id>/swiftui` (Swift, `text/x-swift`) for a prototype
shown in this daemon session.

| Parameter      | Meaning                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame`        | A device frame id such as `pixel-9` or `iphone-16`, used to size the preview. Defaults to `pixel-9` for Compose and `iphone-16` for SwiftUI. |
| `revision`     | A kept revision. Defaults to the latest.                                                                                                     |
| `mcpSessionId` | Only revisions this MCP session produced (see below). Defaults to every session's.                                                           |

The file is the same host the native resource generates, with the spec built in as a string
constant and a `@Preview` (Compose) or `#Preview` (SwiftUI) sized to the frame. Its header comment
names the library to add and the capabilities the spec needs, and lists each referenced image or
font with the path the file loads it from and its `automobile:prototype/native/asset` URI. Assets
are not built in: add those files yourself (a saved prototype serves their bytes from the URI).
Revisions, errors, `_meta` (without `variants`) and subscriptions work as for the web page below,
and `resources/list` lists both files for every prototype shown in this daemon session.

## Eject to code you own

The resources above keep the renderer library and the spec in your app. To replace a prototype
with screens you write and style by hand, read `automobile:prototype/eject?id=<id>` (same `id`,
`platform` and `deviceId` parameters as the native resource) once and edit the result. Nothing is
regenerated or synced back to the spec afterwards.

The result is JSON:

| Field        | Meaning                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `files`      | One file: `app/src/main/java/prototypes/eject/<Type>.kt` (Jetpack Compose, Material 3) or `<Type>.swift` (SwiftUI). No library is needed. |
| `scaffolded` | Node types written as real code.                                                                                                          |
| `remaining`  | What is left for you, by spec path: `node` (an unsupported node), `action` (an action other than stack navigation) or `binding`.          |
| `notes`      | Limits of the scaffold for this prototype.                                                                                                |

`box`, `row`, `column`, `card`, `scroll`, `spacer`, `divider`, `text`, `button`, `textField`,
`list`, `listItem` and `stack` become native code. Stack screens become their own functions or
views, and `push`, `replace`, `pop` and `popToRoot` drive a back stack in the generated state
class, which also holds text field values (seeded from string `state`). Every other node becomes a
placeholder, marked with an `(eject)` comment, that keeps its `testTag` and children. Styles, conditions, data
placeholders such as `{item.name}` and other actions stay as written or as `(eject)` comments;
a list shows as many rows as its data had. Explicit theme color roles become a Material 3 color
scheme or SwiftUI colors; a seeded scheme is not exported.

Every `testTag` is kept as `Modifier.testTag` or `.accessibilityIdentifier`, with `{index}` bound
to the row index, so tests and flows recorded against the prototype can target the ejected
screens.

## Where the files go

Copy each `files[].path` and `assets[].path` exactly as the resource returns it. The host file reads
from that directory, which is the id only when the id is already file-safe (see below).

**Android:** `spec.json` and the assets go under `app/src/main/assets/prototypes/<directory>/`, and
the host file under `app/src/main/java/prototypes/`. Call the generated composable, for example
`CheckoutPrototype(onDismiss = { ... })`, from any screen.

**iOS:** `spec.json` and the assets go under `Prototypes/<directory>/`. Add the `Prototypes` folder to the
app target as a folder reference (blue folder) so the files keep their subdirectory in the bundle. Add
the host `.swift` file to the target outside that folder, since Xcode compiles nothing inside a folder
reference. Use the generated view, for example `CheckoutPrototype()`, in any SwiftUI hierarchy.

An id that is not plain letters and digits gets a short hash in its type name, and one with
characters outside letters, digits, `-` and `_`, or more than 64 characters, gets it in its
directory and file names too. So `checkout-flow` becomes `CheckoutFlowPrototype` plus an
8-character suffix. That keeps two ids that differ only in punctuation from overwriting each other's
files. The host file's path names the
type; pick a plain id such as `checkoutFlow` for a hash-free name.

A missing asset falls back to the renderer's placeholder, and a missing spec shows the renderer's
load-error view, on both platforms.

An embedded prototype draws edge to edge inside the space the app gives it, and an image with no
authored size takes its natural size. Place the composable inside the content area of your
screen, below any app bar or status bar. If a custom layout offsets it by a fixed pixel amount
that is smaller than the bar's height, the image row is laid out but hidden behind the bar, and the
text appears to start right under it.

## Requests

`request` actions follow the embedded routing decision
([prototype-embedded-request-routing](../decisions/prototype-embedded-request-routing.md)):

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

Android icons named in a spec are looked up by reflection, which R8 cannot see. The library ships no
consumer keep rule for them, because one would retain all of `material-icons-extended` (about 3 MB
of dex) in every app that embeds a prototype. An app that minifies and renders icons by name adds the
rule itself:

```
-keep class androidx.compose.material.icons.** { *; }
```

Narrow it to the icons your specs use if size matters, for example
`-keep class androidx.compose.material.icons.filled.HomeKt { *; }` per icon and style. An icon the
shrinker removed draws no glyph, and the renderer logs `Prototype icon '<name>' resolved in no style`
once per name at warn level. Apps that never shrink, and specs without icons, need nothing.

## Storage

When the spec has a `storage` block, the generated host opts in to file-backed storage
(`PrototypeStorage.fileBacked(context)` on Android, `.fileBacked` on iOS), so the listed state and
data keys survive app restarts. Specs without a `storage` block use no storage.

## Window options

Set `window.layoutDirection` to `"rtl"` to mirror a prototype, or `"ltr"` to force left-to-right
layout. Leave it out to follow the app's direction. For example:

```json
{ "placement": { "type": "fullscreen" }, "layoutDirection": "rtl" }
```

Use this object as the spec's `window`. The option changes only the prototype's layout; it does
not change the device locale or translate text. It is supported on iOS and requires
`prototype_layout_direction_v1`. Android refuses specs that set it; remove the option to show there.
Other optional window controls are `keepScreenOn`, `brightness`, `orientation` and `statusBar`;
these require `prototype_platform_window_controls_v1` and are refused when unsupported. On Android,
these controls and the `hideKeyboard` action are available through CtrlProxy overlays, not the embedded
renderer. Overlay orientation is best effort; inspect reports the requested `orientation` and reports
`statusBar: "unsupported"` when a status bar style was requested.

## Capability errors

An app may ship an older renderer than the spec needs. The renderer never draws such a spec partly.
It shows a visible error state instead: on Android the `onError` slot draws it (the renderer's default
view unless you pass your own), and on iOS the renderer shows its diagnostic and calls `onLoadError`.
The generated host passes neither, so it shows the defaults; edit the host's call to pass them. Compare `requiredCapabilities` with `AutoMobilePrototype.capabilities` (Android)
or `AutoMobilePrototypeCapabilities` (iOS) to check ahead of time.

## Not supported when embedded

- Overlay window placement: `window` placement and the overlay options (`layer`, `persistence`)
  describe CtrlProxy's overlay window. An embedded prototype fills the space the app gives it.
- CtrlProxy-only chrome, such as the host dismiss bar and the two-finger dismiss gesture. The app
  decides what dismissal does through `onDismiss`.

## Samples

`samples/prototype-embedding/` in the AutoMobile repository holds the resource's output for one
sample prototype on each platform: the Android host and assets, and the iOS spec. Its request goes to
`10.0.2.2`, the Android emulator's alias for the host machine. The iOS renderer's default egress
checks refuse that address, loopback and `localhost`, so on iOS point the request at the machine's
LAN address (private addresses are allowed on ports other than the daemon's) or serve it from a
`PrototypeNetworkConfiguration(hostHandler:)`.

## Preview as a web page

To look at a prototype without a device or an app, read `automobile:prototype/<id>/web`. It is one
self-contained HTML page (`text/html`, no network access) with the prototype in a device frame,
rotate and zoom controls, a screen picker when the prototype's stack has more than one screen, and
its revision history.

| Parameter      | Meaning                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `frame`        | A device frame id such as `pixel-9` or `iphone-16`. Defaults to the platform that showed the prototype. |
| `revision`     | A kept revision. Defaults to the latest.                                                                |
| `variant`      | The prototype id of the alternative to show first (see below).                                          |
| `mcpSessionId` | Only revisions this MCP session produced (see below). Defaults to every session's.                      |

Revision 1 is the first show of the id. Each later show and each patch that lands adds one; taps
and typing on the device do not. The last 20 revisions are kept, and an older one is an error that
names the oldest kept revision. The result's `_meta` reports `revision`, `deviceRevision` (the
device's own counter for that patch), `mcpSessionId` (the MCP session whose show or patch produced
the revision, when it had one), `revisions`, `variants`, `frame`, `sha256` and `rendererVersion`.

Every MCP session on the daemon shares one revision history, so another session's show can land
between yours and your read. A successful `show` or `patch` returns `mcpSessionId`; pass it as the
`mcpSessionId` parameter to read only your session's revisions. The default revision is then your
latest, `revisions` lists only yours, and a `revision` another session produced is an error. The
page itself still offers every kept revision.

Images draw the assets uploaded with the prototype to an Android device that is still showing it,
re-encoded at the size the frame draws them. The page stays under 2 MiB: the revision shown first
gets its images before older revisions, and an image that does not fit, or whose asset the server
does not have (iOS uploads, or no device showing the prototype any more), draws a grey placeholder.
Upload the assets again with the next show to bring them back.

`resources/list` lists `automobile:prototype/<id>/web` for every prototype shown in this daemon
session. Subscribe to that URI, without parameters, to be told about every new revision; a
subscription to a URI with `revision=` is never notified again.

To compare design alternatives, show each under its own id with the same `variant` group, for
example `variant: {group: "checkout", label: "Compact"}`. The web page of any of them offers every
alternative in the group by its label. The device keeps showing whichever was shown last.

### Live preview in a browser

To keep a browser tab on a prototype while an agent iterates, call `prototype` with
`{action: "serve", id: "<id>"}`. It needs no device request, works the same on a device and in
[headless mode](prototype-headless.md), and returns `previewServer` with
`pageUrl` (the live page for that id) and `url` (an index of every prototype shown in this daemon).
Each `show` and each `patch` that lands reloads the open page within about a second, keeping the
variant picked in its switcher. The page is the same HTML as `automobile:prototype/<id>/web`; add
`?frame=<frame id>` or `?variant=<id>` to the page URL to choose them. Serving an id not shown yet
succeeds with a warning, and its page loads once it is shown.

| Parameter       | Meaning                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | The prototype whose page URL to return. Optional: without it, use the index `url`.                                                                                                               |
| `port`          | TCP port, `0` to `65535`. `0` or absent picks a free port. If the port is in use, the call fails: pass another port or omit it.                                                                  |
| `remote`        | `true` binds every network interface so other machines can open the preview at this host's address. Anyone who can reach the port sees every shown prototype. Default `false`: `127.0.0.1` only. |
| `idleTimeoutMs` | Stop after this long with no open preview page and no request, `show` or `patch`. `1000` to `86400000`, default `1800000` (30 minutes).                                                          |

One preview server runs per daemon and every MCP session shares it. Calling `serve` while it runs
returns the same server; a different `port` or `remote` value restarts it on the new address. A
loopback server answers only requests addressed to `127.0.0.1`, `localhost` or `[::1]`.

`{action: "stop"}` closes the port and the open pages' connections. The server also stops when the
daemon exits, and after the idle timeout. `status` reports `previewServer` (`running`, `url`,
`port`, `host`, `remote`, `idleTimeoutMs`, or `stoppedReason`: `stop`, `idle` or `daemon`) after
the first `serve`. After the server stops, call `serve` again for a new URL.

### Export the web page to a file

To host the page, attach it to a CI run or send it to someone without a device, call the
`exportPrototypeWeb` tool. It is off by default: enable it with `setToolEnabled` (see [Dynamic tools](dynamic-tools.md)). It needs no
device. It writes the same bytes the `automobile:prototype/<id>/web` resource returns for the same
parameters (no network access, the same Content Security Policy) and returns the file's details
instead of the HTML.

| Parameter                                      | Meaning                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                           | The shown prototype's id. Required.                                                                                                                                                                                                                          |
| `frame`, `revision`, `variant`, `mcpSessionId` | As for the resource above.                                                                                                                                                                                                                                   |
| `outputPath`                                   | An absolute `.html` file path, or a directory (an existing one, or a path ending in `/`); any other path is refused. Defaults to `prototype-web/` in the AutoMobile data directory. In a directory the file is named `<id>-<frame>-r<revision>-<hash>.html`. |
| `overwrite`                                    | `true` replaces an existing file with different content; a symlink at `outputPath` is replaced, not written through. Without it the call is refused and nothing is written. A file that already holds the same bytes is left as it is.                       |

The result is `{path, sha256, bytes, frame, revision, variants, rendererVersion}`: `sha256` is the
hash of the written file and matches the resource's `_meta.sha256`. The page already offers every
variant in its group, so one file covers the whole set.

Errors name what to change: an unknown id lists the known prototypes, a revision older than the
kept 20 names the oldest kept one, an unknown frame lists the valid frames, and a relative or
unwritable `outputPath` asks for a writable absolute path, and a file path that does not end in
`.html` asks for an `.html` file or a directory.

## Embed envelope

To take a prototype's spec together with what it needs from a renderer, read
`automobile:prototype/<id>/embed` (`application/json`). It returns:

```json
{
  "format": "automobile-prototype-embed",
  "version": 1,
  "requires": ["..."],
  "spec": { "...": "..." },
  "glyphs": { "filled/home": "<path d=\"...\"></path>" },
  "iconMissing": ["filled/..."]
}
```

`spec` is the prototype's spec and `requires` lists the renderer capabilities it needs, as this
server computed them. Keep the two together: a renderer that lacks a listed capability should
refuse the spec rather than draw part of it. A `version` other than `1` is a newer format.

`glyphs` is present when the spec names an icon that has a glyph. It maps `<variant>/<name>` to the Material Icons
glyph's shapes, as SVG markup for a `0 0 24 24` viewBox, so a renderer needs no icon set of its
own. It covers every icon the spec's icon fields name, in the icon's `variant` (else `filled`), the glyphs controls draw on their own (a filter chip's or segment's selection check, a select's dropdown arrow and a date picker's month arrows),
and every icon name that appears as a string in `state` or `data`, in `filled` and in each variant
the spec's icons use, so an icon whose name changes with state still has its glyph. A variant
without that glyph carries the `filled` one. `iconMissing` lists the keys with no glyph at all;
draw a placeholder for them. iOS-style glyphs are not included yet.

`revision`, `variant` and `mcpSessionId` work as for the web page; there is no `frame`. Errors, listing and
subscriptions also match the web page, and `_meta` reports the same fields except `frame`.
