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
 * `undefined`, so callers fall back to their normal default. Promotion is
 * one-directional — this only ever returns `"eventAll"` or `undefined`.
 *
 * @param text - The text about to be entered
 * @param markers - Consumer-supplied substrings that should force `eventAll`
 * @returns `"eventAll"` if any marker is present in `text`, else `undefined`
 */
export function resolveAutoInputMode(
  text: string,
  markers: readonly string[],
): "eventAll" | undefined {
  for (const marker of markers) {
    // Guard against an empty marker: text.includes("") is always true, which
    // would promote every input. splitMarkers strips these in the CLI/env
    // path, but this keeps direct callers safe too.
    if (marker.length > 0 && text.includes(marker)) {
      return "eventAll";
    }
  }

  return undefined;
}
