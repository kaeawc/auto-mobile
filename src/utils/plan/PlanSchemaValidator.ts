import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import * as yaml from "js-yaml";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger";
import type { FileSystem } from "../filesystem/DefaultFileSystem";
import { PLAN_YAML_LOAD_OPTIONS } from "./planYaml";
import { clockInstantTextInWindow } from "../../models/DeviceClock";

/**
 * Result of plan validation
 */
interface PlanValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: string[];
}

/**
 * Structured validation error
 */
interface ValidationError {
  field: string;
  message: string;
  line?: number;
  column?: number;
}

type SchemaFileSystem = Pick<FileSystem, "readFile">;
const schemaFileSystem: SchemaFileSystem = {
  readFile: (filePath, encoding = "utf-8") => fs.readFile(filePath, encoding),
};

interface LoadedPlanSchema {
  schema: object;
  ajv: Ajv;
}

let schemaCache: Promise<LoadedPlanSchema> | undefined;

/** Test-only: isolate fake loads, then restore the previous populated cache. */
export function resetPlanSchemaCacheForTests(): () => void {
  const previous = schemaCache;
  schemaCache = undefined;
  return () => {
    schemaCache = previous;
  };
}

async function loadPlanSchema(fileSystem: SchemaFileSystem): Promise<LoadedPlanSchema> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  logger.info(`[PlanSchemaValidator] Loading schema from: ${__dirname}`);
  logger.info(`[PlanSchemaValidator] Current working directory: ${process.cwd()}`);
  logger.info(
    `[PlanSchemaValidator] GITHUB_WORKSPACE: ${process.env.GITHUB_WORKSPACE || "not set"}`,
  );

  // Try multiple paths to support different execution contexts:
  const possiblePaths = [
    ...new Set(
      [
        // From Bun bundle: dist/src/index.js -> dist/schemas/ (1 level up)
        path.join(__dirname, "../schemas/test-plan.schema.json"),
        // From Bun bundle: dist/src/index.js -> package root schemas/ (2 levels up)
        path.join(__dirname, "../../schemas/test-plan.schema.json"),
        // From source: src/utils/plan/PlanSchemaValidator.ts -> schemas/
        path.join(__dirname, "../../../schemas/test-plan.schema.json"),
        // From dist: dist/src/utils/plan/PlanSchemaValidator.js -> dist/schemas/
        path.join(__dirname, "../../../../schemas/test-plan.schema.json"),
        // From cwd (project root)
        path.join(process.cwd(), "schemas/test-plan.schema.json"),
        // From cwd/dist
        path.join(process.cwd(), "dist/schemas/test-plan.schema.json"),
        // From subdirectory - traverse up to find project root
        path.join(process.cwd(), "../../schemas/test-plan.schema.json"),
        path.join(process.cwd(), "../../../schemas/test-plan.schema.json"),
        path.join(process.cwd(), "../../../../schemas/test-plan.schema.json"),
        // From GitHub Actions workspace
        path.join(process.env.GITHUB_WORKSPACE || "", "schemas/test-plan.schema.json"),
        // From package root (when installed as npm package)
        path.join(__dirname, "../../../../../schemas/test-plan.schema.json"),
      ].map((candidate) => path.resolve(candidate)),
    ),
  ];

  let schemaContent: string | null = null;
  let schemaPath: string | null = null;
  const attemptedPaths: string[] = [];

  for (const tryPath of possiblePaths) {
    try {
      const resolvedPath = path.resolve(tryPath);
      attemptedPaths.push(resolvedPath);
      schemaContent = await fileSystem.readFile(resolvedPath, "utf-8");
      schemaPath = resolvedPath;
      logger.info(`[PlanSchemaValidator] ✓ Schema found at: ${schemaPath}`);
      break;
    } catch (error: any) {
      logger.debug(
        `[PlanSchemaValidator] ✗ Schema not found at: ${path.resolve(tryPath)} (${error.code})`,
      );
      // Missing or unreadable candidates are expected; try the next supported location.
    }
  }

  if (!schemaContent || !schemaPath) {
    const errorMessage = [
      "Could not find test-plan.schema.json.",
      `Current working directory: ${process.cwd()}`,
      `Module directory: ${__dirname}`,
      `GITHUB_WORKSPACE: ${process.env.GITHUB_WORKSPACE || "not set"}`,
      "Tried paths:",
      ...attemptedPaths.map((p) => `  - ${p}`),
    ].join("\n");

    logger.error(`[PlanSchemaValidator] ${errorMessage}`);
    throw new Error(errorMessage);
  }

  const schema = JSON.parse(schemaContent);
  const ajv = new Ajv({ allErrors: true, verbose: true, strict: false });
  // Bun installs ajv-formats' compatible Ajv v8 dependency separately from
  // our direct v8 dependency. They share the runtime plugin contract, but
  // TypeScript treats their class identities as distinct package instances.
  // eslint-disable-next-line auto-mobile/no-unknown-cast -- ajv-formats bundles a second compatible Ajv v8 type identity.
  addFormats(ajv as unknown as Parameters<typeof addFormats>[0]);
  ajv.addSchema(schema);
  return { schema, ajv };
}

