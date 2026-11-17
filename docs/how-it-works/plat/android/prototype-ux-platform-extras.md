# Prototype spec: dead taps, formatters, namespaces, glass and disposable apps

Part of [the agent-authored prototype specification](prototype-ux.md).

## Dead taps (`window.deadTaps`, `prototype_dead_tap_v1`)

`window.deadTaps: true` enables `emit` events named `prototype_dead_tap`. The
Android device advertises `prototype_dead_tap_v1`; this window option is a host
preflight capability, not a strict-spec gate.

A root Final-pass observer reports single-pointer down/up gestures left
unconsumed by descendants, with movement below touch slop. Scrolling, pager
drags, multitouch and taps outside the content window do not report. Interactive
controls and dismissing scrims consume their gestures. Gesture-only nodes with
nonempty long-press or double-tap actions explicitly mark their down as handled
without consuming it, preserving ancestor clicks. Passive text, boxes, images
and spacers remain dead areas. A single tap on a gesture-only node counts as
handled, even if its hold or double tap action does not fire.

Payloads contain only `stack`, `screen`, `x` and `y`; coordinates are window-local
dp rounded to one decimal. The deepest stack path supplies its id and top screen;
equal depths choose the lowest stack id lexicographically. Both ids are null
without stacks. The event uses normal sequence allocation, state, pages and
stacks. The payload never includes typed text. Authored emits cannot use the
reserved `prototype_` prefix. Disabling the option or closing the runtime stops
reporting.

## Value formatters (#14227)

Optional `derive` maps up to 32 STATE_KEY names to strict
`{of, format, locale?, timeZone?}` entries. `of` contains exactly one of
`{data: "/pointer"}` (relative to data), `{state: "key"}`, or
`{value: number|string}`. Every text field supporting `{data:/pointer}` also
accepts `{derived:name}`; undeclared names are validation errors, unused entries
are allowed, and malformed braces remain literal. Devices render these tokens in
text node text, contentDescription, rich-text spans, button/FAB labels, topAppBar
title, badge text, dialog title/text, and snackbar text. Other text-kind fields
(request url/headers/body, check messages, select/segmented/menu/searchBar labels)
validate unknown names but display the token literally on devices.

