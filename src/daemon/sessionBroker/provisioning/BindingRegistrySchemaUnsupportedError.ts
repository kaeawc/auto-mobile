import { ActionableError } from "../../../models/ActionableError";

/** This daemon does not understand the schema written by a newer registry owner. */
export const BINDING_REGISTRY_SCHEMA_UNSUPPORTED_CODE = "registry_schema_unsupported";

export class BindingRegistrySchemaUnsupportedError extends ActionableError {
  readonly code = BINDING_REGISTRY_SCHEMA_UNSUPPORTED_CODE;
  readonly retryable = false;
  readonly remedy: string;

  constructor(
    readonly dbPath: string,
    readonly unknownMigrations: readonly string[],
    readonly writerVersions: Readonly<Record<string, string>> = {},
  ) {
    super(
      `The binding registry at ${dbPath} contains migrations unknown to this daemon: ` +
        `${unknownMigrations.join(", ")}; nothing was changed.`,
    );
    this.name = "BindingRegistrySchemaUnsupportedError";
    const versions = [...new Set(Object.values(writerVersions))];
    this.remedy =
      versions.length > 0
        ? `Upgrade the daemons sharing managed devices to a release that includes these migrations, recorded by writer version(s): ${versions.join(", ")}.`
        : "Upgrade the daemons sharing managed devices to a release that includes these migrations.";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      retryable: this.retryable,
      dbPath: this.dbPath,
      unknownMigrations: this.unknownMigrations,
      writerVersions: this.writerVersions,
      remedy: this.remedy,
    };
  }
}
