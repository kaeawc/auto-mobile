import { errorMessage } from "../utils/describeUnknownError";

const SDK_UNAVAILABLE_PREFIX =
  "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)";

export const IOS_STORAGE_NOT_FOREGROUND_MESSAGE =
  "The target app is not in the foreground; bring it to the foreground and retry.";

const IOS_DATABASE_CAPABILITY_UNAVAILABLE_MESSAGE =
  "The target app is either not in the foreground (bring it to the foreground and retry) or does not embed the AutoMobile SDK in a DEBUG build with DatabaseInspector.shared.setEnabled(true).";

// Match only CtrlProxy's two storage foreground gates, including the complete app id slot.
const IOS_STORAGE_FOREGROUND_GATE_PATTERN =
  /^(?:Database inspection requires requested appId|iOS key-value storage requires) \S+ to be the foreground app$/;

/** Map identifiable foreground failures and the ambiguous database capability gate. */
export function iosStorageErrorMessage(error: unknown): string | null {
  const message = errorMessage(error);
  if (
    sdkErrorCode(message) === "app_not_active" ||
    IOS_STORAGE_FOREGROUND_GATE_PATTERN.test(message)
  ) {
    return IOS_STORAGE_NOT_FOREGROUND_MESSAGE;
  }
  if (
    message === "The foreground iOS app does not expose the AutoMobile SDK capability database."
  ) {
    return IOS_DATABASE_CAPABILITY_UNAVAILABLE_MESSAGE;
  }
  return null;
}

/** Keep mutation guidance shared by iOS storage writes and sqlQuery. */
export const IOS_STORAGE_MUTATION_AUTHORIZATION_HINT =
  "in a DEBUG build, configure StorageInspectionConfiguration(allowMutations: true), call DatabaseInspector.shared.authorizeHostMutations(true), and require a launch-scoped mutation token or authorize the current SDK session with DatabaseInspector.shared.authorizeSessionMutations(sessionId:).";

type StorageSdkErrorContext = {
  operation: "database" | "storage";
  databasePath?: string;
  action?: "set" | "remove" | "clear";
};

type StorageSdkErrorCode =
  | "app_not_active"
  | "db_inspection_disabled"
  | "bad_request"
  | "unknown_database_path"
  | "unknown_table"
  | "multiple_statements_not_supported"
  | "invalid_store_name"
  | "write_verification_failed"
  | "mutation_not_authorized"
  | "busy_lock"
  | "encode_failed"
  | "response_too_large";

const SDK_ERROR_MESSAGES: Record<StorageSdkErrorCode, (context: StorageSdkErrorContext) => string> =
  {
    app_not_active: () => IOS_STORAGE_NOT_FOREGROUND_MESSAGE,
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
    busy_lock: () =>
      "The app is holding a lock on the database and the iOS SDK gave up waiting (busy_lock). The request was not applied; retry in a moment.",
    invalid_store_name: () =>
      "The iOS SDK could not open that key-value store name (invalid_store_name). Use an empty name, \"standard\" (any case) or the app's bundle id for the app's standard UserDefaults; any other name must be a valid UserDefaults suite name with no leading or trailing whitespace (the global domain is not allowed).",
    write_verification_failed: ({ action }) => {
      const detail =
        action === "set"
          ? "the key was absent or its value or type did not match"
          : action === "remove"
            ? "the key was still present"
            : "one or more prior keys were still present";
      return action
        ? `The iOS SDK could not confirm the ${action} in the store's persistent domain (write_verification_failed): ${detail}. Check the store name and key.`
        : "The iOS SDK could not confirm the requested mutation in the store's persistent domain (write_verification_failed). Check the store name and affected keys.";
    },
    encode_failed: () =>
      "The iOS SDK could not encode the database inspection response (encode_failed).",
    response_too_large: () =>
      "The database inspection response exceeded the SDK size limit (response_too_large).",
  };

const STORAGE_ERROR_CODES = new Set<StorageSdkErrorCode>([
  "app_not_active",
  "mutation_not_authorized",
  "invalid_store_name",
  "write_verification_failed",
]);

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
  const mapped = iosStorageErrorMessage(error);
  if (mapped) {
    return mapped;
  }
  const message = errorMessage(error);
  const code =
    context.operation === "storage" && message.includes("mutation_not_authorized")
      ? "mutation_not_authorized"
      : sdkErrorCode(message);
  if (context.operation === "storage" && (!code || !STORAGE_ERROR_CODES.has(code))) {
    return null;
  }
  return code ? SDK_ERROR_MESSAGES[code](context) : null;
}

function iosSdkSetupAdvice(): string {
  return "Failed to execute SQL on iOS. Ensure the app embeds the AutoMobile SDK in a DEBUG build and calls DatabaseInspector.shared.setEnabled(true).";
}

// Fragment of CtrlProxy's `SdkDatabaseError.indeterminateMessage`: the runner sent `/db/execute` to the
// SDK and stopped waiting for the answer. The runner cannot tell a read from a write, so it always
// warns that a write may have been applied.
const IOS_SQL_NO_ANSWER_FRAGMENT = "the outcome is indeterminate";

const IOS_SQL_READ_TIMEOUT_MESSAGE =
  "Failed to execute SQL on iOS: the read-only query got no answer from the app in time. It does not change data, so it is safe to retry.";

type IosSqlErrorOptions = {
  /** The statement the host sent is a single read-only query, so an unanswered request changed nothing. */
  readOnlyQuery?: boolean;
};

/**
 * Converts an iOS SQL failure into a user message without double-wrapping SDK refusals. Only the host
 * knows it sent a read, so only it can word an unanswered read as retryable; a mutation keeps the
 * runner's "do not retry" wording.
 */
export function iosSqlErrorMessage(
  error: unknown,
  databasePath: string,
  options: IosSqlErrorOptions = {},
): string {
  if (options.readOnlyQuery && errorMessage(error).includes(IOS_SQL_NO_ANSWER_FRAGMENT)) {
    return IOS_SQL_READ_TIMEOUT_MESSAGE;
  }
  return mapIosSqlError(error, databasePath);
}

function mapIosSqlError(error: unknown, databasePath: string): string {
  const mapped = iosStorageErrorMessage(error);
  if (mapped) {
    return mapped === IOS_DATABASE_CAPABILITY_UNAVAILABLE_MESSAGE
      ? `Failed to execute SQL on iOS. ${mapped}`
      : mapped;
  }
  const message = errorMessage(error);
  // The runner reports a busy database without the "embed the SDK" wrapper: the SDK did answer.
  if (sdkErrorCode(message) === "busy_lock") {
    return SDK_ERROR_MESSAGES.busy_lock({ operation: "database", databasePath });
  }
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

  if (message === "Failed to connect to CtrlProxy") {
    return iosSdkSetupAdvice();
  }

  return `Failed to execute SQL on iOS: ${message}`;
}
