import { PrototypeWebInputError } from "./prototypeWebInputError";

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

/** The canonical BCP 47 tag, or a PrototypeWebInputError naming the invalid one. */
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
    // Intl throws a RangeError or TypeError; anything else is not an input problem, so it
    // propagates as is. errorMessage would pull the server's error helpers into the bundle.
    if (!(error instanceof Error)) {
      throw error;
    }
    throw new PrototypeWebInputError(
      `locale "${locale}" is not a valid BCP 47 tag: ${error.message}`,
      { cause: error },
    );
  }
  throw new PrototypeWebInputError(`locale "${locale}" is not a valid BCP 47 tag.`);
}

/**
 * The layout direction the host locale gives, as a device in that locale lays out a window that
 * sets no `layoutDirection`. Android's `ar-XB` pseudolocale is Arabic, so it is RTL too.
 */
export function localeLayoutDirection(locale: string): "ltr" | "rtl" {
  // Intl.Locale parses the tag, so a Unicode extension (`-u-nu-latn`) is never read as a script.
  const parsed = new Intl.Locale(locale);
  if (parsed.script !== undefined) {
    return RTL_SCRIPTS.has(parsed.script.toLowerCase()) ? "rtl" : "ltr";
  }
  return RTL_LANGUAGES.has(parsed.language.toLowerCase()) ? "rtl" : "ltr";
}
