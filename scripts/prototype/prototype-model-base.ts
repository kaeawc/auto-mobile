import type { ModelOptions } from "./prototype-model-selection";
import { docLines, escapeModelIdentifier, type RenderField } from "./prototype-model-rendering";

/** Validate the shared API against the current contract, then order each variant's overrides. */
export function renderKotlinBase(
  type: string,
  variants: { name: string; fields: RenderField[] }[],
  options: ModelOptions,
): string[] {
  const base = options.kotlinBase;
  if (!base) {
    return [`@Serializable sealed class ${type}`];
  }
  const output = ["@Serializable", `sealed class ${type} {`];
  for (const name of base.fields) {
    const fields = variants.flatMap((variant) =>
      variant.fields.filter((field) => field.name === name),
    );
    if (!fields.length) {
      throw new Error(`Kotlin base ${type}: unknown field ${name}`);
    }
    const field = fields[0];
    if (fields.some((candidate) => candidate.type !== field.type)) {
      throw new Error(`Kotlin base ${type}.${name}: types differ between variants`);
    }
    const all = fields.length === variants.length;
    output.push(
      ...docLines(base.docs?.[name], "kotlin").map((line) => `  ${line}`),
      `  ${all ? "abstract" : "open"} val ${escapeModelIdentifier(name, "kotlin")}: ${field.type}${fields.some((candidate) => candidate.optional && candidate.defaultValue === undefined) || !all ? "?" : ""}`,
      ...(!all ? ["    get() = null", ""] : []),
    );
  }
  for (const variant of variants) {
    const shared = base.fields.flatMap((name) =>
      variant.fields.filter((field) => field.name === name),
    );
    variant.fields = [
      ...shared.map((field) => ({ ...field, override: true })),
      ...variant.fields.filter((field) => !base.fields.includes(field.name)),
    ];
  }
  if (output.at(-1) === "") {
    output.pop();
  }
  return [...output, "}"];
}
