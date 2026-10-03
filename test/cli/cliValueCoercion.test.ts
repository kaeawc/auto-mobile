import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { z as v4 } from "zod/v4";
import {
  asDeclaredNumber,
  asDeclaredString,
  coerceCliValue,
  collectSchemaShapes,
  resolveDeclaredType,
  SCHEMA_WRAPPER_TYPES,
  schemaTypeName,
  tryParseJsonToken,
  unwrapSchema,
} from "../../src/cli/cliValueCoercion";

const withDef = (definition: Record<string, unknown>): unknown => ({ _def: definition });

const jsonTokens: ReadonlyArray<readonly [string, unknown]> = [
  ['{"key":1}', { key: 1 }],
  ["[1,true]", [1, true]],
  ["42", 42],
  ['"abc"', "abc"],
  ["true", true],
  ["false", false],
  ["null", null],
];
const numberTokens: ReadonlyArray<readonly [string, unknown]> = [
  ["42", 42],
  ["-7", -7],
  ["3.14", 3.14],
  ["-0.5", -0.5],
  ["1e3", 1000],
  ["007", "007"],
  ["0x10", "0x10"],
  ["NaN", "NaN"],
  ["Infinity", "Infinity"],
  ["-Infinity", "-Infinity"],
  ["", ""],
  [" ", " "],
  ["9007199254740993", 9007199254740992],
  ["1e999", "1e999"],
  ['"5"', '"5"'],
  ["true", "true"],
  ["{}", "{}"],
  ["[]", "[]"],
  ["null", "null"],
];

describe("coerceCliValue", () => {
  for (const type of ["string", "number", "unknown"]) {
    test(`nullable ${type} preserves explicit null`, () => {
      expect(coerceCliValue("null", { type, nullable: true })).toBeNull();
    });
    test(`nullable ${type} still coerces non-null tokens`, () => {
      expect(coerceCliValue("42", { type, nullable: true })).toBe(type === "string" ? "42" : 42);
    });
  }
  test("non-nullable string keeps null spelling; unknown parses JSON null", () => {
    expect(coerceCliValue("null", { type: "string", nullable: false })).toBe("null");
    expect(coerceCliValue("null", { type: "unknown", nullable: false })).toBeNull();
    expect(coerceCliValue("null", undefined)).toBeNull();
  });
  for (const type of ["string", "enum"]) {
    for (const raw of ["plain", "007", "0x10", "1e3", "42", "true", "false", "{}", "[]", ""]) {
      test(`${type} preserves ${JSON.stringify(raw)}`, () => {
        expect(coerceCliValue(raw, { type, nullable: false })).toBe(raw);
      });
    }
    test(`${type} unquotes a JSON string`, () => {
      expect(coerceCliValue('"abc"', { type, nullable: false })).toBe("abc");
    });
  }
  for (const type of ["number", "bigint"]) {
    for (const [raw, expected] of numberTokens) {
      test(`${type} coerces ${JSON.stringify(raw)}`, () => {
        expect(coerceCliValue(raw, { type, nullable: false })).toEqual(expected);
      });
    }
  }
  for (const [raw, expected] of [
    ["true", true],
    ["false", false],
    ["TRUE", "TRUE"],
    ["1", 1],
    ["yes", "yes"],
  ] as const) {
    test(`boolean coerces ${raw}`, () => {
      expect(coerceCliValue(raw, { type: "boolean", nullable: false })).toBe(expected);
    });
  }
  // Arrays receive one token here; flag assembly belongs to the argument parser.
  for (const type of ["unknown", "array", "object", undefined]) {
    for (const [raw, expected] of [...jsonTokens, ["plain", "plain"] as const]) {
      test(`${type ?? "undeclared"} best-effort parses ${JSON.stringify(raw)}`, () => {
        const declared = type === undefined ? undefined : { type, nullable: false };
        expect(coerceCliValue(raw, declared)).toEqual(expected);
      });
    }
  }
});

