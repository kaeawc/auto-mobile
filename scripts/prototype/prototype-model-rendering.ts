import {
  kotlinBody,
  kotlinProperty,
  swiftProperties,
  swiftObjectDecoder,
} from "./prototype-model-members";
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
  kotlinImports: Set<string>;
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
  doc?: string;
  defaultValue?: string;
  validator?: string;
  override?: boolean;
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
  if (external === "JsonObject") {
    context.kotlinImports.add("kotlinx.serialization.json.JsonObject");
  }
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
    case "json":
      if (context.language === "kotlin") {
        context.kotlinImports.add("kotlinx.serialization.json.JsonElement");
      }
      return context.language === "kotlin" ? "JsonElement" : "JSONValue";
    case "scalar":
      return context.language === "kotlin" ? "PrototypeScalar" : "JSONValue";
    case "record": {
      if (!rule.item) {
        break;
      }
      const item = fieldType(rule.item, path, nestedName, context, visiting);
      return context.language === "kotlin" ? `Map<String, ${item}>` : `[String: ${item}]`;
    }
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
  options: ModelOptions = {},
  variant?: string,
): RenderField[] {
  const fields = Object.entries(rule.fields ?? {}).filter(
    ([fieldName]) =>
      !(context.language === "kotlin" && options.omitKotlinFields?.includes(fieldName)),
  );
  if (!fields.length) {
    throw new Error(`Definition ${name}: empty objects are unsupported`);
  }
  return fields.map(([fieldName, field]) => {
    if (!field) {
      throw new Error(`Definition ${name}.${fieldName}: unsupported kind missing`);
    }
    const key = variant ? `${variant}.${fieldName}` : fieldName;
    const languageOption = (values: TypeRefs | undefined) =>
      values?.[key]?.[context.language] ?? values?.[fieldName]?.[context.language];
    const defaultValue = languageOption(options.fieldDefaults);
    if (context.language === "swift" && defaultValue !== undefined) {
      throw new Error(`Definition ${name}.${fieldName}: Swift field defaults are unsupported`);
    }
    if (defaultValue !== undefined && (!field.optional || defaultValue.trim() === "null")) {
      throw new Error(
        `Definition ${name}.${fieldName}: defaults require an optional field and a non-null value`,
      );
    }
    const type =
      languageOption(options.fieldTypes) ??
      fieldType(
        field.rule,
        variant ? `${variant}.${fieldName}` : `${name}.${fieldName}`,
        `${name}${capitalized(fieldName)}`,
        context,
        visiting,
      );
    if (context.language === "kotlin" && /\bJsonElement\b/.test(type)) {
      context.kotlinImports.add("kotlinx.serialization.json.JsonElement");
    }
    return {
      name: fieldName,
      doc: options.fieldDocs?.[key] ?? options.fieldDocs?.[fieldName],
      defaultValue,
      validator: languageOption(options.validators),
      type,
      optional: field.optional,
    };
  });
}
export function renderKotlinClass(
  name: string,
  fields: readonly RenderField[],
  suffix = "",
  options: ModelOptions = {},
): string[] {
  const parameters = fields.map(kotlinProperty);
  const body = kotlinBody(fields, options);
  // ktfmt keeps short single-field data classes on one line.
  if (
    fields.length === 1 &&
    !fields[0].doc &&
    `data class ${name}(${parameters[0]})${suffix}`.length <= 100
  ) {
    return [
      `data class ${name}(${parameters[0]})${suffix}${body.length ? " {" : ""}`,
      ...body,
      ...(body.length ? ["}"] : []),
    ];
  }
  return [
    `data class ${name}(`,
    ...fields.flatMap((field) => [
      ...docLines(field.doc, "kotlin").map((line) => `  ${line}`),
      `  ${kotlinProperty(field)},`,
    ]),
    `)${suffix}${body.length ? " {" : ""}`,
    ...body,
    ...(body.length ? ["}"] : []),
  ];
}
export function renderObject(
  name: string,
  rule: Rule,
  options: ModelOptions,
  context: RenderContext,
  visiting: readonly string[],
): void {
  const fields = renderFields(name, rule, context, visiting, options);
  const type = modelName(name, options, context.language);
  context.output.push("", ...docLines(options.doc, context.language));
  if (context.language === "kotlin") {
    const body = kotlinBody(fields, options);
    // Existing scalar model output is deliberately stable, including one-field objects.
    context.output.push(
      "@Serializable",
      `data class ${type}(`,
      ...fields.flatMap((field) => [
        ...docLines(field.doc, "kotlin").map((line) => `  ${line}`),
        `  ${kotlinProperty(field)},`,
      ]),
      body.length ? ") {" : ")",
      ...body,
      ...(body.length ? ["}"] : []),
    );
  } else {
    const conformances = options.swiftConformances ?? ["Codable", "Equatable", "Sendable"];
    context.output.push(
      `struct ${type}${conformances.length ? `: ${conformances.join(", ")}` : ""} {`,
      ...swiftProperties(fields),
      ...swiftObjectDecoder(fields, conformances),
      "}",
    );
  }
}
