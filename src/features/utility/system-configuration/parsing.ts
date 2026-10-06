/**
 * Pure parsing helpers shared by the Android and iOS
 * SystemConfigurationAdapters. Kept platform-agnostic so the same
 * normalization rules apply to ADB and `defaults read` output.
 */

import { logger } from "../../../utils/logger";

export function normalizeSettingValue(value: string | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") {
    return null;
  }
  return trimmed;
}

export function normalizeTimeFormat(value: string | null): "12" | "24" | null {
  const normalized = normalizeSettingValue(value);
  if (normalized === "12" || normalized === "24") {
    return normalized;
  }
  return null;
}

export function parseBooleanSetting(value: string | null): boolean | null {
  const normalized = normalizeSettingValue(value);
  if (normalized === null) {
    return null;
  }
  const lower = normalized.toLowerCase();
  if (lower === "1" || lower === "true") {
    return true;
  }
  if (lower === "0" || lower === "false") {
    return false;
  }
  return null;
}

export function parseLocaleList(value: string | null): string | null {
  const normalized = normalizeSettingValue(value);
  if (!normalized) {
    return null;
  }
  const primary = normalized.split(",")[0]?.trim();
  return primary || null;
}

/**
 * What `cmd locale get-app-locales` / `set-app-locales` printed, as captured on an
 * API 36 emulator (test/fixtures/android-locale/):
 *
 * - `Locales for <pkg> for user <n> are [he-IL]` for a package that is installed;
 *   `are []` when the app has no override. A list is comma-joined inside the brackets.
 * - `Unknown package <pkg> for userId <n>` for a package that is not installed for
 *   that user. The command still exits 0, so the text is the only signal.
 */
export type AppLocalesReply =
  | { kind: "list"; list: string }
  | { kind: "notInstalled" }
  | { kind: "unreadable" };

const APP_LOCALES_LIST = /\bare\s+\[([^\]]*)\]\s*$/;
const UNKNOWN_PACKAGE = /\bUnknown package\s+\S+\s+for userId\s+\d+/;

/**
 * Classify a `cmd locale get-app-locales` or `set-app-locales` reply from the
 * command's own stdout and stderr (never from a later probe). A reply that is
 * neither a locale list nor an unknown-package line is unreadable.
 */
export function parseAppLocalesReply(stdout: string, stderr: string = ""): AppLocalesReply {
  const normalized = normalizeSettingValue(stdout);
  const list = normalized?.match(APP_LOCALES_LIST)?.[1];
  if (list !== undefined) {
    return { kind: "list", list: list.trim() };
  }
  if (UNKNOWN_PACKAGE.test(stdout) || UNKNOWN_PACKAGE.test(stderr)) {
    return { kind: "notInstalled" };
  }
  return { kind: "unreadable" };
}

/**
 * Extract the calendar identifier from a BCP-47 / POSIX locale string,
 * supporting both `@calendar=…` and `-u-ca-…` extensions.
 */
export function extractCalendarFromLocale(locale: string): string | null {
  const normalizedLocale = locale.trim();
  if (!normalizedLocale) {
    return null;
  }

  const keywordMatch = normalizedLocale.match(/@calendar=([a-z0-9-]+)/i);
  if (keywordMatch && keywordMatch[1]) {
    return keywordMatch[1];
  }

  const bcp47Locale = normalizedLocale.replace(/_/g, "-");
  const extensionIndex = bcp47Locale.toLowerCase().indexOf("-u-");
  if (extensionIndex === -1) {
    return null;
  }

  const extension = bcp47Locale.slice(extensionIndex + 3);
  const segments = extension.split("-").filter(Boolean);

  let index = 0;
  while (index < segments.length) {
    const key = segments[index];
    if (key.length === 2) {
      index += 1;
      const typeSegments: string[] = [];
      while (index < segments.length && segments[index].length > 2) {
        typeSegments.push(segments[index]);
        index += 1;
      }
      if (key.toLowerCase() === "ca" && typeSegments.length > 0) {
        return typeSegments.join("-");
      }
    } else {
      index += 1;
    }
  }

  return null;
}

/** Private-use language range reserved by BCP 47 / ISO 639 (`qaa` through `qtz`). */
const PRIVATE_USE_LANGUAGE = /^q[a-t][a-z]$/;

