import type { Rule } from "../../src/features/prototype/prototypeBindingValidation";
import type {
  ModelLanguage,
  ModelOptions,
  ModelSelection,
  TypeRefs,
} from "./generate-prototype-spec-models";

const kotlinKeywords = new Set(
  "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while".split(
    " ",
  ),
);
const swiftKeywords = new Set(
  "associatedtype class deinit enum extension fileprivate func import init inout internal let operator precedencegroup private protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return switch throw where while Any as false is nil self Self super throws true try _ Protocol Type".split(
    " ",
  ),
);

/** Escape identifiers only; wire strings always retain the contract spelling. */
export function escapeModelIdentifier(
  name: string,
  language: ModelLanguage,
  position: "declaration" | "member" | "argument" = "declaration",
): string {
  const keywords = language === "kotlin" ? kotlinKeywords : swiftKeywords;
  const needsEscape =
    language === "swift" && position === "member"
      ? ["self", "Type", "Protocol", "init"].includes(name)
      : language === "swift" && position === "argument"
        ? ["inout", "var", "let"].includes(name)
        : keywords.has(name);
  return needsEscape ? `\`${name}\`` : name;
}
export const capitalized = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
export function modelName(name: string, options: ModelOptions, language: ModelLanguage): string {
  return language === "kotlin"
    ? (options.kotlinName ?? `Prototype${capitalized(name)}`)
    : (options.swiftName ?? capitalized(name));
}
export function docLines(doc: string | undefined, language: ModelLanguage): string[] {
  if (!doc) {
    return [];
  }
  const lines = doc.split("\n");
  if (language === "swift") {
    return lines.map((line) => `/// ${line}`);
  }
  return lines.length === 1
    ? [`/** ${doc} */`]
    : ["/**", ...lines.map((line) => ` * ${line}`), " */"];
}
export interface RenderContext {
  definitions: Readonly<Record<string, Rule>>;
  selection: ModelSelection;
  refs: TypeRefs;
  language: ModelLanguage;
  output: string[];
}
export interface RenderField {
  name: string;
  type: string;
  optional: boolean;
}

