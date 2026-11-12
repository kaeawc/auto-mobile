# AndroidX TV libraries for the Android TV fixture apps

- Kind: decision
- Date: 2026-11-06
- Source: moved from docs/decisions/androidx-tv-fixture-libraries.md (added in #17311)

Status: accepted for #16736 (part of the Android TV epic #15900).

Dependency: `androidx.tv:tv-material`, `implementation` in `android/tv-fixture` only, and
`androidx.leanback:leanback`, `implementation` in `android/leanback-fixture` only.

## Decision

The fixtures exist to exercise the two focus models real TV apps ship: Compose for TV components
(`Card`, `Button`, `Surface` with TV focus indication) and View-based Leanback
(`BrowseSupportFragment`, `ListRowPresenter`, `ImageCardView`). Each is defined by its AndroidX library,
so each fixture uses its library directly. No other module depends on them, and none is published.

The player needs no library: a framework `MediaSession` in front of a simulated, non-ticking player
gives media keys an exact, assertable effect without decoding video.

## Alternatives checked

| Alternative                               | Why not                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| Kotlin stdlib, JDK, AndroidX already used | Phone Compose Material has no TV focus indication; nothing in the build provides Leanback. |
| Compose foundation only for the TV app    | Misses the `tv-material` focus, scale and glow behaviour checks need to cover.             |
| Media3 `MediaSession` and ExoPlayer       | Real playback ticks and decodes; a framework session over fixed state is deterministic.    |
