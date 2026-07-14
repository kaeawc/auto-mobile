import { InputTextMode } from "./InputText";

/**
 * Decide whether an inputText call should be auto-promoted from the default
 * `a11y` mode to `eventAll` based on the presence of consumer-configured
 * markers in the text.
 *
 * `eventAll` types character-by-character via real key events, which lets apps
 * that only react to keystrokes (mention/slash/emoji autocomplete popups) open
 * and resolve their suggestions. The default `a11y` mode sets text atomically
 * and never triggers those popups.
 *
 * The feature is opt-in: with an empty `markers` list this always returns
 * `undefined`, so callers fall back to their normal default.
 *
 * @param text - The text about to be entered
 * @param markers - Consumer-supplied substrings that should force `eventAll`
 * @returns `"eventAll"` if any marker is present in `text`, else `undefined`
 */
export function resolveAutoInputMode(
  text: string,
  markers: string[]
): InputTextMode | undefined {
  if (markers.length === 0) {
    return undefined;
  }

  for (const marker of markers) {
    if (marker.length > 0 && text.includes(marker)) {
      return "eventAll";
    }
  }

  return undefined;
}