function unsupported(path: string, rule: Rule): never {
  throw new Error(
    `Definition ${path}: unsupported kind ${rule.kind}${rule.kind === "ref" && rule.name ? ` ${rule.name}` : ""}`,
  );
}
function referenceType(
  rule: Rule,
  path: string,
  context: RenderContext,
  visiting: readonly string[],
): string {
  const name = rule.name;
  if (!name) {
    return unsupported(path, rule);
  }
  const selected = context.selection[name];
  if (selected?.languages?.includes(context.language) || (selected && !selected.languages)) {
    if (context.language === "swift") {
      assertNonrecursive(name, context, visiting, path);
    }
    return modelName(name, selected, context.language);
  }
  const definition = context.definitions[name];
  if (
    definition?.kind === "enum" &&
    definition.values?.every((value) => typeof value === "string")
  ) {
    return "String";
  }
  const external = context.refs[name]?.[context.language];
  return external ?? unsupported(path, rule);
}
function assertNonrecursive(
  name: string,
  context: RenderContext,
  visiting: readonly string[],
  path: string,
): void {
  if (visiting.includes(name)) {
    throw new Error(`Definition ${path}: recursive ref ${name} is unsupported for Swift`);
  }
  const walk = (rule: Rule): void => {
    const selected = rule.name ? context.selection[rule.name] : undefined;
    if (
      rule.kind === "ref" &&
      rule.name &&
      selected &&
      (!selected.languages || selected.languages.includes("swift"))
    ) {
      assertNonrecursive(rule.name, context, [...visiting, name], path);
    }
    if (rule.item) {
      walk(rule.item);
    }
    for (const field of Object.values(rule.fields ?? {})) {
      if (field) {
        walk(field.rule);
      }
    }
    for (const variant of Object.values(rule.variants ?? {})) {
      walk(variant);
    }
  };
  const definition = context.definitions[name];
  if (definition) {
    walk(definition);
  }
}
function fieldType(
  rule: Rule,
  path: string,
  nestedName: string,
  context: RenderContext,
  visiting: readonly string[],
): string {
  switch (rule.kind) {
    case "number":
      return rule.integer ? "Int" : "Double";
    case "boolean":
      return context.language === "kotlin" ? "Boolean" : "Bool";
    case "enum":
      if (rule.values?.every((value) => typeof value === "string")) {
        return "String";
      }
      break;
    case "string":
    case "key":
    case "boundKey":
    case "pointer":
      return "String";
    case "ref":
      return referenceType(rule, path, context, visiting);
    case "object": {
      renderObject(nestedName, rule, {}, context, visiting);
      return modelName(nestedName, {}, context.language);
    }
    case "record": {
      if (!rule.item) {
        break;
      }
      const item = fieldType(rule.item, path, nestedName, context, visiting);
      return context.language === "kotlin" ? `Map<String, ${item}>` : `[String: ${item}]`;
    }
    case "array": {
      if (!rule.item || rule.item.kind === "array") {
        break;
      }
      const item = fieldType(rule.item, path, nestedName, context, visiting);
      return context.language === "kotlin" ? `List<${item}>` : `[${item}]`;
    }
  }
  return unsupported(path, rule);
}
export function renderFields(
  name: string,
  rule: Rule,
  context: RenderContext,
  visiting: readonly string[],
): RenderField[] {
  const fields = Object.entries(rule.fields ?? {});
  if (!fields.length) {
    throw new Error(`Definition ${name}: empty objects are unsupported`);
  }
  return fields.map(([fieldName, field]) => {
    if (!field) {
      throw new Error(`Definition ${name}.${fieldName}: unsupported kind missing`);
    }
    return {
      name: fieldName,
      type: fieldType(
        field.rule,
        `${name}.${fieldName}`,
        `${name}${capitalized(fieldName)}`,
        context,
        visiting,
      ),
      optional: field.optional,
    };
  });
}
export function renderKotlinClass(
  name: string,
  fields: readonly RenderField[],
  suffix = "",
): string[] {
  const parameters = fields.map(
    (field) =>
      `val ${escapeModelIdentifier(field.name, "kotlin")}: ${field.type}${field.optional ? "? = null" : ""}`,
  );
  // ktfmt keeps short single-field data classes on one line.
  if (fields.length === 1 && `data class ${name}(${parameters[0]})${suffix}`.length <= 100) {
    return [`data class ${name}(${parameters[0]})${suffix}`];
  }
  return [`data class ${name}(`, ...parameters.map((field) => `  ${field},`), `)${suffix}`];
}
export function renderObject(
  name: string,
  rule: Rule,
  options: ModelOptions,
  context: RenderContext,
  visiting: readonly string[],
): void {
  const fields = renderFields(name, rule, context, visiting);
  const type = modelName(name, options, context.language);
  context.output.push("", ...docLines(options.doc, context.language));
  if (context.language === "kotlin") {
    // Existing scalar model output is deliberately stable, including one-field objects.
    context.output.push(
      "@Serializable",
      `data class ${type}(`,
      ...fields.map(
        (field) =>
          `  val ${escapeModelIdentifier(field.name, "kotlin")}: ${field.type}${field.optional ? "? = null" : ""},`,
      ),
      ")",
    );
  } else {
    const conformances = options.swiftConformances ?? ["Codable", "Equatable", "Sendable"];
    context.output.push(
      `struct ${type}${conformances.length ? `: ${conformances.join(", ")}` : ""} {`,
      ...fields.map(
        (field) =>
          `    let ${escapeModelIdentifier(field.name, "swift")}: ${field.type}${field.optional ? "?" : ""}`,
      ),
      "}",
    );
  }
}
