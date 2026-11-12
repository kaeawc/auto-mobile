# Prototype map backends and tile sources

- Kind: decision
- Date: 2026-10-28
- Source: moved from `how-it-works/plat/android/prototype-ux.md`; #14308, #14309, #14310, #14311,
  #15709
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md)

## Context

#14308 designed the `map` node (#14309) and its renderers (#14310, #14311): backends, styles, tile
source, keys and egress.

## Options

On iOS, `plain` can be drawn by MapLibre iOS or by an `MKTileOverlay` with `canReplaceMapContent`
serving local tiles, because MapKit always fetches Apple tiles.

## Decision

The owner-decided rules are the Maps section of the shaped page. Recorded reasons and open choices:

- Google Maps is opt-in on Android and needs a host-configured key because a disposable app's
  package and signature change per prototype, so a key cannot be pre-restricted to them.
- `satellite` is not offered until a source for it is chosen.
- #14311 picks the iOS `plain` drawing between the two options above.

## Consequences

No renderer draws `map` and no runtime advertises `prototype_platform_map_v1` yet; the renderers
follow these rules when built.
