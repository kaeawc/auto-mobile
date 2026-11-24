import path from "node:path";
import type { Expression } from "oxc-parser";
import {
  GuardVisitor,
  guardTextMayMatch,
  parseGuardSource,
  readGuardFile,
  relativePosix,
  typeScriptFiles,
} from "./astGuard";

/**
 * A hand-written "this tool only runs on Android" refusal (#18721): `<subject> is Android-only`,
 * `<subject> is only supported on Android` or `<subject> supports Android ... only`. The subject is
 * the first word; a `${}` hole reads as "…".
 */
const ANDROID_ONLY_REFUSAL =
  /^`?([\w…]+)`? (?:is Android-only|is only supported on Android(?! (?:or|and) )|supports Android\b[^.;]*\bonly)/;
const MAY_MATCH = /Android-only|only supported on Android|supports Android/;

export interface AndroidOnlyRefusal {
  file: string;
  line: number;
  /** The refused subject: a tool name, an argument name, or "…" for a template hole. */
  subject: string;
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
      return `${staticText(node.left) ?? "…"}${staticText(node.right) ?? "…"}`;
    }
    default:
      return undefined;
  }
}

/** Every Android-only refusal text in one file; a `+` chain is judged as one message. */
export function scanAndroidOnlyRefusals(file: string, source: string): AndroidOnlyRefusal[] {
  const program = parseGuardSource(file, source, guardTextMayMatch(source, MAY_MATCH));
  if (!program) {
    return [];
  }
  const found: AndroidOnlyRefusal[] = [];
  const reported: { start: number; end: number }[] = [];
  const check = (node: Expression): void => {
    if (reported.some(({ start, end }) => node.start >= start && node.end <= end)) {
      return;
    }
    const text = staticText(node);
    const match = text === undefined ? null : ANDROID_ONLY_REFUSAL.exec(text);
    if (text !== undefined && match) {
      reported.push({ start: node.start, end: node.end });
      found.push({ file, line: lineAt(source, node.start), subject: match[1], text });
    }
  };
  new GuardVisitor({ Literal: check, TemplateLiteral: check, BinaryExpression: check }).visit(
    program,
  );
  return found;
}

const root = path.join(import.meta.dir, "..", "..");

/** Every Android-only refusal text in `src/`. */
export function srcAndroidOnlyRefusals(): AndroidOnlyRefusal[] {
  return typeScriptFiles(path.join(root, "src")).flatMap((absolute) =>
    scanAndroidOnlyRefusals(relativePosix(root, absolute), readGuardFile(absolute)),
  );
}
