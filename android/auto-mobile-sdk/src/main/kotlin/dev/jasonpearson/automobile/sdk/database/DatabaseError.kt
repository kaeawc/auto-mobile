package dev.jasonpearson.automobile.sdk.database

/** Sealed class representing database inspection errors. */
sealed class DatabaseError(message: String) : Exception(message) {
  /** Database file was not found at the specified path. */
  class NotFound(path: String) : DatabaseError("Database not found: $path")

  /** Table was not found in the database. */
  class TableNotFound(table: String) : DatabaseError("Table not found: $table")

  /** SQL execution error. */
  class SqlError(cause: String) : DatabaseError("SQL error: $cause")

  /** DatabaseInspector was not initialized with a context. */
  class NotInitialized : DatabaseError("DatabaseInspector not initialized")

  /** A named application-provided driver was not registered. */
  class DriverNotFound(name: String) : DatabaseError("Database driver not found: $name")

  /** Database path is outside the app's data directory. */
  class InvalidPath(path: String) : DatabaseError("Invalid database path: $path")

  /** A mutating statement was rejected by the SDK capture policy. */
  class MutationNotAllowed : DatabaseError("Database mutations are disabled by SDK policy")
}
