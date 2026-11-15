# iOS prototype agent: saved prototypes, sharing and effects

Part of [the iOS simulator prototype agent](prototype-agent.md).

## Saved prototype on-disk layout (#12254)

One saved prototype lives in the viewer app container:

```text
Documents/prototype/
  manifest.json
  spec.json
  assets/<sha256>.png|jpg|webp
  fonts/<sha256>.ttf|otf
```

Same-id `show` write-through replaces only `spec.json`, and only when the layout was loaded.

Version 1 manifest (strict):
`{"formatVersion":1,"specFile":"spec.json","assets":[{"id":"image","file":"assets/<sha256>.png","sha256":"<sha256>","mediaType":"image/png"}],"fonts":[]}`.
Both arrays always present. SHA-256 is lowercase hex over file bytes; identical bytes with the same
media type share one content-addressed file; paths must exactly match media type, folder and hash; IDs
are unique across both arrays. The shared asset contract caps count, per-file and total bytes; spec and
manifest caps are 1 MiB and 256 KiB.

The host writer stages a sibling `.tmp-<token>` directory, writes the manifest last, then renames into
place; replacement first backs up the old directory to `.old-<token>` and restores it if the commit
rename fails. Callers serialize writes. The reader refuses unknown versions before validating
version-specific fields and never changes files. A bad manifest, spec, count or verified-byte total is
corrupt. The reader omits missing, unreadable, unsafe, empty/oversized or hash-mismatched assets from the
verified snapshot and reports them as sorted problems (the viewer shows its missing-asset placeholder and
exposes problems via `inspect`). Unlike Android's slug directories, iOS stores one prototype with no
manifest id, label or savedAt. Asset failures leave the prototype loadable; reading never repairs or
deletes. The writer permits spec references absent from the request (reported by the reader as missing
manifest entries). The installer is separate (#12256).

Implementations: `src/features/prototype/savedPrototypeLayout.ts` and
`ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeSavedLayout.swift`; both test suites
consume `test/fixtures/prototype-saved-layout/layout.json` (same expected manifest and hashes; binaries
generated at test time).

## Viewer template release asset

Release automation ships `AutoMobilePrototypeViewer.zip` with a single top-level `PrototypeViewer.app/`.
The script `scripts/ios/prototype-viewer-build.sh` ad-hoc signs the universal arm64 + x86_64 simulator app.
Then `scripts/ios/build-prototype-viewer-release.sh` packages it with `ditto -c -k --keepParent` (preserving
executable mode and signature). The `build-prototype-viewer.yml` workflow verifies both architectures,
`MinimumOSVersion`, the signature, and the absence of `Assets.car`, `InfoPlist.strings` and
`CFBundleIconName` before upload.

Prepare Release records the archive SHA-256 as `prototypeViewerSha256` beside `prototypeAgentSha256`,
verifies the downloaded candidate against it and includes `prototype-viewer` in provenance; Release
reuses that artifact and publishes its checksum in the notes. Older registry entries omit the pin and
resolve to "viewer unavailable". The host template provider resolves: explicit path,
`AUTOMOBILE_IOS_PROTOTYPE_VIEWER`, configured local builds, then a checksum-pinned release cache/download
(unless `AUTOMOBILE_SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD`).

### Share contract

`requires.platform: ["share"]` enables the `share.open` platform-call grammar; its generated
gate is `prototype_platform_share_v1`. Neither runtime advertises that capability until its
system-sheet driver is implemented. There are no share events or `/platform/share` state keys.
The existing `into`, `statusKey`, `onSuccess`, `onError`, timeout and `prototype_platform`
completion contract applies. A cancelled sheet must fail with `cancelled` and run `onError`.

Arguments use value bindings. At least one nonblank `text`, nonempty `url`,
`images`, `files`, or `contact` is required; `subject` alone is not an item.
`subject` is optional; the error for `title` directs callers to use `subject`. String values use `{key}`,
`{data:/pointer}`, `{item.field}`, `{index}` without rescanning substitutions. Missing state
or item text remains literal; missing/non-scalar data text becomes empty. Missing whole-value
bindings fail with `invalid_args`. Data, event, and platform pointer roots must be objects;
arrays can be traversed below an object member, but an array root is a missing binding. URLs must have a literal http(s) scheme; placeholders elsewhere are checked again after binding;
relative, javascript, data, file, and prototype deep-link URLs are refused. Userinfo, backslashes, ASCII whitespace, C0/C1 controls, NBSP, U+2028–U+202E, and
U+2066–U+2069 are refused by the portable URL grammar.

Images contain 1–10 uploaded asset IDs, `{asset: id}` objects, or `{data: "/pointer"}` objects
resolving to either uploaded-ID form. Files contain 1–4 `{asset, name, mimeType}` objects.
Names are 1–128 UTF-8 bytes, cannot start with a dot, and cannot contain path separators or
C0/C1 controls, NBSP, U+2028–U+202E, or U+2066–U+2069. Windows reserved device names,
colons, trailing dots, and ordinary spaces are allowed by this platform-neutral contract. MIME values are nonempty RFC token `type/subtype` values, with no parameters.

No device-local media type is introduced. A complete `shareAssetIds` inventory enables static
unknown-ID refusal; bundle references use the existing asset lookup, and pure resolution always
checks the supplied uploaded inventory. Every referenced entry must include a nonnegative
safe-integer `bytes` value; malformed metadata fails with typed `invalid_args`. Existing asset transport limits and supported media types
still apply; the contract does not add PDF or other upload formats.

Contact fields are exactly `name` (nonblank, required), `phone`, `email`, `org`, `url`, `note`.
The pure `resolvePrototypeShare` twins produce vCard 3.0 (`text/x-vcard`, `public.vcard`):
`FN` and an unstructured family `N` hold name, with `TEL`, `EMAIL`, `ORG`, `URL`, `NOTE` in that
order. TEXT properties escape backslash, comma, semicolon and CR/LF; the URI-valued `URL`
property is preserved verbatim. Lines use CRLF, and lines fold at
75 UTF-8 octets (continuation space included), without splitting a Unicode scalar.

No Contacts permission is needed. Each string is bounded by `MAX_PROTOTYPE_SHARE_TEXT_BYTES`
(65536); literal and resolved arguments use the same rules. Library imports refuse secure
state in every share string, including nested contact/file values and follow-up handlers.
The library secure-value scan guard caps total expanded bytes at 4,194,304 bytes, measured as
authored UTF-8 sink bytes charged per repeat row before allocating repeated strings; zero-row
templates are charged once. It charges literal spans even when substitution would shorten them.
The guard is conservative and may refuse legitimate large library specs.

See [Known platform differences](../android/prototype-ux-request.md#known-platform-differences) for
lone-surrogate decoder/encoder behavior and host component expansion before native validation.

Pure resolution returns `{ok:true,payload,summary}` or
`{ok:false,error:{code:"invalid_args",path,message}}`. Payload includes uploaded image IDs,
files with supplied byte metadata, optional text/url/subject and optional `vCard`. Summary is
`{outcome:"shared"|"unknown",target?,items:{text?,url?,subject?,images,files,contact}}`, with
file entries `{name,mimeType,bytes}`. Text is truncated to 2048 Unicode scalar values, never
splitting a surrogate pair. The pure function defaults to `unknown`; only a future driver may
supply completion evidence. Android `shared` will mean a chosen target, not completed delivery;
iOS uses its activity completion flag. `target` is the chosen package/activity raw value.

The contract has no system-sheet dispatcher or fake-mode behavior. `platformMode` and
`prototype simulate` are not accepted by this vocabulary.

## Runtime permissions (#14297)

The injected agent never advertises `prototype_platform_permissions_v1`: a grant would go to the host app it
is borrowing. Each canonical permission's Info.plist usage key and `simctl privacy` service come from
`schemas/prototype-platform-permissions.json`, and a `requires.permissions[].purpose` is the usage string. On a
simulator the host grants and denies with `simctl privacy grant|revoke` before launch. The `notifications`,
`bluetooth`, `nearbyWifi` and `speech` permissions have no `simctl privacy` service, so the host reports them
`notGrantableOnSimulator` with `verified: false` and leaves them to the system-alert policy. No Viewer
advertises the module yet (#14299). See the permission table in `prototype-ux.md`.

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
The renderer's tab bars, app bars and sheets are custom drawn to retain per-item identifiers.
The agent reports `tab.role`, `bottomAccessory`, `navigationTitle` and `sheet.sizing` as ignored.
The `bottomAccessory` field is node-only and structurally validated; its descendants provide no targets,
references or capabilities on either renderer. iOS ignores all Android fields.

## Icon effects

`prototype_icon_effects_v1` is advertised on iOS 17 and later. Icon `effect`
selects native SF Symbol effects through a pure type/version decision table.
The bounce, pulse, scale.up, variableColor and replace effects need 17. The wiggle, rotate and
breathe effects need 18 and fall back to bounce, none and pulse on 17. The drawOn effect needs 26
and otherwise uses replace. A `trigger: {key}` or `{data}` replays on value changes;
`repeat` is "infinite" or 1–20 and cannot coexist with trigger. Replace follows
name changes. Reduced/off profiles rest; reduced replace uses a plain crossfade.
The host reports fallback notes with node paths, using the discovered OS version
when available. The shared validator charges repeated effects against the eight
animated-effect budget, including expanded list instances.

The iOS `hide_for_capture` hold removes repeated symbol modifiers, returning icons to
rest until the last capture token releases or expires. Restoring restarts native
repeats. Local `PrototypeIconMotionActivity` tracks mounted repeated effects and
masks activity during capture. Finite native repeats remain conservatively active
until unmounted because SF Symbols provides no completion callback. iOS has no
shared motion-active wire signal or shimmer reporter yet. This local signal does not
reach the host, and captures that bypass `hide_for_capture` do not rest effects.

The shared contract validates node `attentionLoop: {effect: "pulse" | "spin", periodMs, iterations?}`.
It checks integer period 400–4000 ms, finite iterations 1–20 or `"infinite"`, the
eight-node expanded-tree limit, and identity rest-pose conflicts in style and conditional styles.
The agent renders no attention loops and does not advertise `prototype_loops_v1`; the host
refuses a loop spec against it. Shimmer does not consume the attention-loop limit.

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
changes and retains effects; motion off snaps everything. iOS advertises the token
capability and `prototype_motion_v2`, supporting `animate`, style `scale`/`rotation`,
`slideStart`/`slideEnd`/`scale` transitions, and `image.zoomable`. Motion v3 requirements
(including node `press` and layout `animate`) are detected, but iOS does not advertise
`prototype_motion_v3`, so the host refuses motion v3 features.

## Glass and scroll edges

The agent advertises `prototype_glass_v1` only on iOS 26+, and
`prototype_scroll_edge_effect_v1` on every supported OS. Glass namespace fields
require only `prototype_glass_v1`; mixing them with other iOS namespace fields
also requires `prototype_platform_namespace_v1`. Specs and library bundles are
validated before rendering and must satisfy these gates, including conditional
styles and hidden templates. iOS 17–25 refuse glass; no material substitute is
used.

`style.surface: "glass"` applies Liquid Glass regular/clear, optional colour tint
and interactive feedback, after layout and paint. `cornerRadius` selects the
shape; absent means Capsule. Conditional `styleWhen` glass options must repeat
`surface: "glass"` in the same style. `ios.glassGroup` owns a GlassEffectContainer and
namespace; descendant glass nodes use `shared.key` for glassEffectID,
`ios.glassUnion` for union identity and `ios.glassTransition` for the native
transition. Nested groups scope their own IDs. Keys must be unique per nearest
group, cannot collide with visibility-pair keys, and must use repeat.key templates
under repeat (including on the repeated node). `ios.backgroundExtension: true`
on images uses backgroundExtensionEffect. All four glass keys are node-only and
are rejected in window.ios/theme.ios.

`scroll.edgeEffect` uses scrollEdgeEffectStyle on iOS 26 (none hides the effect).
Older systems reuse the existing scrollability-aware fade mask: soft 24 dp,
hard 8 dp, authored fadeEdges lengths taking precedence. None disables only the
native effect or default fallback; explicit fadeEdges still apply on every iOS version.
Reduce Transparency and Increase Contrast use system behaviour. Tests assert
structure and bounds with pinned settings; group morphing and the visual result are not
device-verified.

## Disposable apps (#14184, host core only)

The host core in `src/features/prototype/disposableApp/` is shared with Android. See "Disposable
apps" in `docs/how-it-works/plat/android/prototype-ux.md` for the registry, template choice, TTL and
removal rules. The host does not wire iOS stamping (#14186) yet. The iOS-specific parts are:

- **Identity.** The bundle id is `dev.jasonpearson.automobile.app.<slug>-<sha256(slug) 8 hex>`. It
  keeps the slug's hyphens, the same pattern `prototypeBundleId` uses for saved Viewer copies under
  `dev.jasonpearson.automobile.proto.`.
- **Info.plist.** Usage descriptions come from `requires.permissions`: each entry's `purpose` is
  written under its usage key. The table is `DISPOSABLE_APP_IOS_USAGE_KEYS`, which the saved-Viewer
  installer also reads. Neither `notifications` nor `nearbyWifi` has a usage key. The `UIBackgroundModes` key
  comes from `requires.background`: `audio` and `microphone` map to `audio`, `location` to
  `location`, `call` to `voip`, `connectedDevice` to `bluetooth-central`, `transfer` to
  `processing` and `remoteNotification` to `remote-notification`. The `camera` value has no iOS background
  mode.
- **Signer.** A simulator does not report a signer, so removal relies on the reserved prefix alone.