describe("tryParseJsonToken", () => {
  for (const [raw, value] of jsonTokens) {
    test(`reports successful parsing of ${JSON.stringify(raw)}`, () => {
      expect(tryParseJsonToken(raw)).toEqual({ parsed: true, value });
    });
  }
  for (const raw of ["plain", "007", "", "{bad json}"]) {
    test(`reports raw non-JSON token ${JSON.stringify(raw)}`, () => {
      expect(tryParseJsonToken(raw)).toEqual({ parsed: false, value: raw });
    });
  }
  test("JSON overflow is parsed successfully even though it is infinite", () => {
    expect(tryParseJsonToken("1e999")).toEqual({ parsed: true, value: Infinity });
  });
});

describe("asDeclaredString", () => {
  for (const raw of ["plain", "42", "true", "{}", "[]", "null", ""]) {
    test(`keeps ${JSON.stringify(raw)} raw`, () => {
      expect(asDeclaredString(raw)).toBe(raw);
    });
  }
  test("unquotes strings and decodes JSON escapes", () => {
    expect(asDeclaredString('"abc"')).toBe("abc");
    expect(asDeclaredString('"a\\nb"')).toBe("a\nb");
    expect(asDeclaredString('""')).toBe("");
  });
});

describe("asDeclaredNumber", () => {
  for (const [raw, expected] of numberTokens) {
    test(`handles ${JSON.stringify(raw)}`, () => {
      expect(asDeclaredNumber(raw)).toEqual(expected);
    });
  }
});

describe("SCHEMA_WRAPPER_TYPES", () => {
  test("exports exactly the supported wrapper names", () => {
    expect(SCHEMA_WRAPPER_TYPES).toBeInstanceOf(Set);
    expect([...SCHEMA_WRAPPER_TYPES].sort()).toEqual(
      ["optional", "nullable", "default", "readonly", "catch", "branded", "lazy"].sort(),
    );
  });
});

describe("schemaTypeName", () => {
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["Zod 3 string", z.string(), "string"],
    ["Zod 4 string", v4.string(), "string"],
    ["typeName takes priority", withDef({ typeName: "ZodNumber", type: "string" }), "number"],
    ["type fallback", withDef({ type: "string" }), "string"],
    ["null typeName falls back", withDef({ typeName: null, type: "boolean" }), "boolean"],
    [
      "lowercase discriminated union",
      withDef({ typeName: "ZodDiscriminatedUnion" }),
      "discriminatedunion",
    ],
    ["missing keys", withDef({}), "unknown"],
    ["missing definition", {}, "unknown"],
    ["null schema", null, "unknown"],
    ["undefined schema", undefined, "unknown"],
    ["non-string name is stringified", withDef({ type: 42 }), "42"],
  ];
  for (const [name, schema, expected] of cases) {
    test(name, () => {
      expect(schemaTypeName(schema)).toBe(expected);
    });
  }
});

describe("unwrapSchema", () => {
  const inner = z.string();
  const wrappers = [
    inner.optional(),
    inner.nullable(),
    inner.default("x"),
    inner.readonly(),
    inner.catch("x"),
    inner.brand(),
    inner.refine(() => true),
  ];
  for (const wrapper of wrappers) {
    test(`unwraps real ${schemaTypeName(wrapper)} by identity`, () => {
      expect(unwrapSchema(wrapper)).toBe(inner);
    });
  }
  test("unwraps Zod 4 innerType by identity", () => {
    const schema = v4.string();
    expect(unwrapSchema(schema.optional())).toBe(schema);
  });
  test("uses innerType before type before schema with nullish fallback", () => {
    expect(unwrapSchema(withDef({ innerType: inner, type: z.number(), schema: z.boolean() }))).toBe(
      inner,
    );
    expect(unwrapSchema(withDef({ innerType: null, type: inner, schema: z.number() }))).toBe(inner);
    expect(unwrapSchema(withDef({ type: null, schema: inner }))).toBe(inner);
  });
  for (const schema of [null, undefined, {}, withDef({})]) {
    test(`returns null for ${JSON.stringify(schema)}`, () => {
      expect(unwrapSchema(schema)).toBeNull();
    });
  }
});

