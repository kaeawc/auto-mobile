import { ActionableError } from "../../../models/ActionableError";
import { BINDING_REGISTRY_SCHEMA_UNSUPPORTED_CODE } from "./refusal";

export class BindingRegistrySchemaUnsupportedError extends ActionableError {
  readonly code = BINDING_REGISTRY_SCHEMA_UNSUPPORTED_CODE;
  readonly retryable = false;

  constructor(
    readonly dbPath: string,
    readonly unknownMigrations: readonly string[],
  ) {
    super(
      `The binding registry at ${dbPath} contains migrations unknown to this daemon: ` +
        `${unknownMigrations.join(", ")}; nothing was changed.`,
    );
    this.name = "BindingRegistrySchemaUnsupportedError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      retryable: this.retryable,
      dbPath: this.dbPath,
      unknownMigrations: this.unknownMigrations,
    };
  }
}
