# Prototype spec: patch and presentation

Part of [the agent-authored prototype specification](prototype-ux.md).

## Patch (#11675)

Use `show` for a new screen or a window, theme or root change. Use `patch` for
content (`/data`), state (`/state`) or one node by id (`replaceNode`). Android CtrlProxy advertises
`prototype_patch_v1` and applies patches in place; the iOS prototype agent advertises it too
(a relaunched app loads the current agent), so an older agent still needs the whole spec with `show`.

`{action:"patch", id, ops, baseRevision?}` sends a `patch_prototype` frame
`{requestId, id, baseRevision?, ops}` only to a device advertising
`prototype_patch_v1`. Android and iOS use `prototype_result` replies. Success
carries `revision`; a state conflict carries
`{success:false,error,conflict:{revision,state:{key:scalar}}}`. Revisions are
non-negative safe integers; conflict values are strings, booleans or finite
numbers with valid state keys. Malformed reply fields are dropped. Each shown
prototype's `status` and `inspect` entry carries `revision`: the newest one the host
saw, from a landed patch reply or a device `/data` write event, never moving back. It
is absent until one arrives after the show; the device's `inspect` reply has no revision
of its own, so `inspect` keeps the host's.

Ops apply in order, completely or not at all. The ops `add`, `replace`, `remove` and
`test` address `/data` or `/data` followed by an RFC 6901 JSON pointer. In the pointer, `~0`
escapes `~` and `~1` escapes `/`. Array indices are canonical non-negative decimal
integers, and `-` appends for `add` only. Parent paths must exist. The ops `replace`,
`remove` and `test` require the addressed value to exist. The ops `add`, `replace` and
`test` carry `value`, and `remove` does not. State ops address exactly
`/state/<key>`, where keys match `[A-Za-z_][A-Za-z0-9_]{0,63}` and values are
strings, booleans or finite numbers.

`replaceNode` carries `{op:"replaceNode",id,node}`. The id must identify exactly
one node in the tree, cannot be the root or inside a repeat, and the replacement
must keep that id. Replacement nodes cannot contain `use` nodes or element
anchors. Inline the component, use a bounds anchor, or use `show`.

The agent writes data, and the user writes state. Data-only patches and patches
containing only data ops and `replaceNode` ignore `baseRevision`. That holds until the device has written the
prototype's data with a data action (see [Data actions](prototype-ux-actions.md#data-actions-12519)). From then on a
`/data` op also needs `baseRevision` and conflicts with newer overlapping device writes. Any state
op, including `test`, requires `baseRevision`. A device supporting the capability
must refuse the whole patch with `conflict` if the user changed a touched state
key since that revision, returning the current revision and those keys' values.

There are at most 64 ops, the frame is capped at 1 MiB, and the resulting whole
spec must satisfy every spec/data limit, including node count and depth. The
host tracks a cloned copy of each id's device spec from its last acknowledged show,
with components expanded and anchors resolved. It applies ops to a copy and
runs the full validator before sending. Errors preserve deterministic paths.
The host validates state ops against the agent-declared state and leaves value
comparison for `/state` `test` to the device; its copy cannot know user edits.

Patches are FIFO per device, one in flight at a time. A pending show makes patch refuse as busy, and patches do not delay shows. If a dispatched show and an acknowledged patch overlap, their device-side order is unknown. The host then forgets its spec, warns, and requires a further successful show before patching. A failed dispatched show, dismissed event, successful dismiss, session release, device removal or unbinding also ends tracking.

Inspect retains each reported tracked id and drops missing ids (adopted siblings do not end tracking); a fifth-surface refusal with `replaceOthers: false` retains the acknowledged specs. A timeout or connection loss after dispatch is indeterminate and requires a new show; a failure before dispatch keeps the tracked copy; an atomic device refusal leaves it unchanged. A successful patch refreshes shown status data and sets the entry's `lastAction` to `patch` (kept by a later `inspect`, reset by the next `show`), without changing `lastResult`, timestamps or event snapshots.

## Re-showing a prototype

`show_prototype` always carries a full spec, and `patch_prototype` is the gated content/state/node contract (#11675).
When `spec.id` is the prototype already on screen and `reset` is absent or false,
the device replaces it in place. It keeps the display the prototype is on and ignores the
request's `displayId`. Each pager keeps its settled page,
matched by pager id and clamped to the new page count.

The new spec's `state`
is authoritative. The device drops values the user changed by tapping or typing
unless the spec includes them. The exception is the keys the spec's `storage` block lists, whose
stored values replace the spec's (see [Storage](prototype-ux-storage.md)). The device rebuilds the window content from the new
runtime, so a text field shows the spec's value and the device drops edits still in flight from
the previous showing. Event sequences continue per id, as for any
re-show.

A fresh show happens on `reset: true`, a different id, or nothing on screen:
pages start from the spec and the device uses the requested display. The host sends `reset` only
when true. A device that predates it ignores the field and always starts
fresh. The host reports a `display` that a same-id show ignored as a `warning`
on the tool result.

## Presenting alternatives

The host has no carousel helper. Show
one design with `show` and discuss the others in chat, or show one spec whose `pager` holds every design
with a visible label per page (see the full-screen pager example). Nothing waits on the device for a
choice.

## Device destination policy

`via: "device"` requests on Android pass `PrototypeEgressPolicy`, which checks the URL host before any
DNS lookup, every resolved address, and the address of the connected socket. A refused destination
fails the request with `blocked_destination`. It refuses:

- the names `localhost` and `*.localhost`, and a numeric host that is not a valid IPv4 or IPv6 literal;
- `0.0.0.0/8`, loopback (`127.0.0.0/8`, `::1`), the unspecified IPv6 address, link-local
  (`169.254.0.0/16`, `fe80::/10`), site-local IPv6 and Teredo;
- the emulator's host-machine aliases (`10.0.2.1` to `10.0.2.6`, and Genymotion's `10.0.3.2`);
- IPv6 forms that embed a refused IPv4 address (IPv4-compatible, IPv4-mapped, SIIT, both NAT64
  prefixes and 6to4);
- ports 3000-3010 (the daemon's range) and 8765 (CtrlProxy) on a private address (`10/8`,
  `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`).

The host makes no `adb reverse` for a prototype, so `localhost` on the device never reaches a host
server. A prototype reaches a host-local server with `via: "host"`, or with `via: "device"` at an
address the device can reach that the policy permits. The session-scoped `portReverse` tool is
separate and does not change this policy. iOS simulators apply the agent's own
[destination policy](../ios/prototype-agent-data.md#destination-policy-13815), which also refuses loopback.
