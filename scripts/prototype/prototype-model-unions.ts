import { renderKotlinBase } from "./prototype-model-base";
import { swiftDecodeLocals } from "./prototype-model-members";
import type { Rule } from "../../src/features/prototype/prototypeBindingValidation";
import type { ModelOptions } from "./generate-prototype-spec-models";
import {
  capitalized,
  docLines,
  escapeModelIdentifier,
  modelName,
  renderFields,
  renderKotlinClass,
  type RenderContext,
  type RenderField,
} from "./prototype-model-rendering";

interface Variant {
  name: string;
  fields: RenderField[];
}
export function renderUnion(
  name: string,
  rule: Rule,
  options: ModelOptions,
  context: RenderContext,
): void {
  const entries = Object.entries(rule.variants ?? {});
  if (!entries.length) {
    throw new Error(`Definition ${name}: unsupported kind tagged; missing variants`);
  }
  const tag = Object.keys(entries[0][1].fields ?? {}).find((key) =>
    entries.every(([variant, object]) => {
      const field = object.fields?.[key];
      return (
        object.kind === "object" &&
        field &&
        !field.optional &&
        field.rule.kind === "enum" &&
        field.rule.values?.length === 1 &&
        field.rule.values[0] === variant
      );
    }),
  );
  if (!tag) {
    throw new Error(`Definition ${name}: tagged union has no consistent tag field`);
  }
  if (context.language === "kotlin" && tag !== "type") {
    throw new Error(
      `Definition ${name}: Kotlin tagged union requires tag field "type" to match classDiscriminator; found "${tag}"`,
    );
  }
  const variants = entries.map(([variant, object]) => {
    const fields = Object.fromEntries(
      Object.entries(object.fields ?? {}).filter(([key]) => key !== tag),
    );
    if (!Object.keys(fields).length && context.language !== "kotlin") {
      throw new Error(`Definition ${name}.${variant}: variant without fields is unsupported`);
    }
    return {
      name: variant,
      fields: Object.keys(fields).length
        ? renderFields(
            `${name}${capitalized(variant)}`,
            { kind: "object", fields },
            context,
            [name],
            options,
            variant,
          )
        : [],
    };
  });
  const type = modelName(name, options, context.language);
  context.output.push("", ...docLines(options.doc, context.language));
  if (context.language === "kotlin") {
    context.output.push(...renderKotlinBase(type, variants, options));
    for (const variant of variants) {
      if (options.kotlinHandWrittenVariants?.includes(variant.name)) {
        continue;
      }
      const variantType =
        options.variantNames?.[variant.name] ??
        `Prototype${capitalized(variant.name)}${capitalized(name)}`;
      context.output.push(
        "",
        ...docLines(options.variantDocs?.[variant.name], "kotlin"),
        ...(variant.fields.length ? [`@SerialName("${variant.name}")`, "@Serializable"] : []),
        ...(variant.fields.length
          ? renderKotlinClass(variantType, variant.fields, ` : ${type}()`, options)
          : fieldlessKotlinVariant(variant.name, variantType, type)),
      );
    }
  } else {
    renderSwiftUnion(type, tag, variants, options, context.output);
  }
}
const id = (name: string): string => escapeModelIdentifier(name, "swift");
const member = (name: string): string => escapeModelIdentifier(name, "swift", "member");
const argument = (name: string): string => escapeModelIdentifier(name, "swift", "argument");
function renderSwiftUnion(
  type: string,
  tag: string,
  variants: Variant[],
  options: ModelOptions,
  output: string[],
): void {
  const conformances = options.swiftConformances ?? ["Codable", "Equatable", "Sendable"];
  output.push(`enum ${type}${conformances.length ? `: ${conformances.join(", ")}` : ""} {`);
  for (const variant of variants) {
    output.push(
      ...docLines(options.variantDocs?.[variant.name], "swift").map((line) => `    ${line}`),
    );
    output.push(
      ...variant.fields.flatMap((field) =>
        docLines(field.doc, "swift").map((line) => `    ${line}`),
      ),
    );
    output.push(
      `    case ${id(variant.name)}(${variant.fields.map((field) => `${argument(field.name)}: ${field.type}${field.optional ? "?" : ""}`).join(", ")})`,
    );
  }
  const decodes = conformances.includes("Decodable") || conformances.includes("Codable");
  const encodes = conformances.includes("Encodable") || conformances.includes("Codable");
  if (!decodes && variants.some((variant) => variant.fields.some((field) => field.validator))) {
    throw new Error("Swift validators require a Decodable conformance");
  }
  if (decodes || encodes) {
    const keys = [
      ...new Set([
        tag,
        ...variants.flatMap((variant) => variant.fields.map((field) => field.name)),
      ]),
    ];
    output.push(
      "",
      "    private enum CodingKeys: String, CodingKey {",
      ...keys.map((key) => `        case ${id(key)}`),
      "    }",
    );
  }
  if (decodes) {
    renderDecoder(type, tag, variants, output);
  }
  if (encodes) {
    renderEncoder(tag, variants, output);
  }
  output.push("}");
}
function renderDecoder(type: string, tag: string, variants: Variant[], output: string[]): void {
  output.push(
    "",
    "    init(from decoder: Decoder) throws {",
    "        let container = try decoder.container(keyedBy: CodingKeys.self)",
    `        let type = try container.decode(String.self, forKey: .${member(tag)})`,
    "        switch type {",
  );
  for (const variant of variants) {
    output.push(`        case "${variant.name}":`);
    if (variant.fields.some((field) => field.validator)) {
      output.push(...swiftDecodeLocals(variant.fields, "            "));
      output.push(
        `            self = .${member(variant.name)}(`,
        ...variant.fields.map(
          (field, index) =>
            `                ${argument(field.name)}: ${id(field.name)}${index < variant.fields.length - 1 ? "," : ""}`,
        ),
        "            )",
      );
    } else {
      output.push(
        `            self = try .${member(variant.name)}(`,
        ...variant.fields.map(
          (field, index) =>
            `                ${argument(field.name)}: container.${field.optional ? "decodeIfPresent" : "decode"}(${field.type}.self, forKey: .${member(field.name)})${index < variant.fields.length - 1 ? "," : ""}`,
        ),
        "            )",
      );
    }
  }
  output.push(
    "        default:",
    "            throw DecodingError.dataCorruptedError(",
    `                forKey: .${member(tag)},`,
    "                in: container,",
    `                debugDescription: "Unknown ${type} type \\(type)"`,
    "            )",
    "        }",
    "    }",
  );
}
function renderEncoder(tag: string, variants: Variant[], output: string[]): void {
  output.push(
    "",
    "    func encode(to encoder: Encoder) throws {",
    "        var container = encoder.container(keyedBy: CodingKeys.self)",
    "        switch self {",
  );
  for (const variant of variants) {
    output.push(
      `        case let .${member(variant.name)}(${variant.fields.map((field) => `${argument(field.name)}: ${id(field.name)}`).join(", ")}):`,
      `            try container.encode("${variant.name}", forKey: .${member(tag)})`,
    );
    output.push(
      ...variant.fields.map(
        (field) =>
          `            try container.${field.optional ? "encodeIfPresent" : "encode"}(${id(field.name)}, forKey: .${member(field.name)})`,
      ),
    );
  }
  output.push("        }", "    }");
}

/** A field-less variant on one line, or split the way ktfmt splits it once it passes 100 columns. */
function fieldlessKotlinVariant(name: string, variantType: string, type: string): string[] {
  const annotations = [`@SerialName("${name}")`, "@Serializable"];
  const declaration = `data object ${variantType} : ${type}()`;
  const singleLine = [...annotations, declaration].join(" ");
  return singleLine.length <= 100 ? [singleLine] : [...annotations, declaration];
}
