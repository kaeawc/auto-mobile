import { ActionableError } from "../../../models/ActionableError";

/** This daemon does not understand the schema written by a newer registry owner. */
export const BINDING_REGISTRY_SCHEMA_UNSUPPORTED_CODE = "registry_schema_unsupported";

export class BindingRegistrySchemaUnsupportedError extends ActionableError {
  readonly code = BINDING_REGISTRY_SCHEMA_UNSUPPORTED_CODE;
  readonly retryable = false;
  readonly remedy =
    "Upgrade the daemons sharing managed devices to a release that includes these migrations.";

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
      remedy: this.remedy,
    };
  }
}
