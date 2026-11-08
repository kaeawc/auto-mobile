import path from "node:path";
import {
  GuardVisitor,
  guardTextMayMatch,
  parseGuardSource,
  readGuardFile,
  relativePosix,
  typeScriptFiles,
  unwrapCallee,
} from "./astGuard";
import type { Expression } from "oxc-parser";

/** The one module allowed to spell out a flag-disabled refusal (#16906). */
export const FEATURE_FLAG_DISABLED_MESSAGE_MODULE =
  "src/features/featureFlags/featureFlagDisabledMessage.ts";

const HELPER = "featureFlagDisabledMessage";
const MENTIONS_FLAG = /feature[- ]flag/i;
const SAYS_DISABLED = /\b(?:is disabled|turned off|re-?enable|enable it)\b/i;

export interface FlagMessageFinding {
  file: string;
  line: number;
  text: string;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/** Static text of a string, template or `+` chain of them; `${}` holes read as "…". */
function staticText(node: Expression): string | undefined {
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? node.value : undefined;
    case "TemplateLiteral":
      return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("…");
    case "BinaryExpression": {
      if (node.operator !== "+") {
        return undefined;
      }
      const left = staticText(node.left) ?? "…";
      const right = staticText(node.right) ?? "…";
      return `${left}${right}`;
    }
    default:
      return undefined;
  }
}

/**
 * String text in one file that hand-writes a flag-disabled refusal. A `+` chain or template is
 * judged as one message, so splitting the sentence across fragments does not hide it.
 */
export function scanBespokeFlagMessages(file: string, source: string): FlagMessageFinding[] {
  const program = parseGuardSource(file, source, guardTextMayMatch(source, MENTIONS_FLAG));
  if (!program) {
    return [];
  }
  const found: FlagMessageFinding[] = [];
  const reported: { start: number; end: number }[] = [];
  const check = (node: Expression): void => {
    if (reported.some(({ start, end }) => node.start >= start && node.end <= end)) {
      return;
    }
    const text = staticText(node);
    if (text && MENTIONS_FLAG.test(text) && SAYS_DISABLED.test(text)) {
      reported.push({ start: node.start, end: node.end });
      found.push({ file, line: lineAt(source, node.start), text });
    }
  };
  new GuardVisitor({ Literal: check, TemplateLiteral: check, BinaryExpression: check }).visit(
    program,
  );
  return found;
}

/** The literal flag keys passed to `featureFlagDisabledMessage` in one file. */
export function scanHelperKeys(file: string, source: string): string[] {
  const program = parseGuardSource(file, source, guardTextMayMatch(source, HELPER));
  if (!program) {
    return [];
  }
  const keys: string[] = [];
  new GuardVisitor({
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      if (callee.type !== "Identifier" || callee.name !== HELPER) {
        return;
      }
      const key = node.arguments[0];
      if (key?.type !== "Literal" || typeof key.value !== "string") {
        throw new Error(
          `${file}:${lineAt(source, node.start)}: ${HELPER} needs a string-literal flag key so its gate can be enumerated`,
        );
      }
      keys.push(key.value);
    },
  }).visit(program);
  return keys;
}

const root = path.join(import.meta.dir, "..", "..");

function srcFiles(): { file: string; source: string }[] {
  return typeScriptFiles(path.join(root, "src")).map((absolute) => ({
    file: relativePosix(root, absolute),
    source: readGuardFile(absolute),
  }));
}

/** Every flag key a `src/` refusal passes to the shared helper. */
export function featureFlagDisabledMessageKeys(): Set<string> {
  return new Set(srcFiles().flatMap(({ file, source }) => scanHelperKeys(file, source)));
}

/** Every hand-written flag-disabled message in `src/` outside the helper module. */
export function bespokeFlagDisabledMessages(): FlagMessageFinding[] {
  return srcFiles()
    .filter(({ file }) => file !== FEATURE_FLAG_DISABLED_MESSAGE_MODULE)
    .flatMap(({ file, source }) => scanBespokeFlagMessages(file, source));
}
