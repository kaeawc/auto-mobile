# ProtoViewer store listing as code

The Play and App Store listing text, the app icon and the screenshot plan live in the repository
(#14152). A listing change is reviewable and diffable, and a stale or over-length listing fails
Fast Validation instead of failing at upload.

## Layout

```text
fastlane/metadata/
  android/<locale>/{title,short_description,full_description,video}.txt
  android/<locale>/changelogs/{default,<versionCode>}.txt
  android/<locale>/images/{phone,sevenInch,tenInch}Screenshots/   (generated)
  ios/<locale>/{name,subtitle,description,keywords,promotional_text,release_notes}.txt
  ios/<locale>/{privacy_url,support_url,marketing_url}.txt
  ios/<locale>/screenshots/                                       (generated)
  ios/review_information/notes.txt
store-listing/icon/{background,foreground}.svg
scripts/store-listing/
```

The tree follows the fastlane `supply` (Play) and `deliver` (App Store) conventions, which F-Droid
also reads. The Play pipeline uploads it with `supply` ([ProtoViewer](protoviewer.md) section 8.3). The `en-US` locale is required,
and the same rules validate any other locale directory. Neither store has a repository-hosted source of truth
today: the stores keep whatever was last uploaded, and this tree is what gets uploaded.

The text is provisional until the owner decision in #14143 (policy positioning, review notes) lands.
The name is ProtoViewer on both stores, and the privacy and support URLs are docs-site pages
(`docs/protoviewer/privacy.md`, `docs/protoviewer/support.md`), per #14144.

## Review position

The App Review notes (`fastlane/metadata/ios/review_information/notes.txt`) and the Play declarations below use one
position: ProtoViewer is a viewer for design prototypes the user authors, not a mini-app platform.

- A prototype is validated, declarative JSON. The renderer's features are fixed in the binary, so a
  prototype adds no code (App Store 2.5.2, Play Device and Network Abuse).
- `request` actions run only while the imported-prototype network switch is on. Their responses fill
  the prototype's data model and cannot add components or behaviour.
- The Local Network prompt appears only after that switch is turned on and confirmed.
- Received prototypes have Report (a mail draft to the published contact) and Hide on both apps.
  Android also blocks a link host (App Store 1.2, Play User Generated Content).
- The library is empty on first launch. There is no bundled sample gallery, and the listing must not
  claim one (decision in the [ProtoViewer design record](../devlog/2026-10-20-protoviewer-design.md)).

Play Console declarations:

| Declaration               | Answer                                                                   |
| ------------------------- | ------------------------------------------------------------------------ |
| User-generated content    | Yes: users receive prototypes others made; in-app Report, Hide and Block |
| Downloads executable code | No: prototypes are declarative JSON read by a fixed renderer             |
| Data safety               | See the [privacy page](../protoviewer/privacy.md)                        |

## Validation

`bun scripts/store-listing/validate-store-listing.ts` runs in Fast Validation as the `store-listing`
check. It reads files only. Lengths count Unicode code points, as the consoles do.

| Field                                   | Limit      |
| --------------------------------------- | ---------- |
| Play title                              | 30         |
| Play short description                  | 80         |
| Play full description                   | 4000       |
| Play changelog (per release)            | 500        |
| App Store name                          | 30         |
| App Store subtitle                      | 30         |
| App Store keywords (comma separated)    | 100        |
| App Store promotional text              | 170        |
| App Store description, release notes    | 4000       |
| App Review notes (`review_information`) | 4000       |
| Privacy, support and marketing URLs     | `https://` |

It also rejects:

- missing required files, empty or whitespace-padded files, and CRLF line endings;
- multi-line titles, keywords with spaces around commas, duplicate keywords, and a keyword that
  repeats the app name;
- a subtitle equal to the name;
- unknown files in a locale directory, and a locale directory that is not a store locale code.

The privacy and support URLs must be pages under the mkdocs
`site_url` whose Markdown source exists under `docs/`. The two icon layers must be well-formed SVG on the shared
`0 0 108 108` canvas. The rules and limits live in `scripts/store-listing/storeListing.ts`.

## Icons

The single vector source is a layer pair on the Android adaptive-icon canvas: `background.svg` and
`foreground.svg`, both `viewBox="0 0 108 108"`. Keep every foreground shape inside the central
66 x 66 safe zone (coordinates 21 to 87), and draw detail as holes (`fill-rule="evenodd"`) so the
themed monochrome layer keeps it.

```bash
bun scripts/store-listing/generate-icons.ts [--out <dir>]   # default build/store-listing/icons
bun scripts/store-listing/generate-icons.ts --list          # print the target table
```

The generator renders with `sharp`, an existing direct dependency (libvips draws the SVG), so there
is no new package. The table in `scripts/store-listing/iconTargets.ts` produces:

- Android, per density (mdpi to xxxhdpi): adaptive `foreground`, `background` and `monochrome` layers
  (108 dp) and the rounded legacy `ic_launcher` (48 dp).
- Play: the 512 px store icon.
- iOS: an `AppIcon.appiconset` with the 1024 px icon in light, dark and tinted appearances (opaque,
  no alpha) and its `Contents.json`.

The Android app references `@mipmap/ic_launcher`, an adaptive icon with foreground, background
and monochrome vector drawables matching these SVG sources. The foreground and monochrome paths
retain the evenodd holes. ProtoViewer requires API 26, so no legacy fallback is needed. The same
adaptive resource supports round launcher masks.

Two runs over the same sources write byte-identical files. The PNGs are build output and are
git-ignored: this repository routes `*.png` through Git LFS, and generated art does not belong in
history. Distinct dev and beta icons (as in #14152's proposal) are a second layer pair plus a channel
column in the table; they are not drawn yet.

## Screenshot plan

The file `scripts/store-listing/screenshotPlan.ts` is the plan as data: four screens (library,
viewer, import, share), light and dark, 32 shots in all. The devices are pinned: Android phone,
7 inch and 10 inch AVDs, and one iPhone 6.9 inch simulator (the iOS viewer is iPhone-only).

Each shot:

1. sets appearance on its already booted, pinned device through a host command;
2. acquires the device and fixes the clock and bars with `statusBar` (9:41, full battery);
3. clears the app and imports a fixed sample library from the shared valid prototype corpus
   with `prototype` `save` (no `pin` or `icon`), which routes each spec into the installed
   ProtoViewer library;
4. drives the screen with `tapOn` and `launchApp`;
5. captures with `observe` (`screenshot: "settled"`).

```bash
bun scripts/store-listing/capture-screenshots.ts --list
bun scripts/store-listing/capture-screenshots.ts --emit <dir> --android-serial <serial> --ios-udid <udid>
bun scripts/store-listing/capture-screenshots.ts --run --out <dir> --android-serial <serial> [--ios-udid <udid>] [--profile <id>] [--shot <id>]
bun scripts/store-listing/capture-screenshots.ts --verify-identical <dirA> <dirB>
```

`--emit` writes one `<shot>.plan.json` for `bun scripts/mcp-drive.ts --private --plan <file>` and a
`manifest.json` with each shot's host steps (night mode through `adb` or `simctl ui`), expected
pixel size and destination under `fastlane/metadata`. Use a dedicated capture emulator and simulator,
never a shared development device. Element labels come from the app's string resources.

Store screenshots must come from the store build; `--android-app-id` and `--ios-app-id` allow verification against a debug build.

`--run` requires the private daemon environment used by `mcp-drive --private`, a built server,
and already booted, dedicated devices with ProtoViewer installed. `prototype` `save` imports into
the `.dev` build whenever it is installed. Before any shot, `--run` lists the installed builds for
the current user. It stops when the build seeding would use is not the app the shots capture.
Uninstall the other build, or pass the matching app ID flag. It runs each shot's host
appearance commands before its MCP plan, then reads `screenshotPath` from the final `observe`
JSON envelope. It accepts only a PNG whose header dimensions match the profile, and copies it to
`<out>/<destination>` relative to `fastlane/metadata`. Temporary plan files are removed on exit.
A failed command or invalid screenshot stops the run; earlier successful captures remain.

Without `--ios-udid`, the default selection contains only Android shots. `--profile` and `--shot`
filter that selection; an explicit iOS selection requires `--ios-udid`. Each profile needs its
pinned device dimensions. Run profiles separately when changing the Android device serial.

Capture into two separate output directories, then use `--verify-identical` to check determinism.
It hashes every regular file recursively with SHA-256 and exits non-zero listing changed or missing
paths. Missing directories and non-regular files are errors. Capture outputs are generated PNGs;
keep them outside version control.
