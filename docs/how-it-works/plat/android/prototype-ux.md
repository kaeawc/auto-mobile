# Agent-authored prototype specification

Current, unversioned contract for the agent-authored prototype (#9296, child of #9295). Android Compose
rendering, asset transport, the wire messages, the `prototype` MCP tool and the
[iOS simulator agent](../ios/prototype-agent.md) implement it; the iOS
[feature support table](../ios/prototype-agent-native-look.md#feature-support) lists what is Android only (`display`,
`window.layer: "app"`, `window.persistence: "device"`, `inspect`, idle TTL). A spec accepts no code except the opt-in Android-only AGSL asset referenced by `style.shader`,
expressions, URLs, image bytes or migration instructions.

Conventions: the renderer is Compose; sizes and positions use dp; prototype opacity is a
percentage; app-element anchoring is supported; `observe` includes prototype nodes by default;
existing tap and text tools target prototype nodes; screenshots come from `observe`, with no
separate screenshot tool. Focus belongs to the window host: accessibility set-text does not require
focus, human keyboard input does.

The specification is split across these pages:

- [Envelope and data model](prototype-ux-envelope.md)
- [Theme](prototype-ux-theme.md)
- [Windows, Wear OS, Automotive and common node properties](prototype-ux-windows.md)
- [Nodes and text field options](prototype-ux-nodes.md)
- [Style and icon effects](prototype-ux-style.md)
- [Icons and images](prototype-ux-icons.md)
- [Motion](prototype-ux-motion.md)
- [Screen map and route transitions](prototype-ux-routes.md)
- [Actions, emit context and data actions](prototype-ux-actions.md)
- [Storage](prototype-ux-storage.md)
- [Request action and share contract](prototype-ux-request.md)
- [Platform actions and events](prototype-ux-platform.md)
- [Platform: device status, connectivity, window controls and pickers](prototype-ux-platform-device.md)
- [Platform: links, media pickers, sign-in, location and BLE](prototype-ux-platform-identity.md)
- [Platform: commerce, secure storage, sensors, permissions and notifications](prototype-ux-platform-services.md)
- [Platform: media players, camera, casting and haptics](prototype-ux-platform-media.md)
- [Conditions, repeat templates and components](prototype-ux-conditions.md)
- [Patch, re-showing and device destination](prototype-ux-patch.md)
- [Realtime channels](prototype-ux-realtime.md)
- [Data, storage and network; anchors; safe area](prototype-ux-data-network.md)
- [Lifecycle and safety](prototype-ux-lifecycle.md)
- [Lint, rejection paths, worked examples and fixtures](prototype-ux-lint.md)
- [Flow, carousel, refresh, chat, swipe, gestures, search and loading](prototype-ux-layout-contracts.md)
- [Effects, maps, web content and charts](prototype-ux-effects.md)
- [Rich text, menus, tooltips, drawers and checks](prototype-ux-controls.md)
- [Saved prototype activity and home screen](prototype-ux-saved.md)
- [Lazy lists, strings and semantics](prototype-ux-lists-strings.md)
- [Dead taps, value formatters, platform namespaces, glass and disposable apps](prototype-ux-platform-extras.md)

## Background

- [Prototype spec shape and host-escape decisions](../../../devlog/2026-10-04-prototype-ux-spec-decisions.md)
- [Prototype native look and motion profiles](../../../devlog/2026-10-26-prototype-ux-native-look-and-motion-profiles.md)
- [Prototype glass surfaces and custom AGSL shaders](../../../devlog/2026-10-27-prototype-ux-glass-and-custom-shaders.md)
- [Prototype map backends and tile sources](../../../devlog/2026-10-28-prototype-ux-map-backends.md)
- [Prototype remote image URLs](../../../devlog/2026-11-05-prototype-ux-remote-image-urls.md)
- [Prototype device verification status](../../../devlog/2026-10-04-prototype-ux-device-verification-status.md)
- [Prototype spec open follow-ups](../../../devlog/2026-10-09-prototype-ux-open-follow-ups.md)
