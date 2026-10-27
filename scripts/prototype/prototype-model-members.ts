import type { ModelOptions } from "./prototype-model-selection";
import { docLines, escapeModelIdentifier, type RenderField } from "./prototype-model-rendering";

export function kotlinProperty(field: RenderField): string {
  return `${field.override ? "override " : ""}val ${escapeModelIdentifier(field.name, "kotlin")}: ${kotlinParameterType(field)}`;
}
function kotlinParameterType(field: RenderField): string {
  if (field.defaultValue !== undefined) {
    return `${field.type} = ${field.defaultValue}`;
  }
  return `${field.type}${field.optional ? "? = null" : ""}`;
}

/** Body members stay independent of the class header so future sealed bases can reuse them. */
export function kotlinBody(fields: readonly RenderField[], options: ModelOptions): string[] {
  const output: string[] = [];
  for (const name of options.kotlinStringOverloads ?? []) {
    const field = fields.find((candidate) => candidate.name === name);
    if (field?.type !== "PrototypeModeValue") {
      throw new Error(`String overload ${name} requires a PrototypeModeValue field`);
    }
    const parameters = fields.map(
      (parameter) =>
        `${escapeModelIdentifier(parameter.name, "kotlin")}: ${parameter === field ? "String" : kotlinParameterType(parameter)}`,
    );
    const args = fields.map((parameter) => {
      const id = escapeModelIdentifier(parameter.name, "kotlin");
      return parameter === field ? `PrototypeModeValue.Single(${id})` : id;
    });
    const delegate = ` : this(${args.join(", ")})`;
    const singleLine = `  constructor(${parameters.join(", ")})${delegate}`;
    if (singleLine.length <= 100 && !fields.some((parameter) => parameter.optional)) {
      output.push(singleLine);
    } else {
      output.push(
        "  constructor(",
        ...parameters.map((parameter) => `    ${parameter},`),
        `  )${delegate}`,
      );
    }
  }
  const validators = fields.filter((field) => field.validator);
  if (validators.length) {
    if (output.length) {
      output.push("");
    }
    output.push(
      "  init {",
      ...validators.map(
        (field) => `    ${field.validator}(${escapeModelIdentifier(field.name, "kotlin")})`,
      ),
      "  }",
    );
  }
  return output;
}

export function swiftProperties(fields: readonly RenderField[]): string[] {
  return fields.flatMap((field) => [
    ...docLines(field.doc, "swift").map((line) => `    ${line}`),
    `    let ${escapeModelIdentifier(field.name, "swift")}: ${field.type}${field.optional ? "?" : ""}`,
  ]);
}

/** Decode to locals before validation and assignment, including optional values. */
export function swiftDecodeLocals(fields: readonly RenderField[], indent: string): string[] {
  return fields.flatMap((field) => {
    const id = escapeModelIdentifier(field.name, "swift");
    const key = escapeModelIdentifier(field.name, "swift", "member");
    return [
      `${indent}let ${id} = try container.${field.optional ? "decodeIfPresent" : "decode"}(${field.type}.self, forKey: .${key})`,
      ...(field.validator
        ? [`${indent}try ${field.validator}(${id}, forKey: .${key}, in: container)`]
        : []),
    ];
  });
}
export function swiftObjectDecoder(
  fields: readonly RenderField[],
  conformances: readonly string[],
): string[] {
  if (!fields.some((field) => field.validator)) {
    return [];
  }
  if (!conformances.some((name) => name === "Decodable" || name === "Codable")) {
    throw new Error("Swift validators require a Decodable conformance");
  }
  return [
    "",
    "    private enum CodingKeys: String, CodingKey {",
    ...fields.map((field) => `        case ${escapeModelIdentifier(field.name, "swift")}`),
    "    }",
    "",
    "    init(from decoder: Decoder) throws {",
    "        let container = try decoder.container(keyedBy: CodingKeys.self)",
    ...swiftDecodeLocals(fields, "        "),
    ...fields.map(
      (field) =>
        `        self.${escapeModelIdentifier(field.name, "swift", "member")} = ${escapeModelIdentifier(field.name, "swift")}`,
    ),
    "    }",
  ];
}
