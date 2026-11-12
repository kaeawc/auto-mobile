# iOS prototype agent verification backlog

- Kind: idea
- Date: 2026-10-08
- Source: moved from `how-it-works/plat/ios/prototype-agent.md`; #10605, #10498, #12395, #12529,
  #15562, #15611, #15255
- Shaped: [iOS simulator prototype agent](../how-it-works/plat/ios/prototype-agent.md)

## Device verification owed

- The iOS window-layer `tapOn` fix (#10498) and every item the page marks "not device-verified".
- Style effects: simulator goldens against Android within a tolerance (the simulator forwards Metal to
  the host GPU and is not pixel-exact), and which node types really draw the platform-view
  placeholder.
- Rich text: mixed span styles, concatenated observe text, per-span actions without URL navigation,
  Android semanticLinks, and iOS `tapAt` links.
- Glass: group morphing and the visual result need an iOS 26 simulator check; Android glass
  rendering is a separate slice.

## Follow-ups named on the page

- Further native controls and a MaterialLook/PlatformLook renderer split (#15562).
- Native `NavigationSplitView`, sidebar-adaptable `TabView` and `.inspector` for `adaptive` (#15255).
- Custom navigation-container painting for `bottomNav` needs the style paint layer integrated with
  the bar's fill.
- Material icon-set and icon-variant parity (`prototype_icon_set_material_v1`,
  `prototype_icon_variant_v1`).
- Pointer-delivery observation for embedded views without `PassthroughWindow`; pure session support
  alone does not verify that input path.
- Text fields: whether secure values should stay unredacted in state, `change` events and `inspect`
  was an open question.
- Share library guard: the secure-value scan charges expanded bytes conservatively; a one-pass
  pre-scan would be exact (#15611).

## Alamofire for device requests

The #12529 proposal named Alamofire 5.x for the on-device request client, pending two macOS-only
checks: an injected dylib linking Alamofire coexisting with the host app's own copy, and binary size.
They were not run, so the package does not depend on it; the URLSession client is the fallback
behind the same `PrototypeHttpClient` protocol.
