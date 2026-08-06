# Playground crayon/marker design system

Shared design language for the **Playground** apps on Android and iOS. This is the
source of truth both platforms mirror. Tracked by the epic
[#5047](https://github.com/kaeawc/auto-mobile/issues/5047).

The look is derived from the app-icon illustration
(`docs/img/playground-launch-icon-concept.png`): a hand-drawn crayon/marker scene
in bright, playful colours. The design system turns that into tokens (this doc +
`android/playground/design/system`), hand-drawn components, and a GPU-backed
crayon texture (later phases of the epic).

## Palette

Sampled from the icon. Every **text** role pair below is verified against WCAG AA
(≥ 4.5:1) — on Android by `PlaygroundContrastTest`, and the same values must hold
on iOS.

### Light

| Role | Hex | Source in the icon |
|---|---|---|
| primary / onPrimary | `#D62A22` / `#FFFFFF` | marker-red truck outline (`#DF3028`, darkened slightly so it also meets AA as link/accent text on the background) |
| secondary / onSecondary | `#1F6FC2` / `#FFFFFF` | swing/sky blue (deepened for AA text) |
| tertiary / onTertiary | `#FFD23F` / `#3A2E00` | sun yellow |
| background / onBackground | `#FFF7EC` / `#241E18` | warm crayon paper |
| surface / onSurface | `#FFFFFF` / `#241E18` | — |
| error / onError | `#C1271F` / `#FFFFFF` | — |

### Dark

| Role | Hex |
|---|---|
| primary / onPrimary | `#FF8A7E` / `#3A0A05` |
| secondary / onSecondary | `#8FC4F5` / `#0A2A45` |
| tertiary / onTertiary | `#FFDD6B` / `#3A2E00` |
| background / onBackground | `#14110D` / `#F3E9DB` |
| surface / onSurface | `#241E17` / `#F3E9DB` |
| error / onError | `#FFB4AB` / `#690005` |

### Playful accents (illustration / component fills, not guaranteed AA as text)

sky blue `#2F7FD6` · grass green `#57AB46` · sand tan `#F2C879` · slide purple
`#8E5BD0` · cone orange `#FF7A1A` · ink `#282827`.

## Typography

**Shantell Sans** (SIL Open Font License) — a variable marker/felt-tip face — on
every type role. Font + licence are vendored per platform (Android:
`design/assets/src/main/res/font/{shantell_sans.ttf, OFL.txt}`). The Material type
scale (sizes/line-heights) is retained; only the family changes. On Android API
< 26 the variable weight axis is ignored (single default instance) — acceptable
degradation; every device still renders Shantell Sans.

## Shape

Chunkier, softer rounded corners than the Material default scale — the token-level
foundation of the hand-drawn look:

`extraSmall 6 · small 12 · medium 18 · large 26 · extraLarge 40` (dp). Custom:
`button 14 · card 18 · textField 12 · dialog/bottomSheet 26`.

True irregular **wobble** borders (via `GenericShape`/`Canvas` on Android,
`Shape`/`Canvas` on iOS) are layered on in the component phase, not the token phase.

## Texture (later phase)

Crayon/paper grain via real GPU shaders:

- **Android** — AGSL `RuntimeShader`, gated `Build.VERSION.SDK_INT >= 33` with a
  Compose `Canvas`/`Brush` grain fallback for API 24–32 (minSdk is 24).
- **iOS** — SwiftUI `ShaderLibrary` `.layerEffect`/`.colorEffect` Metal shader
  (deployment target is 17.0, so this is native with no bump).

## Platform mapping

| Concept | Android | iOS |
|---|---|---|
| Tokens | `design/system/theme/{Color,Typography,Shapes}.kt` → `AutoMobileTheme` (`dynamicColor=false`) | `Sources/Theme/{Colors,Typography,Shapes}.swift` → `AutoMobileTheme` env |
| Components | `design/system/components/*` | new SwiftUI component layer |
| Texture | AGSL + Canvas fallback | ShaderLibrary Metal |
