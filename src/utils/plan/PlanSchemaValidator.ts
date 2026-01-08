import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import yaml from "js-yaml";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Result of plan validation
 */
export interface PlanValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: string[];
}

/**
 * Structured validation error
 */
export interface ValidationError {
  field: string;
  message: string;
  line?: number;
  column?: number;
}

/**
 * Validates AutoMobile test plan YAML files against JSON schema
 */
export class PlanSchemaValidator {
  private ajv: Ajv;
  private schema: any;

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false
    });
    addFormats(this.ajv);
  }

  /**
   * Load the JSON schema for test plans
   */
  async loadSchema(): Promise<void> {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // Try multiple paths to support different execution contexts:
    // 1. From source: src/utils/plan/PlanSchemaValidator.ts -> schemas/
    // 2. From dist: dist/src/utils/plan/PlanSchemaValidator.js -> dist/schemas/
    // 3. From npm package root
    const possiblePaths = [
      path.join(__dirname, "../../../schemas/test-plan.schema.json"),  // From source
      path.join(__dirname, "../../../../schemas/test-plan.schema.json"), // From dist (one more level up)
      path.join(process.cwd(), "schemas/test-plan.schema.json"),        // From cwd
      path.join(process.cwd(), "dist/schemas/test-plan.schema.json"),   // From cwd/dist
    ];

    let schemaContent: string | null = null;
    let schemaPath: string | null = null;

    for (const tryPath of possiblePaths) {
      try {
        schemaContent = await fs.readFile(tryPath, "utf-8");
        schemaPath = tryPath;
        break;
      } catch {
        // Try next path
      }
    }

    if (!schemaContent || !schemaPath) {
      throw new Error(
        `Could not find test-plan.schema.json. Tried paths:\n${possiblePaths.join("\n")}`
      );
    }

    this.schema = JSON.parse(schemaContent);

    // Add schema to ajv
    this.ajv.addSchema(this.schema);
  }

  /**
   * Validate YAML content against the test plan schema
   * @param yamlContent YAML string to validate
   * @returns Validation result with errors if invalid
   */
  validateYaml(yamlContent: string): PlanValidationResult {
    // First, try to parse YAML
    let parsed: any;
    try {
      parsed = yaml.load(yamlContent);
    } catch (error: any) {
      return {
        valid: false,
        errors: [{
          field: "root",
          message: `YAML parsing failed: ${error.message}`,
          line: error.mark?.line,
          column: error.mark?.column
        }]
      };
    }

    // Validate against schema
    const validate = this.ajv.compile(this.schema);
    const valid = validate(parsed);

    if (valid) {
      return { valid: true };
    }

    // Format validation errors
    const errors = this.formatErrors(validate.errors || []);

    return {
      valid: false,
      errors
    };
  }

  /**
   * Validate a YAML file
   * @param filePath Path to YAML file
   * @returns Validation result
   */
  async validateFile(filePath: string): Promise<PlanValidationResult> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return this.validateYaml(content);
    } catch (error: any) {
      return {
        valid: false,
        errors: [{
          field: "file",
          message: `Failed to read file: ${error.message}`
        }]
      };
    }
  }

  /**
   * Format AJV errors into structured validation errors
   */
  private formatErrors(ajvErrors: ErrorObject[]): ValidationError[] {
    return ajvErrors.map(err => {
      let field = err.instancePath || "root";

      // Remove leading slash
      if (field.startsWith("/")) {
        field = field.substring(1);
      }

      // Replace /steps/0 with steps[0]
      field = field.replace(/\/(\d+)/g, "[$1]").replace(/\//g, ".");

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
      }

      return {
        field: field || "root",
        message
      };
    });
  }
}
