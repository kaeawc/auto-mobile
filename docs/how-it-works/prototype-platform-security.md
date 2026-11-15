# Prototype platform security

Threat model for the platform vocabulary (`requires`, the `platform` action, `platform.on`
handlers, `{platform}` reads; see "Platform actions and events" in
[the prototype specification](plat/android/prototype-ux.md)). Specs are untrusted input: they come
from an agent, from a saved file, or from an import into ProtoViewer
([ProtoViewer](protoviewer.md)). Each rule below names where it is enforced. The linked issue
tracks each rule marked _not yet enforced_.

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
camera and microphone output). The TypeScript, Kotlin and Swift strict validators refuse sensitive
calls and handlers when `library: true`, with the call or handler's path; the shared fixtures are in
`test/fixtures/prototype-spec/library-modules/`. Relaxing this is an owner decision
([#15636](https://github.com/kaeawc/auto-mobile/issues/15636)).

**R2: sensitive results cannot reach a network or storage sink.** A `/data` path written by a
`sensitive` call's `into`, and `sensitive` `/platform` state, may not be bound into a `request`
URL, header, query or body, a channel URL or header, or `storage.keys`. The TypeScript, Kotlin and
Swift validators refuse these bindings when `library: true`, reporting the sink path, as they do
for `secure` text fields. Pointer overlap includes parents, children and repeat `{index}` segments;
literal value bindings stay opaque. A `setData`, `appendData`, `prependData` or `upsertData` whose
`value` is `{data}` or `{platform}` read of tainted state taints its `/data` destination, so
copies and copies of copies are refused too.

TypeScript, Kotlin and Swift also track copies routed through state. A `setState` taints its key
when its value is a sensitive `{platform}` read, or text naming a tainted data or platform
placeholder or a tainted repeat row. A `{state}` read of a tainted key taints a data destination.
It is itself a sink in a request, a `{key}` text placeholder or a `state:` storage key. A key holding a repeat placeholder matches
every key sharing its literal prefix. The contract marks location fixes and auth user IDs as
sensitive state. Successful MCP-direct shows include a warning for each sink, unless the
expanded sink scan exceeds 4194304 bytes. Then they include one warning that the sinks are
unchecked. No host path imports specs yet.

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

**R6: provenance.** When an imported prototype uses a sensitive call or handler, ProtoViewer's
app-reserved provenance region names its modules. The region sits outside the spec's drawable
bounds, so a spec cannot cover it. Android (`PrototypeLibraryProvenance` in `:protocol`) and iOS
(`PrototypeLibraryProvenance` in the agent core) derive the module list with the R1 walk. Under R1
a validated import lists none, so the region stays hidden until R1 is relaxed.

## Out of scope

Ads and analytics SDKs, real push delivery and real payments are not part of the vocabulary, so
they add no threats here.