/**
 * Check, before anything is sent to a device, that a locale tag is a
 * well-formed BCP 47 language tag. Android turns a tag it cannot make sense of
 * into `und` (or keeps only its leading subtag, e.g. `zz`) and keeps that value
 * applied, so a malformed tag would otherwise be left on the device (issue
 * #10155).
 *
 * Validation is structural only, via `Intl.Locale`. It deliberately does not ask
 * the runtime whether it has a display name for the language: the runtime's ICU
 * data lags the device's, and refusing real languages it does not know
 * (`apc-SY`, `lld-IT`, `mhn-IT`, `skr-PK` on ICU 74) would leave no way to set
 * them. Whether the device supports a well-formed language is the device's call;
 * the adapter's read-back plus restore handles a tag it does not apply.
 *
 * Accepts `fr-FR`, `sr-Latn-RS`, `zh-Hant-TW`, `en-u-ca-buddhist`, the
 * POSIX-style `en_US` spelling (`_` is read as `-`, as Android does), the legacy
 * `iw`/`in`/`ji` spellings, and regular grandfathered tags `Intl.Locale`
 * canonicalises (`art-lojban`). Rejects a malformed tag (stray punctuation,
 * over-long subtags, a comma-separated list, a private-use-only tag), the
 * irregular grandfathered tags `Intl.Locale` throws on (`i-klingon`,
 * `zh-min-nan`, `en-GB-oed`: deprecated, each has a modern replacement), `und`
 * and any `und-*` tag, and the private-use language range `qaa`-`qtz`.
 *
 * Returns an error message naming the tag and the reason when it is rejected,
 * otherwise `null`.
 */
export function validateLocaleTag(languageTag: string): string | null {
  const expected = 'e.g. "fr-FR", "sr-Latn-RS" or "zh-Hant-TW"';
  let primary: string;
  try {
    primary = new Intl.Locale(languageTag.replace(/_/g, "-")).language.toLowerCase();
  } catch (error) {
    // Intl throws RangeError for a structurally invalid tag; that is the
    // rejection signal this validator exists to report.
    logger.debug(`locale tag "${languageTag}" is not a well-formed BCP 47 tag: ${error}`);
    return `Invalid locale "${languageTag}": not a well-formed BCP 47 language tag (${expected}).`;
  }

  if (primary === "und") {
    return `Invalid locale "${languageTag}": "und" (undetermined) is not a real locale; use a language such as "fr-FR".`;
  }
  if (PRIVATE_USE_LANGUAGE.test(primary)) {
    return `Invalid locale "${languageTag}": "${primary}" is in the private-use language range (qaa-qtz), which is not a real locale (${expected}).`;
  }
  return null;
}

/** What the runtime reports for a zone id, or null when it does not know the id. */
function resolveTimeZone(zoneId: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zoneId }).resolvedOptions().timeZone;
  } catch (error) {
    // Intl throws RangeError for an id that is not a time zone; that is the
    // rejection signal the callers of this helper report.
    logger.debug(`time zone "${zoneId}" is not known to the runtime: ${error}`);
    return null;
  }
}

/**
 * The spelling the runtime knows for an id that differs only by case, or null.
 * `Intl` matches ids case-insensitively but a device looks the string up
 * exactly: `america/los_angeles` is stored as typed and resolves to GMT.
 */
function caseCorrectedTimeZone(zoneId: string, resolved: string): string | null {
  const lower = zoneId.toLowerCase();
  const known = [resolved, ...Intl.supportedValuesOf("timeZone")].find(
    (candidate) => candidate.toLowerCase() === lower,
  );
  return known === undefined || known === zoneId ? null : known;
}

/**
 * Java's custom time zone ids: `GMT[+-]h[h][:mm]` and `GMT[+-]h[h]mm`. Hours are
 * one or two digits and minutes exactly two (`GMT+5`, `GMT-08:00`, `GMT+0530`).
 */
const JAVA_CUSTOM_ZONE_ID = /^GMT([+-])(\d{1,2})(?::(\d{2})|(\d{2}))?$/;

/** Java's documented ranges for a custom id: hours 0-23, minutes 00-59. */
function isJavaCustomZoneId(zoneId: string): boolean {
  const match = JAVA_CUSTOM_ZONE_ID.exec(zoneId);
  if (!match) {
    return false;
  }
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? match[4] ?? "0");
  return hours <= 23 && minutes <= 59;
}

