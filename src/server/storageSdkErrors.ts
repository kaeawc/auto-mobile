import { errorMessage } from "../utils/describeUnknownError";

const SDK_UNAVAILABLE_PREFIX =
  "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)";

/** Keep mutation guidance shared by iOS storage writes and sqlQuery. */
export const IOS_STORAGE_MUTATION_AUTHORIZATION_HINT =
  "in a DEBUG build, configure StorageInspectionConfiguration(allowMutations: true), call DatabaseInspector.shared.authorizeHostMutations(true), and require a launch-scoped mutation token or authorize the current SDK session with DatabaseInspector.shared.authorizeSessionMutations(sessionId:).";

type StorageSdkErrorContext = {
  operation: "database" | "storage";
  databasePath?: string;
};

type StorageSdkErrorCode =
  | "db_inspection_disabled"
  | "bad_request"
  | "unknown_database_path"
  | "unknown_table"
  | "multiple_statements_not_supported"
  | "mutation_not_authorized"
  | "encode_failed"
  | "response_too_large";

const SDK_ERROR_MESSAGES: Record<StorageSdkErrorCode, (context: StorageSdkErrorContext) => string> =
  {
    db_inspection_disabled: () => iosSdkSetupAdvice(),
    bad_request: () =>
      "The iOS SDK rejected the SQL request as bad_request. Check the database path and SQL query.",
    unknown_database_path: ({ databasePath }) =>
      `No registered database at ${JSON.stringify(databasePath ?? "unknown path")}. Use the absolute path reported by the app. List registered paths with the App Databases resource (automobile:devices/{deviceId}/databases?appId={appId}).`,
    unknown_table: () => "The requested database table was not found (unknown_table).",
    multiple_statements_not_supported: () => "The iOS SDK accepts one SQL statement per call.",
    mutation_not_authorized: ({ operation }) => {
      return operation === "database"
        ? `The database is read-only for the inspector. Writes and transaction control (BEGIN/COMMIT/ROLLBACK/SAVEPOINT) require mutation authorization. (${IOS_STORAGE_MUTATION_AUTHORIZATION_HINT})`
        : IOS_STORAGE_MUTATION_AUTHORIZATION_HINT;
    },
    encode_failed: () =>
      "The iOS SDK could not encode the database inspection response (encode_failed).",
    response_too_large: () =>
      "The database inspection response exceeded the SDK size limit (response_too_large).",
  };

const SDK_ERROR_CODES = Object.keys(SDK_ERROR_MESSAGES) as StorageSdkErrorCode[];
const SDK_ERROR_CODE_PATTERN = new RegExp(`(?:^|:\\s*)(${SDK_ERROR_CODES.join("|")})$`);
const UNKNOWN_SDK_ERROR_CODE_PATTERN = /(?:^|:\s*)([a-z][a-z0-9_]*)$/;

function isStorageSdkErrorCode(code: string): code is StorageSdkErrorCode {
  return SDK_ERROR_CODES.some((knownCode) => knownCode === code);
}

function sdkErrorCode(message: string): StorageSdkErrorCode | null {
  const code = SDK_ERROR_CODE_PATTERN.exec(message)?.[1];
  return code && isStorageSdkErrorCode(code) ? code : null;
}

/** Maps SDK storage errors using one code table for SQL and storage write paths. */
export function mapStorageSdkError(error: unknown, context: StorageSdkErrorContext): string | null {
  const message = errorMessage(error);
  const code =
    context.operation === "storage" && message.includes("mutation_not_authorized")
      ? "mutation_not_authorized"
      : sdkErrorCode(message);
  if (context.operation === "storage" && code !== "mutation_not_authorized") {
    return null;
  }
  return code ? SDK_ERROR_MESSAGES[code](context) : null;
}

function iosSdkSetupAdvice(): string {
  return "Failed to execute SQL on iOS. Ensure the app embeds the AutoMobile SDK in a DEBUG build and calls DatabaseInspector.shared.setEnabled(true).";
}

/** Converts an iOS SQL failure into a user message without double-wrapping SDK refusals. */
export function iosSqlErrorMessage(error: unknown, databasePath: string): string {
  const message = errorMessage(error);
  const prefix = `${SDK_UNAVAILABLE_PREFIX}: `;
  if (message.startsWith(prefix)) {
    const detail = message.slice(prefix.length);
    const code = sdkErrorCode(detail);
    if (code) {
      return SDK_ERROR_MESSAGES[code]({ operation: "database", databasePath });
    }
    if (/^HTTP \d{3}$/.test(detail) || !UNKNOWN_SDK_ERROR_CODE_PATTERN.test(detail)) {
      return iosSdkSetupAdvice();
    }
    return `The iOS SDK rejected the SQL request with an unrecognized error code: ${UNKNOWN_SDK_ERROR_CODE_PATTERN.exec(detail)?.[1] ?? detail}.`;
  }

  if (
    message === "Failed to connect to CtrlProxy" ||
    message.includes("does not expose the AutoMobile SDK capability database")
  ) {
    return iosSdkSetupAdvice();
  }

  return `Failed to execute SQL on iOS: ${message}`;
}
