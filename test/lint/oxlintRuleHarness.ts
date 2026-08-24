import { parseSync } from "oxc-parser";

// Drive one oxlint JS-plugin rule against a code snippet, in-process.
//
// oxlint ships its own `RuleTester` (oxlint/plugins-dev), but it relies on
// Node >=22's "raw transfer" native AST bridge and throws under bun ("not
// supported ... on other runtimes"). Since this repo's test runner IS bun, we
// reproduce the minimal slice of ESLint/oxlint's rule-execution model that these
// backstops need: parse the snippet to ESTree with oxc-parser (the same AST the
// oxlint runtime feeds rules), walk it, invoke each node-type visitor handler,
// and collect the resolved diagnostic message strings.
//
// The custom rules use only plain node-type visitors (no esquery selectors and no
// `:exit` handlers), so a single enter-order walk is faithful. `context.options`
// is empty and `report` resolves `messageId` through `rule.meta.messages`, which
// is exactly how the tests assert (on message text).

interface ReportedDiagnostic {
  messageId?: string;
  message?: string;
  node?: unknown;
}

interface PluginRule {
  meta?: { messages?: Record<string, string> };
  create: (context: RuleContext) => Record<string, (node: AstNode) => void>;
}

interface RuleContext {
  options: readonly unknown[];
  filename: string;
  physicalFilename: string;
  id: string;
  report: (diagnostic: ReportedDiagnostic) => void;
}

type AstNode = { type: string } & Record<string, unknown>;

export function runRule(rule: PluginRule, code: string, filename = "fixture.ts"): string[] {
  const { program } = parseSync(filename, code);
  const messages: string[] = [];

  const context: RuleContext = {
    options: [],
    filename,
    physicalFilename: filename,
    id: "auto-mobile/test",
    report(diagnostic) {
      const text = diagnostic.messageId
        ? (rule.meta?.messages?.[diagnostic.messageId] ?? diagnostic.messageId)
        : (diagnostic.message ?? "");
      messages.push(text);
    },
  };

  const visitor = rule.create(context);
  const seen = new WeakSet<object>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) {
      return;
    }
    seen.add(node);
    const typed = node as Partial<AstNode>;
    if (typeof typed.type === "string") {
      const handler = visitor[typed.type];
      if (typeof handler === "function") {
        handler(typed as AstNode);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") {
        continue;
      }
      const value = (node as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          walk(child);
        }
      } else if (value && typeof value === "object") {
        walk(value);
      }
    }
  };

  walk(program);
  return messages;
}