`repeat.derive` maps at most 8 names to the same entry shape with `of` restricted
to `{item: "field"}` or `{value: number|string}`. It projects strings onto each
original row for `{item.createdAtText}` (using the repeat's actual alias).
Names cannot collide with any original item field, including non-scalar data
fields. Derived entries do not read other derived entries. Host validation checks projected
field references without evaluating device-local strings; value-dependent checks
on derived repeat keys and emit names are deferred to the renderer. Missing source fields
are allowed and format as empty strings.

`format` contains exactly one of these keys, each containing a strict object:

| Kind     | Options and defaults                                       | Input                                       |
| -------- | ---------------------------------------------------------- | ------------------------------------------- |
| number   | minFraction?, maxFraction? (integers 0..20), grouping=true | finite number                               |
| compact  | style=short (short or long)                                | finite number                               |
| currency | code required, three uppercase ISO-4217 letters            | finite number                               |
| percent  | minFraction?, maxFraction? (0..20)                         | ratio, so 0.256 is 25.6% with maxFraction=1 |
| date     | style=medium (short, medium, long)                         | epoch milliseconds or ISO string            |
| time     | style=short (short, medium, long)                          | epoch milliseconds or ISO string            |
| relative | style=long (narrow, short, long)                           | epoch milliseconds or ISO string            |

minFraction must not exceed maxFraction when both are supplied. Omitted numeric
fraction options use Intl/CLDR defaults (currency respects minor units, including
zero for JPY). Number grouping true/default respects the locale's minimum grouping
digits; false disables grouping entirely. Compact, currency, and percent also
respect locale minimum grouping digits. Locale defaults to the device locale; timeZone defaults to the
device zone. Overrides accept a simple BCP 47 tag of at most 35 characters and an
IANA zone identifier of at most 128 characters. Shape validation does not prove
that the current engine supports a locale or zone.

Epoch milliseconds must be finite integers within the Date range. Strings are
`YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DDTHH:mm:ss[.fraction]Z` / a signed
`hh:mm` offset. Hours must be 00–23 and minutes/seconds 00–59; hour 24 and
leap second 60 are rejected. Invalid calendar dates, unzoned date-times, wrong types and
missing pointers display as the empty string. The host's pure formatter returns
undefined for invalid inputs; its resolver converts that to an empty string.

Relative formatting takes an injected nowMs snapshot; it never reads the real
clock. Choose the largest elapsed threshold not exceeding abs(input-nowMs):
year=365 days, month=30 days, day=24 hours, hour=60 minutes, minute=60 seconds,
second=1000 ms. Truncate toward zero. Under one second uses localized "now".
There are no weeks or calendar-month arithmetic. Callers resolve entry locale
and zone overrides before formatting, and keep the clock snapshot fixed when
reproducible output is required.

`prototype_format_v1` gates either derive map, including empty maps, before show
or the complete patch result. Renderers must implement this capability before
advertising it. Shared `derive/formatters.json` cases define parity: normalize
U+202F and U+00A0 to plain space before comparisons. Exact cases pin supported
English output; structural cases allow documented CLDR differences in foreign
currency symbols, narrow relative abbreviations, zero-relative wording and
non-English data. Add engine overrides only after measuring an actual platform
difference; the fixture note records the divergence policy and unit thresholds.

`dateTime`, `duration`, `plural` and `fileSize` are not format kinds (invalid). No dependencies are needed: the host uses Intl.NumberFormat,
Intl.DateTimeFormat and Intl.RelativeTimeFormat.

## Platform namespaces (#15257)

Prefer portable fields, portable theme tokens, then `theme.design`; reserve `ios`/`android`
for native semantics. Each closed contract field has a `why`. Both renderers advertise
`prototype_platform_namespace_v1` (iOS 17+). Foreign blocks are accepted and ignored with
paths in `platformNotes`; unknown fields are rejected on either platform. Window/theme
namespace blocks have no applicable node and are reported as ignored. The four node glass fields
require only `prototype_glass_v1` on iOS; mixing any other iOS key requires
`prototype_platform_namespace_v1` as well. Android ignores foreign glass fields
with their individual paths in `platformNotes`.

Android `indication` controls node clickable feedback (`ripple` or `none`); motion-off
still disables feedback. Stack `predictiveBack.style` preserves the normal pop for
`default`, uses horizontal movement and fade for `crossActivity` within the prototype
activity, and snaps without predictive scrubbing for `none`. Reduced motion still wins.

iOS `buttonStyle` applies `.glass`/`.glassProminent` on iOS 26+, using bordered buttons
below 26 with a substituted note. `hover` applies lift/highlight on iOS 17+ and is render-only.
The renderer custom-draws its tab bars, app bars and sheets to retain per-item identifiers, and
reports `tab.role`, `bottomAccessory`, `navigationTitle` and `sheet.sizing` as ignored. The
`bottomAccessory` field is node-only and structurally validated; its descendants provide no targets,
references or capabilities on either renderer. iOS ignores all Android fields.

## Glass surfaces and scroll edges

`style.surface` is a closed enum containing only `"glass"`. Optional strict
`style.glass: {variant?, tint?, interactive?}` takes `regular|clear` (default
regular), an existing hex/role/light-dark colour slot, and a boolean (default
false). The `glass` field without `surface: "glass"` in the same style is invalid, including
`styleWhen` entries; conditional glass options must repeat the surface. The `cornerRadius` field chooses the
shape; omission uses a capsule. Base and conditional styles require
`prototype_glass_v1`; bundles must list every required capability.

`scroll.edgeEffect: "soft"|"hard"|"none"` requires
`prototype_scroll_edge_effect_v1`. iOS 26 uses the native scroll edge style;
iOS 17–25 reuse the scrollability-aware `fadeEdges` mask, 24 dp for soft and
8 dp for hard. Authored `fadeEdges` lengths override those defaults; `none`
disables only the default fallback mask or native effect. Explicit `fadeEdges`
remain applied on every supported iOS version. Android accepts the contract but does not advertise or
render edgeEffect; Android below API 31 refuses glass.

In `ios`, `glassGroup: {spacing}` accepts finite 0–200 dp on column, row, box,
flow, grid, list and listItem containers. Descendant glass nodes with `shared`
keys use group-scoped glassEffectID, independently of visibility-pair matching;
nested groups establish a new namespace. Keys must be unique within the nearest
group and cannot also belong to visibility pairs. Under repeat, including on the
repeated node, a glass shared key must be a template referencing repeat.key.
Existing capability rules still apply. `glassUnion` is a 1–64 character ASCII id token
(`[A-Za-z_][A-Za-z0-9_]*`); `glassTransition` is matchedGeometry, materialize or
identity. Both require a base glass surface on the same node.
`backgroundExtension: true` is image-only and does not require the image itself
to be glass. All four fields are node-only (invalid in window.ios/theme.ios) and
require only the glass capability on iOS; Android ignores them with field paths
in platformNotes.

The system's Liquid Glass implementation handles Reduce Transparency and
Increase Contrast. On iOS 17–25 and Android below API 31 the device does not advertise
`prototype_glass_v1`, so the host refuses glass there: there is no simulated
translucent fill, material substitute or fallback capability. An Android
renderer advertising glass must report any approximation (clear variant,
ignored `interactive`) in `platformNotes`.

### Motion tokens

`animate.tempo: "fast" | "default" | "slow"` requires `prototype_motion_tokens_v1`
and cannot be combined with `durationMs` or `easing`. The contract's `motionTokens`
table selects a physical spring by scheme (`motion: "standard"` by default, or
`"expressive"`), property role and tempo. `easing: "spring"` selects the default
tempo of that scheme. Spatial properties are offset, scale, rotation, cornerRadius,
elevation, shadowColor, padding, border width and dp width/height; alpha, background,
color and border color use critically damped effects springs.

| Scheme / role         | Damping ratio (fast / default / slow) | Stiffness (fast / default / slow) |
| --------------------- | ------------------------------------- | --------------------------------- |
| standard spatial      | 0.9 / 0.9 / 0.9                       | 1400 / 700 / 300                  |
| expressive spatial    | 0.6 / 0.8 / 0.8                       | 800 / 380 / 200                   |
| either scheme effects | 1 / 1 / 1                             | 3800 / 1600 / 800                 |

Compose uses `spring(dampingRatio, stiffness)`. SwiftUI uses
`interpolatingSpring(mass: 1, stiffness: k, damping: 2 * dampingRatio * sqrt(k))`,
so both renderers use the same physical spring. Reduced motion snaps spatial
changes and retains effects; motion off snaps everything. Existing motion v2/v3
capability requirements still apply; iOS advertises the token capability but
continues to refuse those broader features until its corresponding capabilities
are available.

## Disposable apps

A disposable app installs one spec as its own app, with its own package, label, icon, permissions
and foreground-service types. The host core lives in `src/features/prototype/disposableApp/`.
The Android stamper packages a spec into a signed APK; the `prototype installApp`, `listApps`
and `uninstallApp` actions remain separate from this artifact pipeline.

- **Identity.** The package is `dev.jasonpearson.automobile.app.<slug>_<sha256(slug) 8 hex>`.
  Hyphens in the slug become underscores because Android package segments allow only
  `[A-Za-z0-9_]`. A slug is lowercase hyphen-separated words of at most 48 characters that start
  with a letter. The prefix is never agent-chosen, so a disposable app cannot replace a real app.
- **Permissions** come only from the spec's root `requires`. `INTERNET` is always declared.
  Each canonical permission maps to its manifest permissions (`location` maps to fine and coarse;
  `photosAdd` maps to none). Each `requires.background` kind adds `FOREGROUND_SERVICE` and its
  `FOREGROUND_SERVICE_<TYPE>` permission; `remoteNotification` adds none. The permission mode is
  `prompt` (the default), `grantDeclared`, or `{grant, deny}`, which may name only declared
  permissions and must not name one in both lists.
- **Template.** The host picks the smallest flavor whose capabilities cover
  `requiredPrototypeCapabilities(spec)`. If none does, it refuses and names the missing capabilities
  and the closest flavor.
- **Registry.** The registry file `disposable-apps.json` under the AutoMobile data dir keys records
  by device id. Each record holds appId, slug, platform, label, spec sha256, template, signer,
  installedAt and expiresAt. The host serializes writes and makes them atomic. It skips a corrupt
  file or record with a warning. An install writes its record, with the new expiresAt, as soon as
  the package is on the device and before the host applies permissions. A permission failure then surfaces as an error saying the app is
  installed without its permissions, and the sweep still sees the current TTL.
- **Lifecycle.** `ttlHours` defaults to 72, accepts 0 to 720, and 0 means no expiry. Re-installing
  a slug updates the app in place and keeps its storage unless `reset` is set. The expiry sweep and
  uninstall refuse ids outside the prefix. They also refuse installed packages whose signer differs
  from the host's disposable-app key: one requested id is refused with an error, and in a bulk
  removal the package is reported under `skipped`. Each removal is logged at `warn`. An app that
  is already gone from the device still has its registry record cleared.
- **Device commands.** The Android installer runs `adb install -r` (then `pm clear` for `reset`),
  `pm grant` per granted manifest permission, and `pm revoke` plus the `user-set user-fixed` flags
  per denied one, so a denial reads as blocked with no dialog. It refuses a grant and a deny that
  share a manifest permission (`microphone` and `speech`) before any write. `adb install` and
  `adb uninstall` must print `Success`. The installed signer comes from the package signing
  inspection; a signer set that cannot be read never matches the host key, and an unknown
  presence fails the removal instead of guessing.

### Template packaging and stamping

The release template package contains an unsigned, unminified APK, the merged text
manifest, stamp points, capability metadata, and template identity plus APK SHA-256.
The host loads a local flavor through `AUTOMOBILE_ANDROID_PROTOTYPE_APP_TEMPLATE`
and checks its checksum; a released download is not available yet.

Stamping preserves the compiled code and resource table. The host changes the
package, provider authorities, literal label, exact permission set (always including
INTERNET), and explicitly enabled components in structured XML. App-owned resource
references retain the template resource namespace with private-resource access.
`aapt2 link` resolves those names back to binary resource ids, avoiding unsafe
binary-manifest string replacement. The spec and assets are baked under
`assets/prototype/` at stamp time. An `icon.backgroundColor` (`#RRGGBB` or
`#AARRGGBB`) rewrites the `prototype_icon_background` colour value in the stored
resource table, in every configuration. That colour backs the adaptive icon and the
Android 12+ splash screen, so both follow it. The stamp fails if the template has no
literal colour by that name. An `icon.asset` is refused: the raster foreground
layer is not stamped yet.

Template signatures are removed before assembly. The resource table stays stored;
zipalign aligns it before apksigner signs with v2/v3 using a persistent host-owned
PKCS12 identity. Verification checks the resulting signer before publishing the
content-addressed cache artifact. The signer certificate SHA-256 is available to
the installation signing guard. Cache identity covers the template, stamp inputs,
asset bytes, and signer; cache hits check the saved artifact digest.
