import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sql } from "kysely";
import ts from "typescript";
import { createTestDatabase } from "./testDbHelper";

interface Column {
  nullable: boolean;
  optional: boolean;
}
type Schema = Map<string, Map<string, Column>>;

// These are the only non-application tables observed in the migrated main DB.
const EXCLUDED_TABLES = new Map([
  ["kysely_migration", "Kysely owns migration history."],
  ["kysely_migration_lock", "Kysely owns migration locking."],
  ["sqlite_sequence", "SQLite owns AUTOINCREMENT counters."],
]);

// Optionality preserves older hand-built session fixtures; SELECT nullability is
// still checked independently against the migrated schema (#11860).
const KNOWN_OPTIONAL = new Map([
  ["device_sessions.stable_device_id", "Legacy session fixtures predate stable identity."],
  [
    "device_sessions.stable_identity_generation",
    "Legacy fixtures omit the defaulted identity fence.",
  ],
  [
    "device_sessions.liveness_contract_generation",
    "Legacy fixtures omit the defaulted liveness fence.",
  ],
  ["device_sessions.heartbeat_timeout_source", "Legacy fixtures predate heartbeat provenance."],
  ["device_sessions.liveness_policy", "Legacy fixtures predate the CLI liveness policy."],
  [
    "device_sessions.pre_cli_heartbeat_timeout_ms",
    "Legacy fixtures predate saved CLI timeout state.",
  ],
  [
    "device_sessions.pre_cli_heartbeat_timeout_source",
    "Legacy fixtures predate saved CLI provenance.",
  ],
  [
    "device_sessions.pre_cli_session_timeout_ms",
    "Legacy fixtures predate saved CLI session timeout.",
  ],
  ["device_sessions.liveness_owner_token", "Legacy fixtures predate the CLI owner fence."],
]);

/** A deliberately syntactic resolver: unsupported forms fail rather than hide drift. */
class SchemaParser {
  private readonly files = new Map<string, ts.SourceFile>();

  source(path: string): ts.SourceFile {
    let file = this.files.get(path);
    if (!file) {
      file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      this.files.set(path, file);
    }
    return file;
  }

  declaration(
    file: ts.SourceFile,
    name: string,
  ): ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
    for (const statement of file.statements) {
      if (
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === name
      ) {
        return statement;
      }
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (
        !bindings ||
        !ts.isNamedImports(bindings) ||
        !statement.moduleSpecifier.text.startsWith(".")
      ) {
        continue;
      }
      const imported = bindings.elements.find((element) => element.name.text === name);
      if (imported) {
        const path = resolve(dirname(file.fileName), `${statement.moduleSpecifier.text}.ts`);
        return this.declaration(this.source(path), imported.propertyName?.text ?? name);
      }
    }
    throw new Error(`Cannot resolve ${name} in ${file.fileName}`);
  }

  nullable(node: ts.TypeNode, parameters = new Map<string, ts.TypeNode>()): boolean {
    if (ts.isParenthesizedTypeNode(node)) {
      return this.nullable(node.type, parameters);
    }
    if (ts.isUnionTypeNode(node)) {
      return node.types.some((type) => this.nullable(type, parameters));
    }
    if (ts.isLiteralTypeNode(node)) {
      return node.literal.kind === ts.SyntaxKind.NullKeyword;
    }
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText();
      const parameter = parameters.get(name);
      if (parameter) {
        return this.nullable(parameter);
      }
      // Kysely's SELECT type is the first argument; insert/update types do not
      // affect schema nullability. GeneratedAlways has the same SELECT shape.
      if (["Generated", "GeneratedAlways", "ColumnType", "JSONColumnType"].includes(name)) {
        const select = node.typeArguments?.[0];
        if (!select) {
          throw new Error(`Missing SELECT argument: ${node.getText()}`);
        }
        return this.nullable(select, parameters);
      }
      const declaration = this.declaration(node.getSourceFile(), name);
      if (ts.isInterfaceDeclaration(declaration)) {
        return false; // An object interface cannot itself be null.
      }
      const bindings = new Map(parameters);
      for (const [index, typeParameter] of (declaration.typeParameters ?? []).entries()) {
        const argument = node.typeArguments?.[index] ?? typeParameter.default;
        if (!argument) {
          throw new Error(`Missing alias argument: ${node.getText()}`);
        }
        bindings.set(typeParameter.name.text, parameters.get(argument.getText()) ?? argument);
      }
      return this.nullable(declaration.type, bindings);
    }
    if (
      [
        ts.SyntaxKind.StringKeyword,
        ts.SyntaxKind.NumberKeyword,
        ts.SyntaxKind.BooleanKeyword,
        ts.SyntaxKind.UndefinedKeyword,
        ts.SyntaxKind.NeverKeyword,
      ].includes(node.kind) ||
      ts.isArrayTypeNode(node) ||
      ts.isTypeLiteralNode(node) ||
      ts.isTupleTypeNode(node)
    ) {
      return false;
    }
    throw new Error(`Unsupported SELECT type: ${node.getText()}`);
  }

  columns(declaration: ts.InterfaceDeclaration): Map<string, Column> {
    const columns = new Map<string, Column>();
    for (const clause of declaration.heritageClauses ?? []) {
      for (const base of clause.types) {
        const inherited = this.declaration(declaration.getSourceFile(), base.expression.getText());
        if (!ts.isInterfaceDeclaration(inherited)) {
          throw new Error(`Expected interface base: ${base.getText()}`);
        }
        for (const [name, column] of this.columns(inherited)) {
          columns.set(name, column);
        }
      }
    }
    for (const member of declaration.members) {
      if (
        !ts.isPropertySignature(member) ||
        !member.type ||
        !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
      ) {
        throw new Error(`Unsupported column: ${member.getText()}`);
      }
      columns.set(member.name.text, {
        nullable: this.nullable(member.type),
        optional: Boolean(member.questionToken),
      });
    }
    return columns;
  }

  schema(file: ts.SourceFile): Schema {
    const database = this.declaration(file, "Database");
    if (!ts.isInterfaceDeclaration(database)) {
      throw new Error("Database must be an interface");
    }
    const schema: Schema = new Map();
    for (const member of database.members) {
      if (
        !ts.isPropertySignature(member) ||
        !member.type ||
        !ts.isTypeReferenceNode(member.type) ||
        !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
      ) {
        throw new Error(`Unsupported table: ${member.getText()}`);
      }
      const table = this.declaration(file, member.type.typeName.getText());
      if (!ts.isInterfaceDeclaration(table)) {
        throw new Error(`Expected table interface: ${member.getText()}`);
      }
      schema.set(member.name.text, this.columns(table));
    }
    return schema;
  }
}

