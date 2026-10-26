import { describe, expect, test } from "bun:test";
import {
  readListingTree,
  formatFindings,
} from "../../scripts/store-listing/validate-store-listing";
import { validateIconSvg } from "../../scripts/store-listing/iconSourceCheck";
import {
  lengthOf,
  validateListing,
  type ListingFiles,
} from "../../scripts/store-listing/storeListing";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

function validTree(overrides: Record<string, string | null> = {}): ListingFiles {
  const files = new Map<string, string>([
    ["android/en-US/title.txt", "ProtoViewer\n"],
    ["android/en-US/short_description.txt", "Open and share design prototypes.\n"],
    ["android/en-US/full_description.txt", "A viewer for prototypes.\n"],
    ["android/en-US/changelogs/default.txt", "First release.\n"],
    ["android/en-US/images/phoneScreenshots/01_library_light.png", ""],
    ["ios/en-US/name.txt", "ProtoViewer\n"],
    ["ios/en-US/subtitle.txt", "Design prototypes, offline\n"],
    ["ios/en-US/description.txt", "A viewer for prototypes.\n"],
    ["ios/en-US/keywords.txt", "prototype,viewer,design\n"],
    ["ios/en-US/release_notes.txt", "First release.\n"],
    ["ios/en-US/privacy_url.txt", "https://example.com/privacy\n"],
    ["ios/en-US/support_url.txt", "https://example.com/support\n"],
    ["ios/review_information/notes.txt", "Open a sample from Files.\n"],
  ]);
  Object.entries(overrides).forEach(([path, text]) => {
    if (text === null) {
      files.delete(path);
    } else {
      files.set(path, text);
    }
  });
  return files;
}

const messages = (files: ListingFiles) =>
  validateListing(files).map((finding) => `${finding.path}: ${finding.message}`);

