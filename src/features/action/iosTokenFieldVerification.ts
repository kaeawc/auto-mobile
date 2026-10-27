import type { FocusedTextField } from "./ClearText";

/** Outcome of comparing a recipient/token field before and after typing. */
export interface IosTokenFieldComparison {
  success: boolean;
  error?: string;
  warning?: string;
}

function tokensOf(field: FocusedTextField | undefined): readonly string[] {
  return field?.tokens ?? [];
}

/**
 * The text typed after the last token. An ordinary field read has no tokens, so its whole value
 * is the typed text; a recipient field that omits its value while empty reads as "".
 */
function trailingOf(field: FocusedTextField): string | undefined {
  return field.tokens === undefined ? (field.value ?? "") : field.trailingText;
}

export function isIosTokenField(...fields: (FocusedTextField | undefined)[]): boolean {
  return fields.some((field) => tokensOf(field).length > 0);
}

function describeTokens(field: FocusedTextField): string {
  const tokens = tokensOf(field);
  return tokens.length === 0 ? "no tokens" : `tokens ${JSON.stringify(tokens)}`;
}

/** Characters of `text`, in order, with other characters allowed between them. */
function containsInOrder(value: string, text: string): boolean {
  const characters = Array.from(text);
  let matched = 0;
  for (const character of value) {
    if (character === characters[matched]) {
      matched++;
    }
  }
  return matched === characters.length;
}

/**
 * Verify typing into a recipient/token field against its trailing text, not its full value: the
 * value carries every token label, so it does not equal the typed text. A new token means the
 * entry was committed, which is success for recipient entry.
 */
export function compareIosTokenField(
  text: string,
  before: FocusedTextField,
  after: FocusedTextField,
): IosTokenFieldComparison | undefined {
  if (!isIosTokenField(before, after)) {
    return undefined;
  }
  if (tokensOf(after).length > tokensOf(before).length) {
    return { success: true };
  }
  const beforeTrailing = trailingOf(before);
  const afterTrailing = trailingOf(after);
  if (beforeTrailing === undefined || afterTrailing === undefined) {
    return {
      success: true,
      warning:
        "iOS typed text result was not verified: the recipient field's value does not follow its tokens.",
    };
  }
  if (beforeTrailing === afterTrailing) {
    return {
      success: false,
      error: `iOS nothing was typed: no new recipient token was committed and the text after the tokens is unchanged (${describeTokens(after)}).`,
    };
  }
  return containsInOrder(afterTrailing, text)
    ? { success: true }
    : {
        success: true,
        warning: `iOS typed text changed in the recipient field; text after the tokens: ${JSON.stringify(afterTrailing)} (${describeTokens(after)}).`,
      };
}

/** What a read after an unconfirmed typeText says was committed in a recipient/token field. */
export function describeIosTokenFieldCommitted(
  text: string,
  before: FocusedTextField | undefined,
  after: FocusedTextField,
): string | undefined {
  if (!isIosTokenField(before, after)) {
    return undefined;
  }
  const beforeTokens = tokensOf(before);
  const afterTokens = tokensOf(after);
  if (afterTokens.length > beforeTokens.length) {
    return `a new recipient token was committed (${describeTokens(after)}).`;
  }
  const beforeTrailing = before === undefined ? "" : trailingOf(before);
  const afterTrailing = trailingOf(after);
  if (beforeTrailing === undefined || afterTrailing === undefined) {
    return `the recipient field's value does not follow its tokens, so the typed text is unknown (${describeTokens(after)}).`;
  }
  if (beforeTrailing === afterTrailing) {
    return `no new recipient token was committed and the text after the tokens is unchanged (${describeTokens(after)}).`;
  }
  return containsInOrder(afterTrailing, text)
    ? `the text after the recipient tokens now contains the typed characters (${describeTokens(after)}).`
    : `the text after the recipient tokens changed to ${JSON.stringify(afterTrailing)} (partial or altered input; ${describeTokens(after)}).`;
}