/** Pure comparison, shared by the real schema checks and mutation sanity check. */
function compareSchemas(model: Schema, migrated: Schema) {
  const missingTables: string[] = [];
  const untypedTables: string[] = [];
  const columns: string[] = [];
  const nullability: string[] = [];
  const optional: string[] = [];
  for (const table of migrated.keys()) {
    if (!model.has(table) && !EXCLUDED_TABLES.has(table)) {
      untypedTables.push(`${table}: missing from Database`);
    }
  }
  for (const [table, typedColumns] of model) {
    const actual = migrated.get(table);
    if (!actual) {
      missingTables.push(`${table}: missing from SQLite`);
      continue;
    }
    for (const name of actual.keys()) {
      if (!typedColumns.has(name)) {
        columns.push(`${table}.${name}: missing from TypeScript`);
      }
    }
    for (const [name, column] of typedColumns) {
      const key = `${table}.${name}`;
      const dbColumn = actual.get(name);
      if (!dbColumn) {
        columns.push(`${key}: missing from SQLite`);
      } else if (column.nullable !== dbColumn.nullable) {
        nullability.push(
          `${key}: TS nullable=${column.nullable}, SQLite nullable=${dbColumn.nullable}`,
        );
      }
      if (column.optional && !KNOWN_OPTIONAL.has(key)) {
        optional.push(`${key}: unexpected optional property`);
      }
    }
  }
  return { missingTables, untypedTables, columns, nullability, optional };
}

let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let differences: ReturnType<typeof compareSchemas>;
let mutation: ReturnType<typeof compareSchemas>;

beforeAll(async () => {
  db = await createTestDatabase();
  const parser = new SchemaParser();
  const model = parser.schema(parser.source(resolve(import.meta.dir, "../../src/db/types.ts")));
  const migrated: Schema = new Map();
  const tables = await sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type='table'`.execute(db);
  for (const { name } of tables.rows) {
    const columns = await sql<{ name: string; notnull: number; pk: number }>`
      SELECT name, [notnull], pk FROM pragma_table_info(${sql.lit(name)})
    `.execute(db);
    migrated.set(
      name,
      new Map(
        columns.rows.map((column) => [
          column.name,
          {
            nullable: column.notnull === 0 && column.pk === 0,
            optional: false,
          },
        ]),
      ),
    );
  }
  differences = compareSchemas(model, migrated);

  // Parse fixtures too: exercise inheritance, aliases, optional properties and
  // SELECT wrappers without paying AST work inside the timed assertion.
  const fixture = ts.createSourceFile(
    "fixture.ts",
    `
    type Nullable<T> = T | null;
    interface Base { removed: number; flipped: Generated<Nullable<number>> }
    interface Table extends Base { retained: ColumnType<string, string | null, null>; added?: JSONColumnType<{ value: null }> }
    interface Database { sample: Table }
  `,
    ts.ScriptTarget.Latest,
    true,
  );
  const parsed = parser.schema(fixture);
  const mutated = parsed.get("sample");
  if (!mutated) {
    throw new Error("Missing synthetic table");
  }
  mutated.delete("removed");
  mutation = compareSchemas(
    parsed,
    new Map([
      [
        "sample",
        new Map([
          ["removed", { nullable: false, optional: false }],
          ["flipped", { nullable: false, optional: false }],
          ["retained", { nullable: false, optional: false }],
        ]),
      ],
    ]),
  );
});

afterAll(async () => {
  await db?.destroy();
});

test("every Database table exists in SQLite", () => {
  expect(differences.missingTables, differences.missingTables.join("\n")).toEqual([]);
});
test("every migrated application table is typed", () => {
  expect(differences.untypedTables, differences.untypedTables.join("\n")).toEqual([]);
});
test("shared tables have exactly the same column names", () => {
  expect(differences.columns, differences.columns.join("\n")).toEqual([]);
});
test("SELECT nullability and approved optional properties match SQLite", () => {
  expect(differences.nullability, differences.nullability.join("\n")).toEqual([]);
  expect(differences.optional, differences.optional.join("\n")).toEqual([]);
});
test("comparison detects removed, added and nullable columns", () => {
  expect(mutation.columns).toEqual([
    "sample.removed: missing from TypeScript",
    "sample.added: missing from SQLite",
  ]);
  expect(mutation.nullability).toEqual(["sample.flipped: TS nullable=true, SQLite nullable=false"]);
  expect(mutation.optional).toEqual(["sample.added: unexpected optional property"]);
});
