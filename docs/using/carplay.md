# CarPlay on iOS simulators

AutoMobile cannot observe, record or tap the CarPlay screen yet. What works today is reading the
templates your app shows on CarPlay, and acting on them, through the AutoMobile iOS SDK in a Debug
build. This page covers that path and what is not supported.

## What works today

- iOS simulators only, with a Debug build of your app that includes the AutoMobile SDK.
- `GET /carplay/templates` on the SDK's HTTP server: the template stack your app shows on CarPlay,
  as JSON.
- `POST /carplay/action`: select a list row, image-row element, alert action or tab, go back, or
  pop to the root template.
- The `carPlay` device resource setting turns CarPlay vehicle connectivity off on a simulator. See
  [Configuring device resources](../how-it-works/device-resources-configuring.md).

No MCP tool reads the template tree or sends these actions. `observe`, screenshots and
`videoRecording` capture the phone screen only.

## Open the CarPlay window

In Simulator, choose **I/O > External Displays > CarPlay**. A booted simulator lists the CarPlay
screen even while this window is closed, so the listing does not mean the screen is showing.
AutoMobile does not open or close the window for you.

## Register your CarPlay scene

Register the interface controller when the CarPlay scene connects, and unregister it when the scene
disconnects:

```swift
import AutoMobileSDK
import CarPlay

final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    func templateApplicationScene(
        _: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        AutoMobileSDK.shared.registerCarPlay(interfaceController: interfaceController)
        // Set your root template as usual.
    }

    func templateApplicationScene(
        _: CPTemplateApplicationScene,
        didDisconnectInterfaceController _: CPInterfaceController
    ) {
        AutoMobileSDK.shared.unregisterCarPlay()
    }
}
```

Registration does nothing in a Release build. The SDK holds the controller weakly, so it never
keeps a CarPlay session alive. Your app still needs its own CarPlay entitlement and scene
configuration; the SDK does not add them.

## Read the templates

The SDK serves the routes on port 8766 on the host, as long as no other simulator holds that port.
Send `X-AutoMobile-Simulator-UDID: <udid>` so a reply from a different simulator's app is refused
with HTTP 409 `wrong_simulator` instead of being read by mistake:

```bash
curl -s -H "X-AutoMobile-Simulator-UDID: $UDID" http://127.0.0.1:8766/carplay/templates
```

The routes answer while your app is in the background, because CarPlay can stay active then.

| Field       | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `enabled`   | The app has called `registerCarPlay`. It stays true after unregistering.  |
| `connected` | The registered controller is still alive.                                 |
| `templates` | The controller's stack, bottom to top. Empty before registration.         |
| `presented` | The presented template, such as an alert or action sheet, when one is up. |
| `truncated` | Some nodes were left out because a size limit was reached.                |

Each node has an `id` and a `type`: `list`, `grid`, `tabBar`, `information`, `alert`,
`actionSheet`, `pointOfInterest`, `map`, `contact`, `voiceControl`, `nowPlaying`, `search` or
`unknown` (with `className`). Lists carry sections and rows with text, detail text, `enabled` and
`hasImage`; grids carry title variants; tab bars carry the selected tab and each tab's template.
Images are never included. The tree describes the templates your app set, not the pixels CarPlay
drew.

A snapshot holds at most 50 items in any collection, 500 nodes and 6 levels. IDs are paths such as
`stack/0/sections/1/items/0` or `stack/0/tabs/1`. They name positions in the current snapshot only,
so read a fresh snapshot after the stack changes.

## Act on a template

```bash
curl -s -X POST -H "X-AutoMobile-Simulator-UDID: $UDID" \
  -d '{"id": "stack/0/sections/0/items/0", "action": "select"}' \
  http://127.0.0.1:8766/carplay/action
```

`action` is `select` (the default), `back` or `popToRoot`; only `select` needs an `id`. A valid
request returns HTTP 200 with `status`, an optional `reason` and the full `templates` snapshot taken
after the action. If your app updates its templates later, for example after a network call, read
the templates again.

| `status`      | Meaning                                                                                      | What to do                                     |
| ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ok`          | The handler ran, the tab was selected, or the stack was popped.                              | Check the returned `templates`.                |
| `not_found`   | No node has that `id` in the current templates.                                              | Read the templates again and use a fresh `id`. |
| `failed`      | The element is disabled, a list row has no handler, or the pop failed.                       | Enable the element or add a handler.           |
| `unsupported` | The app has not registered, the controller is gone, or the node has no public selection API. | See `reason`.                                  |

Grid buttons, bar buttons and text buttons return `unsupported`: CarPlay gives no public way to
trigger their handlers from outside. Malformed JSON, an unknown `action`, or `select` without an
`id` returns HTTP 400 `bad_request`.

## Not supported

| Not supported                                       | Why                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| CarPlay screenshots, `observe` and `videoRecording` | No capture surface is available yet; CarPlay screen captures time out or come back black.                           |
| CarPlay in the device list                          | Device listings do not report a CarPlay screen yet.                                                                 |
| Tapping, swiping or typing on the CarPlay screen    | Interaction tools drive the phone screen only. Use `POST /carplay/action` for template actions.                     |
| Physical iPhones, cars and head units               | Only simulators are supported.                                                                                      |
| Apple's CarPlay Simulator app                       | AutoMobile does not connect to it. Use the CarPlay window in Simulator.                                             |
| CarPlay prototypes                                  | Prototypes draw only on the phone screen. See [CarPlay prototypes](../how-it-works/plat/ios/carplay-prototypes.md). |
| Release builds                                      | The SDK routes and registration exist only in Debug builds.                                                         |