/**
 * The shape of an IANA name, `Area/Location[/Sub]`: two or three components, each
 * starting with a capital letter (every tzdata area and location does) and made of
 * letters, digits and `_ . + -`. It says nothing about whether the zone exists.
 */
const IANA_ZONE_SHAPE = /^[A-Z][A-Za-z0-9._+-]*(?:\/[A-Z][A-Za-z0-9._+-]*){1,2}$/;

/** Which device the id is for; only Android resolves Java custom ids. */
export type TimeZoneIdPlatform = "android" | "ios";

/** A time zone id check: the reason it is refused, or a caveat about sending it. */
export interface TimeZoneIdCheck {
  /** Set when the id is refused: names the id and why. */
  error: string | null;
  /** Set when the id is allowed but the host could not vouch for it. */
  note?: string;
}

/**
 * Check, before anything is sent to a device, that a time zone id is one a
 * device can resolve. Android and the iOS simulator both store whatever string
 * they are given (`setprop persist.sys.timezone`, `defaults write AppleTimeZone`)
 * and a string that is not a zone id is left on the device and read back
 * unchanged, so a typo would otherwise be reported as applied (issue #10190).
 *
 * The runtime's own IANA database is the authority: `Intl.DateTimeFormat`
 * throws `RangeError` for an unknown id. `Intl.supportedValuesOf("timeZone")` is
 * NOT used as an allow-list, because it lists canonical ids only and omits the
 * legacy aliases a device still resolves.
 *
 * Accepts `America/Los_Angeles`, `UTC`, `GMT`, the fixed-offset tzdata zones
 * (`Etc/GMT+5`, `Etc/GMT-14`), the tzdata rule zones (`EST5EDT`, `PST8PDT`) and
 * legacy aliases (`US/Pacific`, `Asia/Calcutta`): each is a name in the tz
 * database that Android and Foundation ship. On Android it also accepts Java's
 * custom ids (`GMT+5`, `GMT-08:00`, `GMT+0530`; hours 0-23, minutes 00-59), which
 * `TimeZone` documents as valid and which this runtime does not list. Rejects a
 * case variant (the device lookup is case-sensitive), a bare UTC offset
 * (`+05:00`, `-0800`: the runtime accepts those as offset ids but neither
 * device's database has an entry for them, so the device would fall back to GMT),
 * an id that is not shaped like an IANA name (`America/Los Angeles`, `PST8`,
 * `UTC+5`), and, on iOS, a Java custom id. A case variant of a legacy alias the
 * runtime lists nowhere (`us/pacific`) is not detectable and is left for the
 * device's read-back to judge.
 *
 * An id that is shaped like an IANA name but unknown to THIS runtime is allowed
 * with a `note`: the device's tzdata may be newer than the host's ICU, so the host
 * cannot say the device does not know it. Only the device's read-back then judges it.
 */
export function checkTimeZoneId(zoneId: string, platform?: TimeZoneIdPlatform): TimeZoneIdCheck {
  if (platform === "android" && isJavaCustomZoneId(zoneId)) {
    return { error: null };
  }
  const expected = 'e.g. "America/Los_Angeles", "Asia/Kolkata" or "UTC"';
  if (/^[+-]/.test(zoneId)) {
    return {
      error: `Invalid time zone "${zoneId}": a bare UTC offset is not a zone id and the device has no entry for it. Use an IANA id (${expected}) or a fixed-offset zone such as "Etc/GMT-5" (the sign is inverted: Etc/GMT-5 is UTC+5).`,
    };
  }
  const resolved = resolveTimeZone(zoneId);
  if (resolved === null) {
    return IANA_ZONE_SHAPE.test(zoneId)
      ? {
          error: null,
          note: `Time zone "${zoneId}" could not be validated: it is not in the host's time zone database, which may be older than the device's. It was sent as given and the device stores any string, so only its read-back vouches for it; check the spelling if the zone is not in effect.`,
        }
      : { error: `Invalid time zone "${zoneId}": not an IANA time zone id (${expected}).` };
  }
  const corrected = caseCorrectedTimeZone(zoneId, resolved);
  if (corrected !== null) {
    return {
      error: `Invalid time zone "${zoneId}": zone ids are case-sensitive on the device; did you mean "${corrected}"?`,
    };
  }
  return { error: null };
}

/**
 * The reason a time zone id is refused (see `checkTimeZoneId`), or `null` when it
 * may be sent. Without a platform, Java custom ids are not accepted.
 */
