/**
 * Android hierarchy nodes carry no showing-hint flag. For empty-value checks,
 * typed text identical to a non-empty hint is indistinguishable from an empty field.
 * Keep the raw text when budgeting deletes or comparing a non-empty target.
 */
export function isAndroidHintText(
  className: string | undefined,
  hint: unknown,
  text: unknown,
): boolean {
  return (
    ["android.", "androidx."].some((prefix) => className?.startsWith(prefix)) &&
    typeof hint === "string" &&
    hint !== "" &&
    text === hint
  );
}
