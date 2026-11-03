import { ActionableError, toActionableError } from "../../../models/ActionableError";

/** The locale a still renders in when the caller names none. */
export const DEFAULT_STILL_LOCALE = "en-US";

/** Languages written right to left, as both platforms lay them out. */
const RTL_LANGUAGES = new Set([
  "ar",
  "ckb",
  "dv",
  "fa",
  "he",
  "iw",
  "ks",
  "ps",
  "sd",
  "ug",
  "ur",
  "yi",
]);

/** Scripts written right to left; an explicit script subtag decides over the language. */
const RTL_SCRIPTS = new Set(["adlm", "arab", "hebr", "nkoo", "rohg", "syrc", "thaa"]);

/** The canonical BCP 47 tag, or an ActionableError naming the invalid one. */
export function stillLocale(locale: string | undefined): string {
  if (locale === undefined) {
    return DEFAULT_STILL_LOCALE;
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(locale);
    if (canonical) {
      return canonical;
    }
  } catch (error) {
    throw toActionableError(error, `locale "${locale}" is not a valid BCP 47 tag`);
  }
  throw new ActionableError(`locale "${locale}" is not a valid BCP 47 tag.`);
}

/**
 * The layout direction the host locale gives, as a device in that locale lays out a window that
 * sets no `layoutDirection`. Android's `ar-XB` pseudolocale is Arabic, so it is RTL too.
 */
export function localeLayoutDirection(locale: string): "ltr" | "rtl" {
  const subtags = locale.toLowerCase().split("-");
  const script = subtags.slice(1).find((tag) => tag.length === 4);
  if (script !== undefined) {
    return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
  }
  return RTL_LANGUAGES.has(subtags[0] ?? "") ? "rtl" : "ltr";
}
