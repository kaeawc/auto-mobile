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

function isKnownLanguageSubtag(primary: string): boolean {
  try {
    // With `fallback: "none"` an unrecognised language code yields undefined
    // instead of echoing the code back (e.g. `zz`, `qaa`).
    const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    return names.of(primary) !== undefined;
  } catch (error) {
    // A runtime without Intl.DisplayNames language data cannot answer this;
    // treat the language as acceptable rather than rejecting a real locale.
    // The read-back verification still guards the apply.
    logger.debug(`Intl.DisplayNames unavailable for language "${primary}": ${error}`);
    return true;
  }
}

/**
 * Check, before anything is sent to a device, that a locale tag is a
 * well-formed BCP 47 language tag whose primary language the runtime
 * recognises. Android turns a tag it cannot make sense of into `und` (or keeps
 * only its leading subtag, e.g. `zz`) and keeps that value applied, so a tag
 * that fails here would otherwise be left on the device (issue #10155).
 *
 * Accepts `fr-FR`, `sr-Latn-RS`, `zh-Hant-TW`, `en-u-ca-buddhist` and the
 * POSIX-style `en_US` spelling (`_` is read as `-`, as Android does). Rejects a
 * malformed tag (stray punctuation, over-long subtags, a comma-separated list,
 * a private-use-only tag), `und` and any `und-*` tag, the private-use language
 * range `qaa`-`qtz`, and a primary language the runtime does not know.
 *
 * Returns an error message when the tag is rejected, otherwise `null`.
 */
export function validateLocaleTag(languageTag: string): string | null {
  const expected = 'e.g. "fr-FR", "sr-Latn-RS" or "zh-Hant-TW"';
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(languageTag.replace(/_/g, "-"))[0] ?? "";
  } catch (error) {
    // Intl throws RangeError for a structurally invalid tag; that is the
    // rejection signal this validator exists to report.
    logger.debug(`locale tag "${languageTag}" is not a well-formed BCP 47 tag: ${error}`);
    return `Invalid locale "${languageTag}": not a well-formed BCP 47 language tag (${expected}).`;
  }

  const primary = canonical.split("-")[0].toLowerCase();
  if (primary === "und") {
    return `Invalid locale "${languageTag}": "und" (undetermined) is not a real locale; use a language such as "fr-FR".`;
  }
  if (PRIVATE_USE_LANGUAGE.test(primary) || !isKnownLanguageSubtag(primary)) {
    return `Invalid locale "${languageTag}": "${primary}" is not a recognised language (${expected}).`;
  }
  return null;
}
