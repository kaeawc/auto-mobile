# Prototype platform security

Threat model for the platform vocabulary (`requires`, the `platform` action, `platform.on`
handlers, `{platform}` reads; see "Platform actions and events" in
[the prototype specification](plat/android/prototype-ux.md)). Specs are untrusted input: they come
from an agent, from a saved file, or from an import into ProtoViewer
([ProtoViewer](protoviewer.md)). Each rule below names where it is enforced. Rules marked
_not yet enforced_ are tracked in the linked issue.

## Threats

| Threat            | Example                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| Exfiltration      | Read the clipboard or contacts into `/data`, then send it with `request`.                              |
| Spam and abuse    | Post notifications or open the share sheet in a loop, or at show time.                                 |
| Persistence       | Keep a foreground service or background work alive after the prototype is dismissed.                   |
| Confused deputy   | Reach CtrlProxy's accessibility privileges, or a host app's TCC grants through the injected iOS agent. |
| Forged simulation | Inject platform events or call outcomes from something other than the host.                            |

## Trust tiers

| Tier       | Source                                                      | Modules                            |
| ---------- | ----------------------------------------------------------- | ---------------------------------- |
| MCP-direct | `prototype show` from the connected agent                   | Any module the runtime advertises. |
| MCP-saved  | `save`, loaded from the device's saved store                | Same as direct.                    |
| Imported   | ProtoViewer import, `library: true` in the strict validator | Non-`sensitive` modules only (R1). |

Imported specs already lose privileged windows, host requests and AGSL shaders
(`prototypeStrictPolicy.ts`).

## Rules

**R1: imported specs use no `sensitive` call.** `sensitive` in the contract's `platformModules`
table marks calls and events that touch personal data (clipboard, share, contacts, location,
camera and microphone output). The strict validator refuses sensitive calls and handlers when
`library: true`, with the call or handler's path. Relaxing this is an owner decision
([#15636](https://github.com/kaeawc/auto-mobile/issues/15636)).

**R2: sensitive results cannot reach a network or storage sink.** A `/data` path written by a
`sensitive` call's `into`, and `sensitive` `/platform` state, may not be bound into a `request`
URL, header, query or body, a channel URL or header, or `storage.keys`. The TypeScript validator
refuses sensitive `/data` bindings into request or channel fields when `library: true`, as it
does for `secure` text fields (`secureLibraryError`). Successful MCP-direct shows include a warning
for those bindings. No host path imports specs yet. Sensitive `/platform` state and `storage.keys`
checks are not applied, and the Swift validator does not apply this rule yet (tracked in #15635).

**R3: side effects need a user gesture.** The TypeScript validator permits `share.open` and
`notifications.post|schedule|setBadge` only in `onTap`, `onLongPress`, `onDoubleTap`, `onSubmit`
or user-initiated platform event chains (`notifications.opened|action|reply`, `map.markerTap`).
Follow-ups inherit the chain's gesture status; `onAppear`, `onEndReached`, timers and show-time
calls are refused at the action path. The contract limits share to 5 calls per 10000 ms and
notifications to 10 per 60000 ms. Both iOS and Android runtimes enforce each module's sliding-window
`rateLimit` with `too_many_in_flight` refusals. The Kotlin validator applies the gesture rule.

**R4: runtime isolation.** Where a module runs decides which privileges it can reach. The iOS
installer derives Info.plist usage strings from `requires.permissions`, strips inherited usage
strings and background modes, and omits `UIBackgroundModes` until the shared background vocabulary
has an unambiguous Apple mapping. The iOS agent capability table is tested against the contract's
per-call permissions (#15642). The Android stamper (#14185) and CtrlProxy capability table (#15642)
are _not yet enforced_.

- CtrlProxy and the iOS prototype agent never advertise permissioned modules. They offer only
  modules that need no permission and no identity of their own.
- The injected iOS agent never calls TCC APIs, and Info.plist filtering keeps usage strings out of
  an app that did not declare them.
- A per-prototype disposable app holds exactly the permissions the spec's `requires.permissions`
  declares and is uninstalled on delete or expiry.
- Capability gates run before show, so an unsupported module is refused with its capability name
  instead of being drawn and silently ignored. This part is enforced.

**R5: simulation is host-only.** Simulated events and call outcomes arrive only on the
authenticated host connection, never from spec content, intents or links. Imported prototypes
accept them only while host attach is enabled, which is off by default. _Not yet enforced_
([#15638](https://github.com/kaeawc/auto-mobile/issues/15638)).

**R6: provenance.** While a sensitive module is active in an imported prototype, ProtoViewer's
app-reserved provenance region names it. The region sits outside the spec's drawable bounds, so a
spec cannot cover it. _Not yet enforced_
([#15636](https://github.com/kaeawc/auto-mobile/issues/15636)).

## Out of scope

Ads and analytics SDKs, real push delivery and real payments are not part of the vocabulary, so
they add no threats here.
