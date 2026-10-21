/** Pure prototype_checks_v1 evaluation; no I/O, clocks, or mutable global state.
 * Empty means null/undefined or the empty string (whitespace is only empty for required).
 * Length and the matching cap count UTF-16 units. No prior text-field cap exists in the host;
 * v1 caps regex matching to 4096 units through the contract; required/length use the full value.
 * Dates use their existing YYYY-MM-DD state representation, compared as UTC epoch milliseconds.
 * A timePicker has two numeric bindings: checks apply independently to hourKey and minuteKey.
 */
import contract from "../../../schemas/prototype-spec-contract.json";
import type { PrototypeCheck } from "./prototypeSpec";
import { matchesCheckPattern } from "./prototypeCheckPattern";

export const MAX_PROTOTYPE_CHECK_VALUE_LENGTH = contract.limits.MAX_PROTOTYPE_CHECK_VALUE_LENGTH;
/** Exact format expressions. Format whitespace is JS whitespace; pattern shorthand s is ASCII.
 * Phone: optional leading + then 7..15 ASCII digits/spaces/hyphens/parentheses, >=7 digits.
 * Unicode is allowed in email and URL components, but never in digit classes.
 */
const formats = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/u,
  phone: /^\+?[0-9 ()-]{7,15}$/u,
  digits: /^[0-9]+$/u,
  decimal: /^-?[0-9]+(\.[0-9]+)?$/u,
  url: /^https?:\/\/[^\s/?#]+([/?#]\S*)?$/u,
};
function required(value: unknown, nodeType: string): boolean {
  if (nodeType === "checkbox" || nodeType === "switch") {
    return value === true;
  }
  if (nodeType === "slider" || nodeType === "timePicker") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeof value === "string" && value.trim().length > 0;
}
function formatPasses(text: string, format: keyof typeof formats): boolean {
  const match = formats[format].exec(text);
  return match?.[0] === text && (format !== "phone" || (text.match(/[0-9]/g)?.length ?? 0) >= 7);
}
function passes(value: unknown, check: PrototypeCheck, nodeType: string): boolean {
  if ("required" in check) {
    return required(value, nodeType);
  }
  if (value === "" || value === null || value === undefined) {
    return true;
  }
  const text = typeof value === "string" ? value : "";
  if ("minLength" in check) {
    return text.length >= check.minLength;
  }
  if ("maxLength" in check) {
    return text.length <= check.maxLength;
  }
  if ("pattern" in check) {
    return matchesCheckPattern(check.pattern, text.slice(0, MAX_PROTOTYPE_CHECK_VALUE_LENGTH));
  }
  if ("format" in check) {
    return formatPasses(text.slice(0, MAX_PROTOTYPE_CHECK_VALUE_LENGTH), check.format);
  }

  return numericPasses(value, check, nodeType);
}
function numericPasses(
  value: unknown,
  check: Extract<PrototypeCheck, { min: number } | { max: number }>,
  nodeType: string,
): boolean {
  const number =
    nodeType === "datePicker" && typeof value === "string"
      ? Date.parse(`${value}T00:00:00Z`)
      : value;
  return (
    typeof number === "number" &&
    Number.isFinite(number) &&
    ("min" in check ? number >= check.min : number <= check.max)
  );
}
export function evaluateChecks(
  value: unknown,
  checks: readonly PrototypeCheck[],
  nodeType: string,
): { valid: boolean; firstFailingMessage?: string } {
  const failed = checks.find((check) => !passes(value, check, nodeType));
  return failed ? { valid: false, firstFailingMessage: failed.message } : { valid: true };
}
