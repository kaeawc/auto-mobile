/**
 * Store listing as code (#14152): the limits and rules a ProtoViewer listing must satisfy.
 *
 * The listing text lives in a fastlane-compatible tree (`fastlane/metadata/{android,ios}/<locale>/`),
 * which both `fastlane supply` / `deliver` and F-Droid read. This module is pure: it validates a
 * `ListingFiles` map (relative path to file text) so tests run on an in-memory fake with no disk.
 * The CLI that reads the real tree is `validate-store-listing.ts`.
 *
 * Limits come from the store consoles (Play Console and App Store Connect): lengths count Unicode
 * code points, which is how both consoles count a visible character.
 */

/** Relative path (forward slashes, rooted at the metadata directory) to file text. */
export type ListingFiles = ReadonlyMap<string, string>;

export type Platform = "android" | "ios";

export interface TextRule {
  /** File name inside the locale directory (or the review directory). */
  file: string;
  required: boolean;
  /** Maximum length in code points, after the single trailing newline is removed. */
  max: number;
  /** Extra shape check; every present file must also be non-empty. */
  kind?: "text" | "url" | "keywords" | "single-line";
}

export const ANDROID_RULES: readonly TextRule[] = [
  { file: "title.txt", required: true, max: 30, kind: "single-line" },
  { file: "short_description.txt", required: true, max: 80, kind: "single-line" },
  { file: "full_description.txt", required: true, max: 4000 },
  { file: "video.txt", required: false, max: 256, kind: "url" },
];

/** Play "What's new" text: 500 characters per release. */
export const ANDROID_CHANGELOG_MAX = 500;

export const IOS_RULES: readonly TextRule[] = [
  { file: "name.txt", required: true, max: 30, kind: "single-line" },
  { file: "subtitle.txt", required: true, max: 30, kind: "single-line" },
  { file: "description.txt", required: true, max: 4000 },
  { file: "keywords.txt", required: true, max: 100, kind: "keywords" },
  { file: "promotional_text.txt", required: false, max: 170 },
  { file: "release_notes.txt", required: true, max: 4000 },
  { file: "privacy_url.txt", required: true, max: 2048, kind: "url" },
  { file: "support_url.txt", required: true, max: 2048, kind: "url" },
  { file: "marketing_url.txt", required: false, max: 2048, kind: "url" },
];

/** App Review notes (`review_information/notes.txt`): 4000 characters. */
export const IOS_REVIEW_RULES: readonly TextRule[] = [
  { file: "notes.txt", required: true, max: 4000 },
];

export const REQUIRED_LOCALE = "en-US";

/** BCP-47 shapes both stores use for a locale directory: `en-US`, `pt-BR`, `zh-Hant-TW`, `es-419`. */
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-\d{3})?$/;

export interface Finding {
  path: string;
  message: string;
}

/** Code-point length, so an emoji or a supplementary-plane character counts once. */
export function lengthOf(text: string): number {
  return Array.from(text).length;
}

/** Strips the one trailing newline an editor adds; any other whitespace is judged by the rules. */
function body(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function isHttpsUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    // An unparseable string is the finding itself; there is nothing to log beyond reporting it.
    return false;
  }
}

function checkKeywords(path: string, text: string, appNames: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const keywords = text.split(",");
  if (keywords.some((keyword) => keyword.length === 0)) {
    findings.push({ path, message: "keywords must not be empty or end with a comma" });
  }
  if (keywords.some((keyword) => keyword !== keyword.trim())) {
    findings.push({
      path,
      message: "remove spaces around commas; each space spends one of the 100 characters",
    });
  }
  const seen = new Set<string>();
  keywords.forEach((keyword) => {
    const key = keyword.trim().toLowerCase();
    if (seen.has(key)) {
      findings.push({ path, message: `duplicate keyword "${keyword.trim()}"` });
    }
    seen.add(key);
    if (appNames.some((name) => name.length > 0 && key === name.toLowerCase())) {
      findings.push({
        path,
        message: `keyword "${keyword.trim()}" repeats the app name, which App Store search already indexes`,
      });
    }
  });
  return findings;
}

function checkText(
  path: string,
  raw: string,
  rule: TextRule,
  appNames: readonly string[],
): Finding[] {
  const findings: Finding[] = [];
  if (raw.includes("\r")) {
    findings.push({ path, message: "use LF line endings, not CRLF" });
  }
  const text = body(raw);
  if (text.trim().length === 0) {
    return [...findings, { path, message: "file is empty" }];
  }
  if (text !== text.trim()) {
    findings.push({
      path,
      message: "remove leading or trailing whitespace (only one final newline is allowed)",
    });
  }
  const length = lengthOf(text);
  if (length > rule.max) {
    findings.push({ path, message: `is ${length} characters; the limit is ${rule.max}` });
  }
  if (rule.kind === "single-line" && text.includes("\n")) {
    findings.push({ path, message: "must be a single line" });
  }
  if (rule.kind === "url" && !isHttpsUrl(text.trim())) {
    findings.push({ path, message: "must be an https:// URL" });
  }
  if (rule.kind === "keywords") {
    findings.push(...checkKeywords(path, text, appNames));
  }
  return findings;
}