/**
 * Validates AutoMobile test plan YAML files against JSON schema
 */
export class PlanSchemaValidator {
  private ajv!: Ajv;
  private schema: any;
  private schemaLoaded = false;
  // Ajv schema compilation (walking every $ref in the plan schema) is
  // expensive relative to validating a single document. `validateYaml` used
  // to call `this.ajv.compile(this.schema)` on every invocation; cache the
  // compiled validator after the first compile so repeated calls (as in a
  // long-lived daemon process, or a test file validating many plans) pay the
  // compile cost once instead of per call.
  private validateFn?: ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

  constructor(private readonly fileSystem: SchemaFileSystem = schemaFileSystem) {}

  /**
   * Check if schema has been loaded
   */
  isSchemaLoaded(): boolean {
    return this.schemaLoaded;
  }

  /**
   * Load the JSON schema for test plans
   */
  async loadSchema(): Promise<void> {
    if (!schemaCache) {
      const pending = loadPlanSchema(this.fileSystem);
      const shared = pending.then(undefined, (error: unknown) => {
        // Preserve the failure for the caller while allowing the next load to retry.
        if (schemaCache === shared) {
          schemaCache = undefined;
        }
        throw error;
      });
      schemaCache = shared;
    }
    const loaded = await schemaCache;
    this.schema = loaded.schema;
    this.ajv = loaded.ajv;
    this.schemaLoaded = true;
  }

  /**
   * Validate YAML content against the test plan schema
   * @param yamlContent YAML string to validate
   * @returns Validation result with errors if invalid
   * @throws Error if schema has not been loaded via loadSchema()
   */
  validateYaml(yamlContent: string): PlanValidationResult {
    if (!this.schemaLoaded) {
      throw new Error("Schema not loaded. Call loadSchema() first.");
    }
    // First, try to parse YAML
    let parsed: any;
    try {
      parsed = yaml.load(yamlContent, PLAN_YAML_LOAD_OPTIONS);
    } catch (error: any) {
      const line = error.mark?.line !== undefined ? error.mark.line + 1 : undefined;
      const column = error.mark?.column !== undefined ? error.mark.column + 1 : undefined;

      return {
        valid: false,
        errors: [
          {
            field: "root",
            message: `YAML parsing failed: ${error.message}`,
            line,
            column,
          },
        ],
      };
    }

    // Validate against schema (compiled once and cached; see `validateFn`).
    if (!this.validateFn) {
      this.validateFn = this.ajv.compile(this.schema);
    }
    const valid = this.validateFn(parsed);

    if (valid) {
      const errors = this.validateClockInstantWindows(parsed, yamlContent);
      return errors.length ? { valid: false, errors } : { valid: true };
    }

    // Format validation errors with line/column information
    const errors = this.formatErrors(this.validateFn.errors || [], yamlContent);

    return {
      valid: false,
      errors,
    };
  }

