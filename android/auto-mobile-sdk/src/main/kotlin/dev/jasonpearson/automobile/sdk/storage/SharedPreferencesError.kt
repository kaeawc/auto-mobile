package dev.jasonpearson.automobile.sdk.storage

/** Sealed class representing SharedPreferences inspection errors. */
sealed class SharedPreferencesError(message: String) : Exception(message) {
  /** Preferences file was not found. */
  class FileNotFound(fileName: String) :
    SharedPreferencesError("Preferences file not found: $fileName")

  /** Path is outside the app's data directory. */
  class InvalidPath(path: String) : SharedPreferencesError("Invalid preferences path: $path")

  /** SharedPreferencesInspector was not initialized with a context. */
  class NotInitialized :
    SharedPreferencesError(
      "SharedPreferencesInspector not initialized. Call AutoMobileSDK.initialize(context) first."
    )

  /** A named application-provided driver was not registered. */
  class DriverNotFound(name: String) : SharedPreferencesError("Storage driver not found: $name")

  /** Error reading preferences. */
  class ReadError(cause: String) : SharedPreferencesError("Read error: $cause")

  /** Invalid type for value. */
  class InvalidType(type: String, reason: String) :
    SharedPreferencesError("Invalid type $type: $reason")

  /** A mutating operation was rejected by the SDK capture policy. */
  class MutationNotAllowed :
    SharedPreferencesError("SharedPreferences mutations are disabled by SDK policy")

  /**
   * The edit was applied in memory but the preferences file could not be written to disk (disk
   * full, I/O error, read-only data directory). Internal so the module's public API is unchanged;
   * it reaches the wire as `errorType` "WriteFailed" through the provider's existing
   * [SharedPreferencesError] handler.
   */
  internal class WriteFailed(fileName: String) :
    SharedPreferencesError("Failed to write preferences file to disk: $fileName")
}