function localesOf(files: ListingFiles, platform: Platform): string[] {
  const locales = new Set<string>();
  files.forEach((_text, path) => {
    const [root, locale] = path.split("/");
    if (root === platform && locale !== undefined && locale !== "review_information") {
      locales.add(locale);
    }
  });
  return [...locales].sort();
}

function knownNames(rules: readonly TextRule[], extra: readonly string[]): Set<string> {
  return new Set([...rules.map((rule) => rule.file), ...extra]);
}

function checkLocale(
  files: ListingFiles,
  platform: Platform,
  locale: string,
  rules: readonly TextRule[],
  appNames: readonly string[],
): Finding[] {
  const dir = `${platform}/${locale}`;
  const findings: Finding[] = [];
  if (!LOCALE_PATTERN.test(locale)) {
    findings.push({ path: dir, message: `"${locale}" is not a store locale code such as en-US` });
  }
  rules.forEach((rule) => {
    const path = `${dir}/${rule.file}`;
    const raw = files.get(path);
    if (raw === undefined) {
      if (rule.required) {
        findings.push({ path, message: "required file is missing" });
      }
      return;
    }
    findings.push(...checkText(path, raw, rule, appNames));
  });
  return findings;
}

function checkAndroidChangelogs(files: ListingFiles, locale: string): Finding[] {
  const prefix = `android/${locale}/changelogs/`;
  const findings: Finding[] = [];
  const names = [...files.keys()].filter((path) => path.startsWith(prefix));
  if (names.length === 0) {
    findings.push({
      path: prefix,
      message: "needs default.txt or <versionCode>.txt release notes",
    });
  }
  names.forEach((path) => {
    const name = path.slice(prefix.length);
    if (!/^(default|\d+)\.txt$/.test(name)) {
      findings.push({ path, message: "changelog file must be default.txt or <versionCode>.txt" });
      return;
    }
    findings.push(
      ...checkText(
        path,
        files.get(path) ?? "",
        { file: name, required: true, max: ANDROID_CHANGELOG_MAX },
        [],
      ),
    );
  });
  return findings;
}

/** Files fastlane tooling allows in a locale directory that are not text fields (generated art). */
const ANDROID_EXTRA = ["changelogs", "images"];
const IOS_EXTRA = ["images", "screenshots"];

function checkUnknownFiles(
  files: ListingFiles,
  platform: Platform,
  locale: string,
  known: Set<string>,
): Finding[] {
  const prefix = `${platform}/${locale}/`;
  const findings: Finding[] = [];
  files.forEach((_text, path) => {
    if (!path.startsWith(prefix)) {
      return;
    }
    const first = path.slice(prefix.length).split("/")[0] ?? "";
    if (!known.has(first)) {
      findings.push({ path, message: "unknown listing file; fastlane would ignore or reject it" });
    }
  });
  return findings;
}

/** Validates the whole tree; an empty array means the listing is store-ready. */
export function validateListing(files: ListingFiles): Finding[] {
  const findings: Finding[] = [];
  const androidTitle = body(files.get(`android/${REQUIRED_LOCALE}/title.txt`) ?? "");
  const iosName = body(files.get(`ios/${REQUIRED_LOCALE}/name.txt`) ?? "");
  const appNames = [androidTitle, iosName];

  (["android", "ios"] as const).forEach((platform) => {
    const locales = localesOf(files, platform);
    if (!locales.includes(REQUIRED_LOCALE)) {
      findings.push({ path: platform, message: `${REQUIRED_LOCALE} locale directory is required` });
    }
    const rules = platform === "android" ? ANDROID_RULES : IOS_RULES;
    const known = knownNames(rules, platform === "android" ? ANDROID_EXTRA : IOS_EXTRA);
    locales.forEach((locale) => {
      findings.push(
        ...checkLocale(files, platform, locale, rules, platform === "ios" ? appNames : []),
      );
      findings.push(...checkUnknownFiles(files, platform, locale, known));
      if (platform === "android") {
        findings.push(...checkAndroidChangelogs(files, locale));
      }
    });
  });

  IOS_REVIEW_RULES.forEach((rule) => {
    const path = `ios/review_information/${rule.file}`;
    const raw = files.get(path);
    if (raw === undefined) {
      findings.push({ path, message: "required file is missing" });
      return;
    }
    findings.push(...checkText(path, raw, rule, []));
  });

  const subtitle = body(files.get(`ios/${REQUIRED_LOCALE}/subtitle.txt`) ?? "");
  if (subtitle.length > 0 && subtitle.toLowerCase() === iosName.toLowerCase()) {
    findings.push({
      path: `ios/${REQUIRED_LOCALE}/subtitle.txt`,
      message: "subtitle repeats the app name; use the space to say what the app does",
    });
  }
  return findings;
}
