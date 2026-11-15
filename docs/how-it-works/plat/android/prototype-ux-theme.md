# Prototype spec: theme

Part of [the agent-authored prototype specification](prototype-ux.md).


Optional top-level `theme` selects the design and sets the scheme components draw
from. At least one of its fields is required:

| Field                         | Meaning                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design`                      | `material` or `platform` (default). Explicit `platform` requires `prototype_design_platform_v1`; omission silently retains today’s drawing on older renderers.                    |
| `mode`                        | `light`, `dark` or `system` (follow the device). Omitted: inferred from the first opaque background on the root's leading chain, else the device setting.                         |
| `colors.seed`                 | Hex color a full light or dark scheme is generated from.                                                                                                                          |
| `colors.source`               | `device`: Android 12+ (API 31) dynamic color. On older devices it falls back to `colors.seed` when present, else the default scheme.                                              |
| `colors.<role>`               | Hex override for one Material 3 role (`primary`, `onPrimary`, `surface`, `surfaceContainer` … the 36 roles style colors accept), applied over the seed, device or default scheme. |
| `colors.light`, `colors.dark` | Maps of role name to hex, applied after `colors.<role>` in the matching mode only. See [Light and dark values](#light-and-dark-values).                                           |
| `typography.scale`            | Number 0.75–1.5 multiplying the size and line height of every Material type role. Default 1.                                                                                      |
| `typography.fontFamily`       | `sans`, `serif` or `mono`: the family of every Material type role.                                                                                                                |
| `shapes.corner`               | `none`, `small`, `medium` (the stock Material 3 scale), `large` or `full` (pill). Shifts every corner family built-in components use.                                             |

`colors`, `typography` and `shapes` each need at least one field. An explicit theme wins over the scheme
inferred from backgrounds.

Role overrides are literal colors, so they apply unchanged in light and dark. Pair them with a
fixed `mode`, or rely on `seed`/`source` for a mode-aware scheme and override only the roles that
must match a brand. With no `mode`, a `colors.background` (else `colors.surface`) override decides
light or dark from its luminance, ahead of the authored-background inference, for both the content
scheme and the host dismiss control. A spec that names only roles in its styles and no hex
literals renders in light and dark from one source.

A text node's `style.textStyle` names a Material 3 type role (`displayLarge` … `labelSmall`, 15
in all) and so follows the theme's scale and family. It supplies size, weight and family; an
explicit `textSize`, `fontWeight` or `fontFamily` on the same node still wins. Plain text
without `textStyle` keeps its authored 14 sp default and is not scaled; it takes the theme's
`typography.fontFamily` only when it names no `fontFamily` of its own.

A text node with no `color` draws in the theme's content colour (`onSurface`). A `cornerRadius` token maps to the
theme's Shapes (`shapes.corner` shifts them), `none` is square and `full` a pill. A
role-valued `background` does not take part in inferring the prototype's light/dark
theme from authored backgrounds (it would be circular); set `theme.mode` or
`colors.seed` for that.

## Design coverage

The contract's `designCoverage` table records the current drawing for each node. `neutral`
means layout or content with no design language of its own. Android's platform look is Material.
On iOS, explicit `theme.design: "platform"` reports `design.fallback` platform notes for Material
nodes (first 20 paths, with `total` when larger). Omission and `material` report no design fallback
notes.

| Node            | iOS      | Android  | Parts |
| --------------- | -------- | -------- | ----- |
| badge           | material | material | —     |
| bottomNav       | material | material | —     |
| bottomSheet     | material | material | —     |
| box             | neutral  | neutral  | —     |
| button          | native   | material | —     |
| cameraPreview   | material | material | —     |
| card            | material | material | —     |
| carousel        | neutral  | neutral  | —     |
| castButton      | material | material | —     |
| chart           | material | material | —     |
| checkbox        | material | material | —     |
| chip            | material | material | —     |
| column          | neutral  | neutral  | —     |
| datePicker      | native   | material | —     |
| dialog          | material | material | —     |
| adaptive        | material | material | —     |
| drawer          | material | material | —     |
| tooltip         | material | material | —     |
| divider         | neutral  | neutral  | —     |
| fab             | material | material | —     |
| flow            | neutral  | neutral  | —     |
| grid            | neutral  | neutral  | —     |
| icon            | neutral  | neutral  | —     |
| iconButton      | material | material | —     |
| image           | neutral  | neutral  | —     |
| list            | material | material | —     |
| listItem        | material | material | —     |
| map             | neutral  | neutral  | —     |
| menu            | material | material | —     |
| pager           | neutral  | neutral  | —     |
| pasteButton     | native   | material | —     |
| progress        | material | material | —     |
| radioGroup      | material | material | —     |
| row             | neutral  | neutral  | —     |
| scroll          | neutral  | neutral  | —     |
| searchBar       | material | material | —     |
| segmentedButton | material | material | —     |
| select          | material | material | —     |
| slider          | native   | material | —     |
| snackbar        | material | material | —     |
| spacer          | neutral  | neutral  | —     |
| stack           | neutral  | neutral  | —     |
| switch          | material | material | —     |
| tabBar          | material | material | —     |
| text            | neutral  | neutral  | —     |
| textField       | material | material | —     |
| timePicker      | native   | material | —     |
| topAppBar       | material | material | —     |
| videoPlayer     | material | material | —     |
| webView         | neutral  | neutral  | —     |

## Light and dark values

A shown prototype has exactly one resolved mode, light or dark. The first match decides it: an explicit `theme.mode`
(`system` reads the system setting), else the luminance of a flat `colors.background` (else
`colors.surface`) override. Failing those, it is the first opaque hex background on the root's leading chain, else
the system setting. Every per-mode form below reads that one resolved mode. A device needs
`prototype_theme_modes_v1` for them; the host refuses such a spec for an older CtrlProxy.

- **Colour pairs.** Every colour slot accepts a hex value, a role name, or `{light, dark}` where each
  side is a hex value or a role name. The slots are `style.background`, `style.color`, `style.shadowColor`,
  `style.border.color`, gradient stops, `window.placement.scrim` and the `bottomSheet` `scrim`,
  including inside `styleWhen`. Both sides are required. The renderer takes the side for the resolved mode, which is
  then a literal colour or a role looked up in the active scheme.
- **Role maps.** The scheme is built in this order: seed, device or default scheme, then the flat
  `colors.<role>` overrides (both modes), then `colors.light` or `colors.dark` for the resolved
  mode. A role named in both the flat overrides and the mode map takes the map's value in that
  mode and the flat value in the other. A role name inside a pair resolves against this final
  scheme, so there is no precedence to decide between a node's pair and the theme maps. The pair
  picks the name or literal, the scheme supplies the role's colour.
- **Mode inference ignores per-mode values.** `colors.light` / `colors.dark` and a `{light, dark}`
  background never decide the mode, because they depend on it. A pair background is skipped by
  the authored-background inference in the same way a role-named background is, and the search
  continues down the leading chain. A spec whose only backgrounds are pairs or roles follows the
  device setting.
- **Gradient stops** accept role names; a role is the scheme's colour unchanged.
- **Scrims** (`window.placement.scrim` and the `bottomSheet` `scrim`) accept role names with one
  special case. The `scrim` role, alone or as the side of a pair for the resolved mode, draws the
  scheme's scrim colour at the default scrim opacity (40%). An omitted `bottomSheet`
  scrim uses the same value, so `"scrim": "scrim"` dims rather than hides the app. Any other role (`surface`,
  `primary`, …) draws its scheme colour unchanged, which is opaque unless the theme overrides it
  with alpha. A hex scrim keeps exactly its authored alpha. A `dialog` authors no scrim; its
  fixed scrim is the `scrim` role at 32%.
- **Component colours.** A role name or pair in `style.color` on a `button`, `checkbox`, `switch`,
  `radioGroup` or `listItem`, and in `style.background` on a `card` or `listItem`, resolves
  against the theme like any other colour slot. Before `prototype_theme_modes_v1` only a hex value
  took effect in those slots.
- **Images.** `image.asset` and a `tabBar`/`bottomNav` item `image` accept
  `{light: assetId, dark: assetId}`. Only the asset for the resolved mode is decoded and drawn;
  both ids are checked at `show` and reported in `missingAssets`, and both stay retained with the
  prototype.
- **Window metadata.** `prototypeOpaque` follows what is drawn. The root background and window scrim are resolved in the show's mode and count as solid only when fully opaque (an opaque role counts; the `scrim` role in a scrim slot never does). The root counts only when drawn over the whole window (#11408). That needs `width` and `height` both `fill` (omitted fullscreen- and sheet-root dimensions default to `fill`). It also needs no `anchor`, no `maxWidth`/`maxHeight` cap, no `aspectRatio`, no non-zero `offset`, no rounded corner and no `pressScale` below one. A root failing any of these lets the app show at an edge or corner, so only an opaque fullscreen scrim behind it can still make the window opaque. A chromeless fullscreen window can report `true` when opacity is 100 and its root or scrim is solid; a fullscreen window with the translucent dismiss bar still reports false.

## Live appearance (#11221, `prototype_appearance_v1`)

The controller resolves the mode once per show and keeps it current. That one value drives the host chrome (dismiss bar, Close control), the window scrim, every colour and image pair and the window metadata, so they cannot draw in different modes. No window reads its own Compose configuration for it, so windows from a display or app-layer window context follow the same value.

- **Override.** `show_prototype` takes a top-level `appearance`: `"device"` (default), `"light"` or `"dark"`. It stands in for the system setting only. It decides a spec with `theme.mode: "system"` or one whose mode would otherwise fall through to the device. It does not beat an explicit `light`/`dark` mode, a flat `background`/`surface` override or an authored opaque background. It belongs to the show (a later show of the same id without it follows the device). An unknown value fails the request and leaves what is showing untouched.
- **Re-theme.** The renderer resolves the mode again after each interaction, since a pager page or `styleWhen` state can change the background it infers from. It also resolves on every configuration change (night mode; on API 31+ the Material You palette, so `colors.source: "device"` re-reads after a wallpaper change). The window, runtime, state, pager pages and text-field contents stay; only colours change. A prototype hidden by the lock screen or because its app left the foreground resolves too and returns in the current mode.
- **Event.** When the resolved mode changes the device sends one `prototype_event` with `kind: "appearance_changed"`, `name: null`, `payload: {mode, source}` on the normal sequence, buffering and replay path. Nothing is sent when the mode stays the same (repeated configuration change, device flip under an explicit mode or override, palette change), nor for the show itself.
- **Report.** A successful `show_prototype` result and each `inspect_prototypes` entry carry `appearance: {mode, source, deviceDark}`. The `source` field names the deciding step: `explicit`, `override`, `roleLuminance`, `authoredBackground` or `system` (`theme.mode: "system"` reports `system`, or `override` when the show pinned it). `deviceDark` is the device's own setting. The host `prototype` tool reports it only in device answers (show, inspect), not host-local `status` (#11416). The prototype's window entry in a hierarchy capture carries it as `prototypeAppearance` next to `prototypePlacement` and `prototypeOpaque`; an APK without `prototype_appearance_v1` omits it.
