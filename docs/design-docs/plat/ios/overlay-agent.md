# iOS simulator overlay agent

Agent-authored overlays (milestone 37, #9295) on iOS simulators, with no SDK in the
target app. This is the iOS counterpart of the
[Android overlay specification](../android/overlay-ux.md); the spec, validation limits
and node vocabulary are shared. See epic #10563 and the prototype in #10498.

Status: the agent and a prototype driver exist (`ios/overlay-agent/`,
`scripts/ios/overlay-agent-demo.ts`). The release asset (#10564), runtime
download (#10565), per-launch port, token and handshake (#10566), `launchApp
{ overlay: true }` (#10567) and `prototype` routing (#10568) are tracked as children of #10563.
This page describes the intended behavior of the finished feature and marks
what is still prototype-only.

## How it works

1. `ios/overlay-agent/` builds a small simulator-only dylib, ad-hoc signed. It needs no
   Developer ID identity, notarization or provisioning because it only loads into simulator
   processes.
2. The app is launched with `simctl launch` and the child environment variable
   `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` pointing at the dylib. `simctl` strips the
   `SIMCTL_CHILD_` prefix, so dyld loads the library into the app before `main()`.
3. The agent adds a SwiftUI `UIWindow` at window level `.alert + 1`, above the app's own
   windows, and renders the shared overlay spec into it.
4. The window's `hitTest` returns `nil` outside the overlay content, so touches there pass
   through to the app. Floating cards therefore leave the live app usable.
5. The agent listens on a loopback (`127.0.0.1`) TCP socket and speaks the CtrlProxy overlay
   message names (`show_overlay`, `dismiss_overlay`, `put_overlay_asset`, `overlay_result`,
   `overlay_event`) as newline-delimited JSON. There is no `update_overlay` (#10490): a
   `show_overlay` with the id already shown replaces it in place.
6. Each launch gets its own port and a random token. The host passes them as
   `AUTOMOBILE_OVERLAY_PORT` and `AUTOMOBILE_OVERLAY_TOKEN`; the first frame on a connection
   must be a `hello` carrying the token, and the agent replies with its version and
   capabilities. (The prototype still uses a fixed port 8771 with no token until #10566 lands.)

Because the window lives inside the app's process, `observe`, `tapOn`, `sendKeys`,
screenshots and video recording all see the overlay the same way they see app UI.

## Limits

- **Simulator only.** On physical devices code signing blocks the injection. Use the in-app
  SDK route for devices.
- **Only apps launched with the agent.** Injection happens at launch, so enabling it for a
  running app means relaunching it, which loses in-memory app state. An app started any
  other way (home screen, a plain `launchApp`, Xcode) has no agent unless you set it up as
  described below.
- **SpringBoard and system UI are not covered**, so the home screen cannot host an overlay.
- Overlays disappear when the app exits or is relaunched without the agent.

## Entry point: `launchApp { overlay: true }`

`launchApp` with `overlay: true` on an iOS simulator is the intended entry point (#10567).
It resolves the dylib, allocates a port and token, launches with the `SIMCTL_CHILD_*`
environment, and records the agent against the device and bundle id so `prototype` can
connect. A normal `launchApp` injects nothing. Any `DYLD_INSERT_LIBRARIES` you already set
is preserved. On a physical device the option fails with a simulator-only error.

If `prototype` targets an app that was not launched this way, it fails and tells you to
relaunch with `launchApp { overlay: true }` rather than relaunching on its own, because a
relaunch loses state.

## Where the dylib comes from

The client resolves the dylib in this order (#10565):

1. An explicit path.
2. The `AUTOMOBILE_IOS_OVERLAY_AGENT` environment variable, a path to a local build. Use it
   for repository checkouts and development builds.
3. The local build output.
4. A download of the release asset, checksum-verified and cached under
   `~/.auto-mobile/overlay-agent/`.

If there is no pinned checksum for the running build, the client reports that the overlay
agent is unavailable instead of using unverified bytes. Set
`AUTOMOBILE_SKIP_IOS_OVERLAY_AGENT_DOWNLOAD` to disable the download.

## Apps launched from Xcode

When you run the app from Xcode, AutoMobile does not launch it, so add the injection to the
scheme yourself:

1. Product, Scheme, Edit Scheme, select **Run**, then the **Arguments** tab.
2. Under **Environment Variables**, add `DYLD_INSERT_LIBRARIES` with the absolute path of the
   dylib: the cached file under `~/.auto-mobile/overlay-agent/`, or the file named by
   `AUTOMOBILE_IOS_OVERLAY_AGENT` for a local build.
3. Add `AUTOMOBILE_OVERLAY_PORT` (and, once #10566 lands, `AUTOMOBILE_OVERLAY_TOKEN`) with
   values you also give the client, since AutoMobile did not choose them.
4. Run on a **simulator** destination. In a scheme the variable is `DYLD_INSERT_LIBRARIES`
   itself; the `SIMCTL_CHILD_` prefix applies only to `simctl launch`.

Do not enable this on device destinations or in archive/release configurations; the dylib
is simulator-only and device launches will fail to load it.

## Differences from Android

- `prototype` on iOS has no `showVariants` and no `update` action (removed by owner decision).
  Showing a spec with an id that is already shown updates it in place. For a variant
  carousel, compose the spec yourself and `show` it.
- No `display` selector; a simulator has a single screen.
- Rendering is SwiftUI in the app's process rather than Compose in CtrlProxy, so there is no
  separate accessibility service involved.
- Android reaches any app through CtrlProxy; iOS reaches only apps launched with the agent.

See the [`prototype` tool reference](../../../tools.md#prototype).
