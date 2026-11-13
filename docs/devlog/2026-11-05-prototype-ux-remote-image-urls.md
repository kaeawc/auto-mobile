# Prototype remote image URLs

- Kind: decision
- Date: 2026-11-05
- Source: moved from `how-it-works/plat/android/prototype-ux.md`; #14180, #14184, #14289, #16443
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md)

## Context

An `image` node accepts only an uploaded `asset`. Feeds bound from `/data` need images by URL, such
as `{item.avatarUrl}`.

## Options

Not recorded.

## Decision

Owner decision of 2026-10-31 (#14180):

- `image` may take a `url`, including a data-bound one.
- A URL image uses the same egress policy as `request` in its runtime. The overlay follows `request`,
  ProtoViewer sits behind its network switch and filter (image loads count as network), and the
  disposable app follows #14184 / #14289.
- Only https is allowed outside dev flavors; cleartext only on loopback through `adb reverse` for
  fixtures.
- An optional `via: "host"` lets the host fetch a static URL at show/patch time and upload it as a
  content-hash asset, so the device makes no network call.
- Image fetches never send cookies or referrers. The host can see the URL, but it never appears in
  accessibility text, `observe` or events.

## Consequences

Not implemented when recorded: `image` accepts only `asset`. The `url` form, its validation and the
egress behaviour are owed to the contract and the runtimes.
