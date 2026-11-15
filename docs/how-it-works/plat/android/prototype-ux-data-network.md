# Prototype spec: data, network, anchors and safe area

Part of [the agent-authored prototype specification](prototype-ux.md).

## Data, storage and network (#12531)

The three features compose: a `request` writes its response into `/data`, data actions edit `/data`
from a tap, and `storage` makes chosen `state` and `/data` values survive a re-show or relaunch.
The detailed contracts are [Data actions](prototype-ux-actions.md#data-actions-12519), [Storage](prototype-ux-storage.md#prototype-spec-storage) and
[Request action](prototype-ux-request.md#request-action-12523); this section is the one-page overview and the capability
map.

| Capability                              | Gates                                                     | Android CtrlProxy | iOS agent     |
| --------------------------------------- | --------------------------------------------------------- | ----------------- | ------------- |
| `prototype_data_actions_v1`             | `setData`, `appendData`, `prependData`, `removeData`      | Advertised        | Advertised    |
| `prototype_storage_v1`                  | root `storage` block, `inspect` `storage`, `clearStorage` | Advertised        | Advertised    |
| `prototype_network_v1`                  | the `request` action with `via: "host"`                   | Advertised        | Advertised    |
| `prototype_platform_realtime_v1`        | channels, realtime calls, upsertData, appendData.maxItems | Contract only     | Contract only |
| `prototype_platform_realtime_device_v1` | channels with `via: "device"`                             | Contract only     | Contract only |
| `prototype_network_device_v1`           | `request` with `via: "device"`                            | Advertised        | Advertised    |

A device without a capability is refused before uploads or show, with a message naming the
capability. Device-side verification is the manual run in `skills/manual-test/prototype-acceptance.md`
("Data, storage and network").

Behaviour per feature lives in the sections above: a data write bumps the data revision and emits one
`change` named for the path; storage precedence is the six rules under Storage; the request lifecycle
(`statusKey`, `<into>__meta`, atomic completion, latest-wins cancellation, `prototype_request` event) is
under Request action.

**The two transports.**

- `via: "host"` (the default): the device sends a `prototype_request` frame and the host runs the
  HTTP transport, with an egress policy checked before every connection and redirect. The host needs a
  connection; with none the request fails with `network`. Closing the owning connection fails its
  calls at once, and a cancelled call sends `prototype_request_cancel` so the host frees the slot.
- `via: "device"`: the device runs the request itself and applies its own destination policy:
  on Android the [device destination policy](prototype-ux-patch.md#device-destination-policy), on an iOS simulator the
  agent's [destination policy](../ios/prototype-agent-data.md#destination-policy-13815). Both refuse
  loopback, so a host-local server needs `via: "host"`.

**Host egress policy.** Host requests refuse localhost names, loopback, unspecified and link-local
addresses, emulator host aliases, and IPv6 forms embedding those IPv4 destinations.
SIIT and both NAT64 prefixes use the embedded IPv4 classification;
Teredo and site-local IPv6 addresses are refused. Every DNS
answer must be permitted; the connection is pinned to a validated IP while retaining the original
HTTP authority and TLS hostname. Daemon HTTP ports (including the configured port and fallback
range) and CtrlProxy's port are refused on private addresses; public addresses remain permitted on
those ports. Redirects are checked at each hop (at most five); HTTPS-to-HTTP redirects are refused.
An origin change removes all authored headers. Host, connection/framing, Cookie, Origin and Proxy-
headers and Expect are not accepted from requests. Other RFC1918 destinations remain permitted
on ordinary ports, including `10.1.2.3` and `192.168.1.10`.
A policy refusal is `blocked_destination`: the destination
is not permitted. The same policy applies to host WebSocket and SSE channel transports.
The WebSocket handshake connects to the validated pinned address with the authored Host and TLS
server name, ignores proxy environment variables, and never follows a redirect: a handshake
redirect is `handshake_failed`. SSE redirects are re-checked at each hop. A channel policy refusal
is `blocked_destination`. Mock-origin channels never reach DNS, the policy or a socket.
Device requests retain their platform transport behavior.

The host transport makes a direct connection. Node uses a fresh agent with an empty `proxyEnv`,
ignoring HTTP(S)_PROXY, ALL_PROXY and NO_PROXY routing configuration. Bun refuses the request
before connecting if any nonempty HTTP_PROXY, HTTPS_PROXY or ALL_PROXY variable is present
(case-insensitive), even with NO_PROXY set; NO_PROXY alone is permitted. That refusal is a
`network` outcome. Environment variables are never changed during a request.
For gzip, deflate and Brotli responses, the size cap applies to decoded bytes; the returned
headers omit content-encoding and content-length because they describe the encoded body.

**Cleartext and transport security.** CtrlProxy declares `INTERNET` and a `network_security_config`
with cleartext permitted, so `http://` works for `via: "device"` on Android. On iOS, `via: "device"`
runs inside the target app and obeys its App Transport Security: IP addresses are exempt (`localhost`
is too, but the agent's destination policy refuses it), other cleartext hosts fail with `network` and a message pointing to `via: "host"` or `https://`.
`via: "host"` is not subject to ATS.

**Saved prototypes.** A saved Android prototype (see
[Saved prototypes on the Android home screen](prototype-ux-saved.md#saved-prototypes-on-the-android-home-screen)) supports
`request` actions with `via: "device"`, under the same
[device destination policy](prototype-ux-patch.md#device-destination-policy). `via: "host"` has no host to run it there, so it fails with an `invalid_request`
error whose message points to `via: "device"`.

**Limits.**

| Limit                                        | Value                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/data` write (after any action or response) | `MAX_PROTOTYPE_DATA_WRITE_BYTES`, 786432 bytes of data cost                                  |
| Response body                                | `MAX_PROTOTYPE_RESPONSE_BYTES`, 262144 bytes, 2xx only (a non-2xx body is never read)        |
| Request `timeoutMs`                          | 1 to 30000, default 10000                                                                    |
| Requests in flight                           | 4 per device                                                                                 |
| Header and query entries                     | 16 each, values up to 4096 characters                                                        |
| Storage                                      | at most 64 keys, 262144 stored bytes per prototype id                                        |
| Emit payload                                 | 4096 bytes; a larger `change` event drops its `value` and the host stops mirroring that spec |

## Anchors

Anchors (semantics from #9316) use these strict shapes:

```json
{ "type": "bounds", "bounds": { "x": 12, "y": 48, "width": 300, "height": 56 } }
```

```json
{
  "type": "element",
  "selector": {
    "elementId": "42",
    "text": "Buy",
    "testTag": "buy",
    "container": { "elementId": "card" }
  },
  "alignment": "cover",
  "offset": { "x": 0, "y": 0 }
}
```

Bounds are screen-space dp; width/height are nonnegative. Element selector has
optional nonempty `elementId`, `text`, and `testTag` strings, and an optional container object, with
at least one supplied. Combined fields narrow the match. The container object uses the existing tap
container shape: exactly one nonempty `elementId` or nonblank `text`, optional
nonnegative integer `index` (up to 2147483647), optional `selectionStrategy`, and
an optional nested `container`. Anchors accept only `selectionStrategy: "unique"`
(default): an ambiguous anchor is rejected. Container chains have a separate `MAX_PROTOTYPE_SELECTOR_DEPTH` of 8;
the first container has depth 1. The existing TypeScript
`ElementContainerSelector` type is reused. Strings are preserved as authored. Alignment is required: `cover`, `top`, `bottom`,
`start`, or `end`; optional offset defaults to zero. Cover adopts target bounds;
edge alignment aligns the same node edge to the target edge, centered along the
other axis, preserving authored node dimensions, then applies the offset.

The host resolves selectors against the app hierarchy with the prototype excluded,
using tap's resolution (a text match is promoted to its clickable owner) with
`unique` selection, and converts the element's px bounds to dp once with the
display density the capture reports (`px * 160 / densityDpi`). Resolution happens at
show, not live. A missing, ambiguous (candidates listed), empty or off-screen element
fails the call before anything is shown. The result reports `anchors` (each anchored
node's path with the element's px and dp bounds) and `hierarchyUpdatedAt`; show again
to re-anchor after the app scrolls or re-lays out.

On the wire the device only receives bounds anchors: the host replaces each element
anchor with `{ "type": "bounds", "bounds", "alignment", "offset"? }`, keeping its
alignment and offset. A bounds anchor may also be authored with `alignment` (default
`cover`) and `offset`. The renderer refuses an element anchor that reaches it
unresolved. A host only sends anchors to a CtrlProxy advertising `prototype_anchor_v1`;
older APKs decode and ignore them, so the host refuses the show there. Element anchors
resolve against the default display (another `display` is refused). On an iOS simulator
the injected prototype agent positions anchors too, advertising the same
`prototype_anchor_v1` capability in its handshake; there, hierarchy bounds and spec sizes
are both points, so nothing is converted (see the
[iOS prototype agent](../ios/prototype-agent-components.md#anchors)).

The renderer lays an anchored node at its screen rectangle by subtracting the window's
screen origin and the node's own position inside the window (cutout, system bars, the
fullscreen host row, safe-area and authored padding). An anchored node below the root
is drawn in a window-level layer above the author tree (modal content: above its modal),
so its parent neither reserves a slot for it nor clips it, and its touch target and
accessibility bounds are where it is drawn (#10803). It is shown while all its
ancestors are; it does not inherit their opacity. Cover sizes the
node to the bounds, ignoring authored width/height. Window size is determined by
placement/content, not by implicitly resizing to an anchor:

- fullscreen and sheet windows take anchors on any node; content outside the window
  (above a bottom sheet, or under the fullscreen host row) is clipped;
- a floating window moves onto its anchored root (top-start gravity, x/y in screen px)
  and stays content-sized, so the rest of the app remains touchable. Only the root of a
  floating window may be anchored; the host refuses an anchor below it.

## Safe area and IME

```json
{
  "safeAreaPadding": {
    "edges": ["bottom"],
    "types": ["systemBars", "ime"]
  }
}
```

Both arrays must be nonempty, with no duplicates. Edges: `top`, `bottom`, `start`,
`end`. Types: `systemBars`, `cutout`, `ime`. It mirrors Compose
`windowInsetsPadding`: take the selected inset types' union (maximum per edge),
apply only selected edges, and consume those insets for descendants. Insets are
additional to authored style padding. No padding is applied automatically.
Bottom navigation, bottom sheets, and text-field-bearing content normally opt
into bottom/systemBars, plus ime when the keyboard should move content. Cutout
padding is normally useful at top/start/end. Anchors stay in screen coordinates;
inset padding does not reinterpret their coordinate origin.