  /** Draft-07 networknt has no format bounds; both consumers compare normalized instants. */
  private validateClockInstantWindows(parsed: unknown, yamlContent: string): ValidationError[] {
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("steps" in parsed) ||
      !Array.isArray(parsed.steps)
    ) {
      return [];
    }
    return parsed.steps.flatMap((step: unknown, index): ValidationError[] => {
      if (
        !step ||
        typeof step !== "object" ||
        !("tool" in step) ||
        step.tool !== "setDeviceState"
      ) {
        return [];
      }
      const params = "params" in step ? step.params : undefined;
      const usesParams = params !== null && typeof params === "object" && "clock" in params;
      const clock = usesParams ? params.clock : "clock" in step ? step.clock : undefined;
      const field = `steps[${index}].${usesParams ? "params." : ""}clock.instant`;
      return this.validateClockInstantWindow(clock, field, yamlContent);
    });
  }

  private validateClockInstantWindow(
    clock: unknown,
    field: string,
    yamlContent: string,
  ): ValidationError[] {
    if (
      !clock ||
      typeof clock !== "object" ||
      !("mode" in clock) ||
      clock.mode !== "set" ||
      !("instant" in clock) ||
      typeof clock.instant !== "string"
    ) {
      return [];
    }
    if (clockInstantTextInWindow(clock.instant)) {
      return [];
    }
    return [
      {
        field,
        message:
          "Clock instant must be within 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z (inclusive, after offset normalization).",
        ...this.findLineNumber(yamlContent, field),
      },
    ];
  }

  /**
   * Validate a YAML file
   * @param filePath Path to YAML file
   * @returns Validation result
   */
  async validateFile(filePath: string): Promise<PlanValidationResult> {
    if (!this.schemaLoaded) {
      return {
        valid: false,
        errors: [
          {
            field: "schema",
            message: "Schema not loaded. Call loadSchema() first.",
          },
        ],
      };
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      return this.validateYaml(content);
    } catch (error: any) {
      return {
        valid: false,
        errors: [
          {
            field: "file",
            message: `Failed to read file: ${error.message}`,
          },
        ],
      };
    }
  }

  /**
   * Format AJV errors into structured validation errors
   */
  private formatErrors(ajvErrors: ErrorObject[], yamlContent: string): ValidationError[] {
    return ajvErrors.map((err) => {
      let field = err.instancePath || "root";

      // Remove leading slash
      if (field.startsWith("/")) {
        field = field.substring(1);
      }

      // Replace /steps/0 with steps[0]
      field = field.replace(/\/(\d+)/g, "[$1]").replace(/\//g, ".");

      const message = this.formatErrorMessage(err);

      // Try to find line number for the field in YAML
      const lineInfo = this.findLineNumber(yamlContent, field);

      return {
        field: field || "root",
        message,
        line: lineInfo?.line,
        column: lineInfo?.column,
      };
    });
  }

  private formatErrorMessage(err: ErrorObject): string {
    let message = err.message || "Validation error";

    // Enhanced error messages
    if (err.keyword === "additionalProperties") {
      const prop = (err.params as any).additionalProperty;
      message = `Unknown property '${prop}'. This might be a legacy field - check the migration guide.`;
    } else if (err.keyword === "required") {
      const missing = (err.params as any).missingProperty;
      message = `Missing required property '${missing}'`;
    } else if (err.keyword === "enum") {
      const allowed = (err.params as any).allowedValues;
      message = `Must be one of: ${allowed.join(", ")}`;
    } else if (err.keyword === "type") {
      const expectedType = (err.params as any).type;
      message = `Must be of type '${expectedType}', but got ${typeof err.data}`;
    } else if (err.keyword === "minItems") {
      const limit = (err.params as any).limit;
      message = `Must have at least ${limit} item${limit !== 1 ? "s" : ""}`;
    } else if (err.keyword === "minLength") {
      const limit = (err.params as any).limit;
      message = `Must be at least ${limit} character${limit !== 1 ? "s" : ""} long`;
    }

    return message;
  }

  /**
   * Attempt to find the line number of a field in YAML content
   * This is a best-effort approach using literal key matching
   */
  private findLineNumber(
    yamlContent: string,
    fieldPath: string,
  ): { line: number; column: number } | undefined {
    try {
      const lines = yamlContent.split("\n");
      const findField = (key: string): { line: number; column: number } | undefined => {
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trimStart();
          if (trimmed.startsWith(key) && trimmed.slice(key.length).trimStart().startsWith(":")) {
            return { line: i + 1, column: 1 };
          }
        }
        return undefined;
      };

      // Handle root-level fields
      if (!fieldPath.includes(".") && !fieldPath.includes("[")) {
        const found = findField(fieldPath);
        if (found) {
          return found;
        }
      }

      // Handle nested fields like "steps[0].tool" or "metadata.version"
      const parts = fieldPath.split(/[.\[\]]+/).filter((p) => p);

      // Try to find the deepest field we can locate
      for (let depth = parts.length; depth > 0; depth--) {
        const searchField = parts[depth - 1];

        // Skip numeric indices
        if (/^\d+$/.test(searchField)) {
          continue;
        }

        const found = findField(searchField);
        if (found) {
          return found;
        }
      }

      return undefined;
    } catch (error) {
      // Line locations are optional, so validation can continue without one.
      logger.warn("Could not locate plan validation error line", error);
      return undefined;
    }
  }
}
