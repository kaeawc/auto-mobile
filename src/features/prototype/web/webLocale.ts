import { PrototypeWebInputError } from "./prototypeWebInputError";

/** The locale a still renders in when the caller names none. */
export const DEFAULT_STILL_LOCALE = "en-US";

/** Scripts written right to left, as both platforms lay them out. */
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
  // An explicit script decides; otherwise CLDR's likely subtags give the script the tag implies,
  // as Foundation does (`pa-PK` is Arabic, `pa-IN` Gurmukhi) (#16590).
  const script = new Intl.Locale(locale).maximize().script;
  return script !== undefined && RTL_SCRIPTS.has(script.toLowerCase()) ? "rtl" : "ltr";
}