export function validateTimeZoneId(zoneId: string, platform?: TimeZoneIdPlatform): string | null {
  return checkTimeZoneId(zoneId, platform).error;
}

/**
 * Whether the zone a device reports back is the zone that was requested.
 * Compares the runtime's canonical form of each id rather than the strings, so
 * ids the runtime links as aliases of one zone are equal. A null, empty or
 * unknown report never matches, and neither does a report that is only a case
 * variant of the requested id: the device would not resolve it.
 *
 * Which legacy alias pairs the runtime links (`US/Pacific` and
 * `America/Los_Angeles`) depends on the engine, so only identical spellings are
 * guaranteed to match; a device that rewrites an id to a different alias is
 * reported as not applied.
 */
export function timeZoneIdsEquivalent(actual: string | null, requested: string): boolean {
  if (!actual) {
    return false;
  }
  if (actual === requested) {
    return true;
  }
  const reported = resolveTimeZone(actual);
  const wanted = resolveTimeZone(requested);
  return reported !== null && reported === wanted && validateTimeZoneId(actual) === null;
}

interface LocaleParts {
  language: string;
  script: string;
  region: string;
  /** Variants and extensions, lower-cased, in canonical order. */
  rest: string;
}

/**
 * Split a tag's likely-subtags-maximised canonical form into its parts. The
 * maximised form fills in the script and region the tag left out and rewrites
 * legacy languages (`iw` becomes `he`). Returns null for a tag `Intl.Locale`
 * cannot parse.
 */
function maximizedLocaleParts(tag: string): LocaleParts | null {
  let segments: string[];
  try {
    const locale = new Intl.Locale(tag.replace(/_/g, "-"));
    // `und` maximises to en-Latn-US, which would make Android's `und` (what it
    // keeps for a tag it rejects) equal to a genuine `en-US`. Leave it as is.
    segments = (locale.language === "und" ? locale : locale.maximize()).toString().split("-");
  } catch (error) {
    // Expected for an unreadable or malformed device report: it never matches.
    logger.debug(`locale tag "${tag}" is not comparable: ${error}`);
    return null;
  }
  const language = (segments.shift() ?? "").toLowerCase();
  const script =
    segments[0] !== undefined && /^[A-Za-z]{4}$/.test(segments[0]) ? segments.shift() : "";
  const region =
    segments[0] !== undefined && /^([A-Za-z]{2}|\d{3})$/.test(segments[0]) ? segments.shift() : "";
  return {
    language,
    script: (script ?? "").toLowerCase(),
    region: (region ?? "").toUpperCase(),
    rest: segments.join("-").toLowerCase(),
  };
}

/** The region a tag names itself, before any likely-subtags filling. */
function explicitRegion(tag: string): string | null {
  try {
    return new Intl.Locale(tag.replace(/_/g, "-")).region?.toUpperCase() ?? null;
  } catch (error) {
    // Unparseable: the caller already treats it as not comparable.
    logger.debug(`locale tag "${tag}" has no readable region: ${error}`);
    return null;
  }
}

/**
 * Whether the locale a device reports back is the locale that was requested.
 * Compares canonical forms rather than strings, so the legacy `iw`/`in`/`ji`
 * spellings match the `he`/`id`/`yi` Android reports (captured on an API 36
 * emulator: `iw` reads back `he`, `in-ID` reads back `id-ID`). A region or script
 * the report names beyond the request (`he-IL` for a request of `he`) is
 * tolerated, although the same captures show the device echoing `he` as `he`:
 * that tolerance is not something a device was seen to need. When the
 * request named a region the report must name the same one, so `fr-FR` matches
 * neither `fr-CA` nor a report that dropped the region (`fr`). Variants and extensions must be equal. A null, empty or
 * unparseable report never matches.
 */
export function localeTagsEquivalent(actual: string | null, requested: string): boolean {
  if (!actual) {
    return false;
  }
  const reported = maximizedLocaleParts(actual);
  const wanted = maximizedLocaleParts(requested);
  if (!reported || !wanted) {
    return false;
  }
  if (
    reported.language !== wanted.language ||
    reported.script !== wanted.script ||
    reported.rest !== wanted.rest
  ) {
    return false;
  }
  const requestedRegion = explicitRegion(requested);
  return requestedRegion === null || explicitRegion(actual) === requestedRegion;
}
