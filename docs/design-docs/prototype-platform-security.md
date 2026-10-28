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
camera and microphone output). The strict validator refuses them when `library` is set, with the
call's path. Relaxing this is an owner decision. _Not yet enforced_
([#15636](https://github.com/kaeawc/auto-mobile/issues/15636)).

**R2: sensitive results cannot reach a network or storage sink.** A `/data` path written by a
`sensitive` call's `into`, and `sensitive` `/platform` state, may not be bound into a `request`
URL, header, query or body, a channel URL or header, or `storage.keys`. For imported specs this is
a refusal, as it is for `secure` text fields today (`secureLibraryError`). For MCP-direct shows it
is a warning in the show result. _Not yet enforced_
([#15635](https://github.com/kaeawc/auto-mobile/issues/15635)).

**R3: side effects need a user gesture.** Side-effecting calls (`share.*`, notifications,
background leases) run only from taps, submits and user-initiated platform events, never from
`onAppear`, timers or show time, and each module has a call rate limit. _Not yet enforced_
([#15637](https://github.com/kaeawc/auto-mobile/issues/15637)).

**R4: runtime isolation.** Where a module runs decides which privileges it can reach.

- CtrlProxy and the iOS prototype agent never advertise permissioned modules. They offer only
  modules that need no permission and no identity of their own.
- The injected iOS agent never calls TCC APIs, and the Info.plist filtering of the module
  registry keeps usage strings out of an app that did not declare them.
- A per-prototype disposable app holds exactly the permissions the spec's `requires.permissions`
  declares and is uninstalled on delete or expiry.
- Capability gates run before show, so an unsupported module is refused with its capability name
  instead of being drawn and silently ignored.

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
