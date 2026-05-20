/**
 * Pure parsing helpers shared by the Android and iOS
 * SystemConfigurationAdapters. Kept platform-agnostic so the same
 * normalization rules apply to ADB and `defaults read` output.
 */

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
