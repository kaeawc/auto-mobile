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
 * spellings match the `he`/`id`/`yi` Android reports, and a region or script the
 * device fills in (`he-IL` for a request of `he`) is not a mismatch. When the
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