describe("resolveDeclaredType", () => {
  const cases: ReadonlyArray<readonly [string, unknown, string, boolean]> = [
    ["string", z.string(), "string", false],
    ["number", z.number(), "number", false],
    ["boolean", z.boolean(), "boolean", false],
    ["bigint", z.bigint(), "bigint", false],
    ["optional", z.string().optional(), "string", false],
    ["nullable", z.string().nullable(), "string", true],
    ["optional nullable", z.string().nullable().optional(), "string", true],
    ["nullable optional", z.string().optional().nullable(), "string", true],
    ["default", z.string().default("x"), "string", false],
    ["readonly", z.number().readonly(), "number", false],
    ["catch", z.boolean().catch(false), "boolean", false],
    // Lazy stores a getter, which unwrapSchema currently does not call.
    ["lazy", z.lazy(() => z.string()), "unknown", false],
    ["branded", z.string().brand(), "string", false],
    [
      "nested wrappers",
      z.string().nullable().default("x").catch("x").readonly().brand().optional(),
      "string",
      true,
    ],
    ["string literal", z.literal("x"), "string", false],
    ["number literal", z.literal(5), "number", false],
    ["boolean literal", z.literal(false), "boolean", false],
    ["null literal uses missing values fallback", z.literal(null), "undefined", false],
    ["v4 string literal", v4.literal("x"), "string", false],
    ["v4 number literal", v4.literal(5), "number", false],
    ["v4 boolean literal", v4.literal(false), "boolean", false],
    ["values fallback", withDef({ type: "literal", values: ["x"] }), "string", false],
    ["value priority", withDef({ type: "literal", value: 0, values: ["x"] }), "number", false],
    ["missing literal value", withDef({ type: "literal" }), "undefined", false],
    ["string number union", z.union([z.string(), z.number()]), "string", false],
    [
      "all scalar string union",
      z.union([z.string(), z.number(), z.boolean(), z.bigint()]),
      "string",
      false,
    ],
    ["number boolean union", z.union([z.number(), z.boolean()]), "union", false],
    ["string object union", z.union([z.string(), z.object({})]), "union", false],
    ["string literals union", z.union([z.literal("a"), z.literal("b")]), "string", false],
    ["string and literal union", z.union([z.string(), z.literal("b")]), "string", false],
    [
      "nullable member does not propagate union nullability",
      z.union([z.string().nullable(), z.number()]),
      "string",
      false,
    ],
    ["outer nullable union", z.union([z.string(), z.number()]).nullable(), "string", true],
    ["missing union options", withDef({ type: "union" }), "union", false],
    ["non-array union options", withDef({ type: "union", options: {} }), "union", false],
    ["empty union options", withDef({ type: "union", options: [] }), "union", false],
    ["enum", z.enum(["a", "b"]), "enum", false],
    ["native enum", z.nativeEnum({ A: "a", B: "b" }), "nativeenum", false],
    ["array", z.array(z.string()), "array", false],
    ["object", z.object({}), "object", false],
    ["record", z.record(z.string()), "record", false],
    ["missing wrapper inner schema", withDef({ type: "optional" }), "unknown", false],
    ["missing nullable inner schema", withDef({ type: "nullable" }), "unknown", true],
    ["null", null, "unknown", false],
    ["undefined", undefined, "unknown", false],
  ];
  for (const [name, schema, type, nullable] of cases) {
    test(name, () => {
      expect(resolveDeclaredType(schema)).toEqual({ type, nullable });
    });
  }
  for (const count of [9, 10, 11]) {
    test(`${count} wrapper layers pin the ten-iteration depth cap`, () => {
      let schema: unknown = z.string();
      for (let depth = 0; depth < count; depth++) {
        schema = withDef({ typeName: "ZodOptional", innerType: schema });
      }
      expect(resolveDeclaredType(schema)).toEqual({
        type: count < 10 ? "string" : "unknown",
        nullable: false,
      });
    });
  }
  test("depth exhaustion retains nullability already crossed", () => {
    let schema: unknown = z.string();
    for (let depth = 0; depth < 10; depth++) {
      schema = withDef({ type: "nullable", innerType: schema });
    }
    expect(resolveDeclaredType(schema)).toEqual({ type: "unknown", nullable: true });
  });
});

