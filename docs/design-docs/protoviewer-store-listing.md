# ProtoViewer store listing as code

Issue #14152 under #14142. The Play and App Store listing text, the app icon and the screenshot
plan live in the repository, so a listing change is reviewable and diffable and a stale or
over-length listing fails Fast Validation instead of failing at upload.

Status: metadata, validator, icon generation and the screenshot capture plan have landed. Wiring the
generated icons into the Android and iOS app resources, the Play feature graphic, and running the
capture (two identical consecutive runs) are not done; see [Remaining](#remaining).

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
also reads, so a future upload lane needs no conversion. `en-US` is required; any other locale
directory is validated by the same rules. Neither store has a repository-hosted source of truth
today: the stores keep whatever was last uploaded, and this tree is what gets uploaded.

The text is provisional until the owner decisions in #14143 (policy positioning, review notes) and
#14144 (store name and URLs) land. The privacy URL points at a page that does not exist yet.

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

It also rejects missing required files, empty or whitespace-padded files, CRLF line endings,
multi-line titles, keywords with spaces around commas, duplicate keywords, a keyword that repeats the
app name, a subtitle equal to the name, unknown files in a locale directory, and a locale directory
that is not a store locale code. The two icon layers must be well-formed SVG on the shared
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

Two runs over the same sources write byte-identical files. The PNGs are build output and are
git-ignored: this repository routes `*.png` through Git LFS, and generated art does not belong in
history. Distinct dev and beta icons (as in #14152's proposal) are a second layer pair plus a channel
column in the table; they are not drawn yet.

## Screenshot plan

`scripts/store-listing/screenshotPlan.ts` is the plan as data: four screens (library, viewer, import,
share), light and dark, on pinned devices (Android phone, 7 inch and 10 inch AVDs; one iPhone
6.9 inch simulator; the iOS viewer is iPhone-only), 32 shots in all. Each shot acquires its pinned
device, sets appearance, fixes the clock and bars with the `statusBar` tool (9:41, full battery),
clears the app, seeds a fixed sample library from the shared valid prototype corpus, drives the
screen with `tapOn` and `launchApp`, and captures with `observe` (`screenshot: "settled"`).

```bash
bun scripts/store-listing/capture-screenshots.ts --list
bun scripts/store-listing/capture-screenshots.ts --emit <dir> --android-serial <serial> --ios-udid <udid>
```

`--emit` writes one `<shot>.plan.json` for `bun scripts/mcp-drive.ts --private --plan <file>` and a
`manifest.json` with each shot's host steps (night mode through `adb` or `simctl ui`), expected
pixel size and destination under `fastlane/metadata`. Use a dedicated capture emulator and simulator,
never a shared development device. Nothing in the plan has been run; element labels come from the
app's string resources and are confirmed on the first run.

## Remaining

- Wire the generated rasters into `android/protoviewer` (adaptive icon XML, lint-clean with no
  `IconLauncherShape` baseline entry) and an iOS asset catalog, and confirm `lintRelease` and the
  archive show no missing-icon warnings.
- A driver that runs the manifest end to end, copies each captured image to its destination and
  verifies the pixel size, then a check that two consecutive runs produce identical images.
- The Play feature graphic (1024 x 500) rendered from a prototype spec, and an App Store preview.
- Dev and beta channel icons.
