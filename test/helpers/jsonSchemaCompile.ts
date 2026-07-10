import Ajv2020 from "ajv/dist/2020";

export function compileJsonSchema(schema: unknown): void {
  const ajv = new Ajv2020({ strict: false });
  ajv.compile(schema);
}