describe("collectSchemaShapes", () => {
  const first = z.object({ kind: z.literal("first"), text: z.string() });
  const second = z.object({ kind: z.literal("second"), count: z.number() });
  // Zod 3 stores a shape function; current collection returns that function unchanged.
  test("Zod 3 object returns its stored shape by identity", () => {
    const shapes = collectSchemaShapes(first);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toBe(first._def.shape);
  });
  test("Zod 4 object returns a shape record", () => {
    const schema = v4.object({ text: v4.string() });
    expect(collectSchemaShapes(schema)).toEqual([schema.shape]);
  });
  test("union collects each object shape in order", () => {
    expect(collectSchemaShapes(z.union([first, second]))).toEqual([
      first._def.shape,
      second._def.shape,
    ]);
  });
  test("discriminated union collects each object shape", () => {
    expect(collectSchemaShapes(z.discriminatedUnion("kind", [first, second]))).toEqual([
      first._def.shape,
      second._def.shape,
    ]);
  });
  test("nested unions flatten and ignore non-object members", () => {
    expect(collectSchemaShapes(z.union([z.union([first, z.string()]), second]))).toEqual([
      first._def.shape,
      second._def.shape,
    ]);
  });
  test("pipe uses output union options", () => {
    expect(collectSchemaShapes(withDef({ out: withDef({ options: [first, second] }) }))).toEqual([
      first._def.shape,
      second._def.shape,
    ]);
    expect(collectSchemaShapes(z.unknown().pipe(z.union([first, second])))).toEqual([
      first._def.shape,
      second._def.shape,
    ]);
  });
  test("pipe recurses into output shape", () => {
    const shape = { text: z.string() };
    expect(collectSchemaShapes(withDef({ out: withDef({ shape }) }))).toEqual([shape]);
    expect(collectSchemaShapes(z.unknown().pipe(first))).toEqual([first._def.shape]);
  });
  test("pipe with scalar output produces no shapes", () => {
    expect(collectSchemaShapes(withDef({ out: z.string() }))).toEqual([]);
  });
  test("own shape takes precedence over options and output", () => {
    const shape = { text: z.string() };
    expect(collectSchemaShapes(withDef({ shape, options: [second], out: second }))).toEqual([
      shape,
    ]);
  });
  test("own options take precedence over output options, including empty options", () => {
    expect(
      collectSchemaShapes(withDef({ options: [first], out: withDef({ options: [second] }) })),
    ).toEqual([first._def.shape]);
    expect(collectSchemaShapes(withDef({ options: [], out: second }))).toEqual([]);
  });
  test("null options fall back to output options", () => {
    expect(
      collectSchemaShapes(withDef({ options: null, out: withDef({ options: [first] }) })),
    ).toEqual([first._def.shape]);
  });
  test("non-array options fall through to output recursion", () => {
    expect(collectSchemaShapes(withDef({ options: {}, out: first }))).toEqual([first._def.shape]);
    expect(collectSchemaShapes(withDef({ options: {} }))).toEqual([]);
  });
  for (const [name, schema] of [
    ["string", z.string()],
    ["null", null],
    ["undefined", undefined],
    ["missing definition", {}],
    ["empty definition", withDef({})],
    ["output without definition", withDef({ out: {} })],
  ] as const) {
    test(`${name} produces no shapes`, () => {
      expect(collectSchemaShapes(schema)).toEqual([]);
    });
  }
});
