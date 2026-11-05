# AndroidX Wear libraries for the Wear OS fixture app

Status: accepted for #16828 (part of the Wear OS epic #14894).

Dependency: `androidx.wear.compose:compose-foundation` and `compose-material3`,
`androidx.wear.tiles:tiles`, `androidx.wear.protolayout:protolayout`,
`androidx.wear.watchface:watchface-complications-data-source`, `androidx.wear:wear-ongoing` and
`androidx.concurrent:concurrent-futures`, all `implementation` in `android/wear-fixture` only.

## Decision

The fixture exists to exercise the surfaces a Wear app really ships: a `ScalingLazyColumn`, a
swipe-to-dismiss box, a tile, a complication data source and an ongoing activity. Each surface is
defined by its AndroidX library, so the fixture uses those libraries directly. `concurrent-futures`
supplies the immediate `ListenableFuture` the tile service returns. No other module depends on them,
and none is published.

## Alternatives checked

| Alternative                               | Why not                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Kotlin stdlib, JDK, AndroidX already used | Phone Compose has no `ScalingLazyColumn`, tile, complication or ongoing API.     |
| Framework-only Wear APIs                  | Tiles, complications and ongoing activities have no framework-only equivalent.   |
| Guava `Futures.immediateFuture`           | Pulls full Guava for one call; `concurrent-futures` is already on the classpath. |
| Horologist                                | Extra layer over the same libraries; the fixture needs nothing it adds.          |