describe("store listing validation", () => {
  test("a complete listing has no findings", () => {
    expect(validateListing(validTree())).toEqual([]);
  });

  test("lengths count code points, at the limit and one over", () => {
    expect(lengthOf("a😀b")).toBe(3);
    expect(
      validateListing(validTree({ "android/en-US/title.txt": `${"a".repeat(30)}\n` })),
    ).toEqual([]);
    expect(messages(validTree({ "android/en-US/title.txt": `${"a".repeat(31)}\n` }))).toEqual([
      "android/en-US/title.txt: is 31 characters; the limit is 30",
    ]);
    expect(
      messages(validTree({ "android/en-US/short_description.txt": `${"a".repeat(81)}\n` })),
    ).toEqual(["android/en-US/short_description.txt: is 81 characters; the limit is 80"]);
    expect(
      messages(validTree({ "android/en-US/full_description.txt": `${"a".repeat(4001)}\n` })),
    ).toEqual(["android/en-US/full_description.txt: is 4001 characters; the limit is 4000"]);
    expect(messages(validTree({ "ios/en-US/subtitle.txt": `${"a".repeat(31)}\n` }))).toEqual([
      "ios/en-US/subtitle.txt: is 31 characters; the limit is 30",
    ]);
    expect(
      messages(validTree({ "android/en-US/changelogs/default.txt": `${"a".repeat(501)}\n` })),
    ).toEqual(["android/en-US/changelogs/default.txt: is 501 characters; the limit is 500"]);
    expect(
      messages(validTree({ "ios/en-US/promotional_text.txt": `${"a".repeat(171)}\n` })),
    ).toEqual(["ios/en-US/promotional_text.txt: is 171 characters; the limit is 170"]);
  });

  test("missing required files are reported once each, optional ones are not", () => {
    expect(
      messages(validTree({ "ios/en-US/keywords.txt": null, "android/en-US/title.txt": null })),
    ).toEqual([
      "android/en-US/title.txt: required file is missing",
      "ios/en-US/keywords.txt: required file is missing",
    ]);
  });

  test("a missing en-US locale and a missing review note are findings", () => {
    const files = new Map([...validTree()].filter(([path]) => !path.startsWith("ios/")));
    expect(messages(files)).toEqual([
      "ios: en-US locale directory is required",
      "ios/review_information/notes.txt: required file is missing",
    ]);
  });

  test("empty, padded and CRLF files fail", () => {
    expect(messages(validTree({ "android/en-US/title.txt": "\n" }))).toEqual([
      "android/en-US/title.txt: file is empty",
    ]);
    expect(messages(validTree({ "android/en-US/title.txt": " ProtoViewer\n" }))).toEqual([
      "android/en-US/title.txt: remove leading or trailing whitespace (only one final newline is allowed)",
    ]);
    expect(messages(validTree({ "ios/en-US/description.txt": "a\r\nb\r\n" }))).toContain(
      "ios/en-US/description.txt: use LF line endings, not CRLF",
    );
    expect(messages(validTree({ "android/en-US/title.txt": "Proto\nViewer\n" }))).toEqual([
      "android/en-US/title.txt: must be a single line",
    ]);
  });

  test("urls must be https", () => {
    expect(messages(validTree({ "ios/en-US/privacy_url.txt": "http://example.com/p\n" }))).toEqual([
      "ios/en-US/privacy_url.txt: must be an https:// URL",
    ]);
    expect(messages(validTree({ "ios/en-US/support_url.txt": "support\n" }))).toEqual([
      "ios/en-US/support_url.txt: must be an https:// URL",
    ]);
  });

  test("keywords: spaces, duplicates, the app name and trailing commas", () => {
    expect(messages(validTree({ "ios/en-US/keywords.txt": "design, prototype\n" }))).toEqual([
      "ios/en-US/keywords.txt: remove spaces around commas; each space spends one of the 100 characters",
    ]);
    expect(messages(validTree({ "ios/en-US/keywords.txt": "design,Design\n" }))).toEqual([
      'ios/en-US/keywords.txt: duplicate keyword "Design"',
    ]);
    expect(messages(validTree({ "ios/en-US/keywords.txt": "design,protoviewer\n" }))).toEqual([
      'ios/en-US/keywords.txt: keyword "protoviewer" repeats the app name, which App Store search already indexes',
    ]);
    expect(messages(validTree({ "ios/en-US/keywords.txt": "design,\n" }))).toEqual([
      "ios/en-US/keywords.txt: keywords must not be empty or end with a comma",
    ]);
    expect(messages(validTree({ "ios/en-US/keywords.txt": `${"k".repeat(101)}\n` }))).toEqual([
      "ios/en-US/keywords.txt: is 101 characters; the limit is 100",
    ]);
  });

  test("a subtitle that repeats the name is rejected", () => {
    expect(messages(validTree({ "ios/en-US/subtitle.txt": "protoviewer\n" }))).toEqual([
      "ios/en-US/subtitle.txt: subtitle repeats the app name; use the space to say what the app does",
    ]);
  });

  test("changelogs need a default or version-code file and a sane name", () => {
    expect(messages(validTree({ "android/en-US/changelogs/default.txt": null }))).toEqual([
      "android/en-US/changelogs/: needs default.txt or <versionCode>.txt release notes",
    ]);
    expect(messages(validTree({ "android/en-US/changelogs/v1.txt": "x\n" }))).toEqual([
      "android/en-US/changelogs/v1.txt: changelog file must be default.txt or <versionCode>.txt",
    ]);
    expect(validateListing(validTree({ "android/en-US/changelogs/42.txt": "x\n" }))).toEqual([]);
  });

  test("a second locale is validated on its own and unknown files are flagged", () => {
    const files = validTree({
      "android/de-DE/title.txt": `${"a".repeat(31)}\n`,
      "android/en-US/titel.txt": "x\n",
      "android/english/title.txt": "x\n",
    });
    const found = messages(files);
    expect(found).toContain("android/de-DE/title.txt: is 31 characters; the limit is 30");
    expect(found).toContain("android/de-DE/short_description.txt: required file is missing");
    expect(found).toContain(
      "android/en-US/titel.txt: unknown listing file; fastlane would ignore or reject it",
    );
    expect(found).toContain('android/english: "english" is not a store locale code such as en-US');
  });

  test("findings render with the metadata directory prefix", () => {
    expect(formatFindings([{ path: "a/b.txt", message: "bad" }])).toBe(
      "fastlane/metadata/a/b.txt: bad",
    );
  });
});

describe("the committed ProtoViewer listing", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

  test("satisfies every store limit", () => {
    const files = readListingTree(join(repoRoot, "fastlane/metadata"));
    expect(files.size).toBeGreaterThan(0);
    expect(validateListing(files)).toEqual([]);
  });
});

describe("icon source layers", () => {
  const svg = (viewBox: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><rect width="1" height="1"/></svg>`;

  test("accepts the shared 108 canvas, tolerating comma and spacing variants", async () => {
    expect(await validateIconSvg("fg.svg", svg("0 0 108 108"))).toEqual([]);
    expect(await validateIconSvg("fg.svg", svg("0,0, 108 108"))).toEqual([]);
  });

  test("rejects a wrong canvas, a non-svg root, bad XML and a missing file", async () => {
    expect(await validateIconSvg("fg.svg", svg("0 0 24 24"))).toEqual([
      { path: "fg.svg", message: 'viewBox must be "0 0 108 108" (found 0 0 24 24)' },
    ]);
    expect(await validateIconSvg("fg.svg", "<html/>")).toEqual([
      { path: "fg.svg", message: "root element must be <svg>" },
    ]);
    expect((await validateIconSvg("fg.svg", "<svg"))[0]?.message).toContain(
      "is not well-formed XML",
    );
    expect(await validateIconSvg("fg.svg", undefined)).toEqual([
      { path: "fg.svg", message: "icon source layer is missing" },
    ]);
  });
});
