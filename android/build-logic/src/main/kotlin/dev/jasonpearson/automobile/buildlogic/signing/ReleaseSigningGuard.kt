package dev.jasonpearson.automobile.buildlogic.signing

/**
 * Decides whether a release build may proceed with the signing config it resolved.
 *
 * The shared app-signing convention silently falls back to the debug key when release keystore
 * inputs are incomplete. That is right for local and fork-PR builds, but a published asset must
 * never be debug-signed (#15301), so release workflows opt in to failing closed.
 */
object ReleaseSigningGuard {
  const val RELEASE_SIGNING_CONFIG_NAME = "release"

  /** Returns a failure message, or null when the build may proceed. */
  fun violation(required: Boolean, resolvedSigningConfigName: String): String? {
    if (!required || resolvedSigningConfigName == RELEASE_SIGNING_CONFIG_NAME) return null
    val resolved = resolvedSigningConfigName.ifBlank { "no signing config" }
    return "Release signing is required but the release build would be signed with '$resolved'. " +
      "Provide RELEASE_KEYSTORE_PATH (an existing keystore file), RELEASE_KEYSTORE_PASSWORD, " +
      "RELEASE_KEY_ALIAS and RELEASE_KEY_PASSWORD so the APK is not debug-signed."
  }
}
