import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildReleaseNotes,
  RELEASE_NOTES_BUDGET,
  releaseNotesFileContent,
} from "../../scripts/release/build-release-notes";

const checksums = {
  apk: "a".repeat(64),
  ipa: "b".repeat(64),
  videoJar: "c".repeat(64),
  screenCaptureHelper: "d".repeat(64),
  prototypeAgent: "e".repeat(64),
  networkFilter: "f".repeat(64),
};
const input = { version: "0.0.82", tag: "0.0.82", repository: "kaeawc/auto-mobile", checksums };
// Literal legacy template, independent of the builder's assembly.
const tail = `

## CtrlProxy APK

**SHA256 Checksum:** \`${checksums.apk}\`

Download the APK from the release assets below.

## CtrlProxy iOS IPA

**SHA256 Checksum:** \`${checksums.ipa}\`

Download the IPA from the release assets below.

## video-server jar

**SHA256 Checksum:** \`${checksums.videoJar}\`

Download automobile-video.jar from the release assets below.

## macOS screen-capture-helper

**SHA256 Checksum:** \`${checksums.screenCaptureHelper}\`

Download screen-capture-helper-macos-universal.zip from the release assets below.

## iOS simulator prototype agent

**SHA256 Checksum:** \`${checksums.prototypeAgent}\`

Download AutoMobilePrototypeAgent.dylib (universal arm64 + x86_64, ad-hoc signed) from the release assets below.

## macOS network-filter

**SHA256 Checksum:** \`${checksums.networkFilter}\`

Download automobile-network-filter-macos-universal.zip from the release assets below.

## Desktop App

Native installers are attached below: macOS \`.dmg\` (signed & notarized), Windows \`.msi\`, and Linux \`.deb\`.`;
const fixture = readFileSync(
  new URL("../fixtures/release/CHANGELOG-0.0.82.md", import.meta.url),
  "utf8",
);
const notice =
  "… (truncated; see the full changelog: https://github.com/kaeawc/auto-mobile/blob/0.0.82/CHANGELOG.md#v0082---2026-10-03)";

describe("buildReleaseNotes", () => {
  test("matches legacy bytes, removes only empty lines, and appends the file newline", () => {
    const changelog =
      "# Changelog\n\n## [0.0.82] - 2026-10-03\n\n### Added\n\n- First item\n \n- Second item\n\n## [0.0.81]\n- Old item\n";
    const expected = "### Added\n- First item\n \n- Second item" + tail;
    const body = buildReleaseNotes({ ...input, changelog });
    expect(body).toBe(expected);
    expect(releaseNotesFileContent(body)).toBe(expected + "\n");
  });

  test.each(["0.0.82", "v0.0.82"])("matches heading version %s literally", (headingVersion) => {
    const body = buildReleaseNotes({
      ...input,
      changelog: `## [${headingVersion}] - 2026-10-03\n- New item\n## [0.0.81]\n- Old item`,
    });
    expect(body).toBe("- New item" + tail);
  });

  test("does not treat version dots as regex wildcards or match a longer version", () => {
    const body = buildReleaseNotes({
      ...input,
      version: "0.0.8",
      changelog: "## [0.0.82]\n- Wrong suffix\n## [0x0x8]\n- Wrong dots",
    });
    expect(body).toBe("Release v0.0.8" + tail);
  });

  test.each([null, "## [0.0.81]\n- Old", "## [v0.0.82]\n\n## [0.0.81]\n- Old"])(
    "falls back for an absent or empty section (%s)",
    (changelog) => {
      expect(buildReleaseNotes({ ...input, changelog })).toBe("Release v0.0.82" + tail);
    },
  );

  test("budgets the captured 0.0.82 changelog with the full tail and exact line prefix", () => {
    const section = fixture
      .split("## [v0.0.82] - 2026-10-03\n")[1]
      .split("\n## [")[0]
      .split("\n")
      .filter((line) => line !== "");
    const body = buildReleaseNotes({ ...input, changelog: fixture });
    expect(body.length).toBeLessThanOrEqual(125_000);
    expect(body.length).toBeLessThanOrEqual(RELEASE_NOTES_BUDGET);
    expect(body.endsWith(tail)).toBe(true);
    expect(body).toContain(
      notice + "\nCompare: https://github.com/kaeawc/auto-mobile/compare/0.0.81...0.0.82",
    );
    const kept = body.split("\n\n" + notice)[0].split("\n");
    expect(kept[0]).toBe("### Added");
    expect(kept).toEqual(section.slice(0, kept.length));
    expect(kept.length).toBeLessThan(section.length);
    expect(body.length + 1 + section[kept.length].length).toBeGreaterThan(RELEASE_NOTES_BUDGET);
  });

  test("counts emoji in UTF-16 units and retains only complete lines", () => {
    const line = "- café " + "😀".repeat(500);
    const lines = Array.from({ length: 180 }, () => line);
    const changelog = "## [v0.0.82] - 2026-10-03\n" + lines.join("\n");
    // Code point count would fit, but UTF-16 length must force truncation.
    expect(Array.from(lines.join("\n") + tail).length).toBeLessThan(RELEASE_NOTES_BUDGET);
    expect((lines.join("\n") + tail).length).toBeGreaterThan(RELEASE_NOTES_BUDGET);
    const body = buildReleaseNotes({ ...input, changelog });
    expect(body.length).toBeLessThanOrEqual(RELEASE_NOTES_BUDGET);
    expect(body.endsWith(notice + tail)).toBe(true);
    const kept = body.split("\n\n" + notice)[0].split("\n");
    expect(kept).toEqual(lines.slice(0, kept.length));
    expect(kept.length).toBeGreaterThan(0);
    expect(body).not.toContain("Compare:");
  });

  test("omits Compare when there is no previous heading and an entire line cannot fit", () => {
    const body = buildReleaseNotes({
      ...input,
      changelog: "## [v0.0.82] - 2026-10-03\n" + "x".repeat(RELEASE_NOTES_BUDGET + 1),
    });
    expect(body).toBe(notice + tail);
    expect(body.length).toBeLessThanOrEqual(RELEASE_NOTES_BUDGET);
  });

  test("keeps a body that is exactly at the budget without a notice", () => {
    const changelogPart = "x".repeat(RELEASE_NOTES_BUDGET - tail.length);
    expect(buildReleaseNotes({ ...input, changelog: "## [0.0.82]\n" + changelogPart })).toBe(
      changelogPart + tail,
    );
  });
});
