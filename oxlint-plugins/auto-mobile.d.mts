// Types for the JS-first oxlint plugin so TypeScript tests can import it without a cast.
// Keep the rule list in sync with the `plugin.rules` map in auto-mobile.mjs.

export interface ReportedDiagnostic {
  messageId?: string;
  message?: string;
  node?: unknown;
}

export interface RuleContext {
  options: readonly unknown[];
  filename: string;
  physicalFilename: string;
  id: string;
  sourceCode: { text: string };
  report: (diagnostic: ReportedDiagnostic) => void;
}

export type AstNode = { type: string } & Record<string, unknown>;

export interface PluginRule {
  meta?: { messages?: Record<string, string> };
  create: (context: RuleContext) => Record<string, (node: AstNode) => void>;
}

export type PluginRuleName =
  | "catch-convention"
  | "no-inline-error-normalize"
  | "no-caught-error-interpolation"
  | "no-unknown-cast"
  | "no-as-any"
  | "no-accumulator-foreach"
  | "no-bare-expect"
  | "stress-explicit-timeout"
  | "no-extension-import"
  | "no-raw-promise-race"
  | "no-direct-bun-spawn"
  | "no-raw-timer"
  | "no-raw-selector-field-read"
  | "no-deprecated-selector-facade"
  | "no-structured-content-read"
  | "naming-convention"
  | "no-raw-env-number-parse"
  | "max-class-lines";

declare const plugin: {
  meta: { name: string };
  rules: Record<PluginRuleName, PluginRule>;
};

export default plugin;
