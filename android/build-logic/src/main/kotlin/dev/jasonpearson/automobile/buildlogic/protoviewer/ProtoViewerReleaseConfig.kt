package dev.jasonpearson.automobile.buildlogic.protoviewer

/**
 * Environment variable (or Gradle property) names for ProtoViewer's release inputs. They are
 * deliberately distinct from CtrlProxy's `RELEASE_KEYSTORE_*`: ProtoViewer ships with its own,
 * dedicated keystore (#14146), so rotating or losing one app's key never touches the other.
 */
object ProtoViewerInputNames {
  const val REQUIRE_RELEASE = "PROTOVIEWER_REQUIRE_RELEASE_SIGNING"
  const val RELEASE_VERSION = "PROTOVIEWER_RELEASE_VERSION"
  const val KEYSTORE_PATH = "PROTOVIEWER_KEYSTORE_PATH"
  const val KEYSTORE_PASSWORD = "PROTOVIEWER_KEYSTORE_PASSWORD"
  const val KEY_ALIAS = "PROTOVIEWER_KEY_ALIAS"
  const val KEY_PASSWORD = "PROTOVIEWER_KEY_PASSWORD"
}

/** Raw, possibly absent release inputs. Blank counts as absent. */
data class ProtoViewerReleaseInputs(
  val requireRelease: Boolean,
  val releaseVersion: String?,
  val keystorePath: String?,
  val keystorePassword: String?,
  val keyAlias: String?,
  val keyPassword: String?,
)

/** What a ProtoViewer release-variant build should use, or why it must not proceed. */
data class ProtoViewerReleasePlan(
  /** Failure messages; non-empty means the release build must fail before producing artifacts. */
  val errors: List<String>,
  val versionName: String?,
  val versionCode: Int,
  /** True when the release variant is signed with the dedicated release key. */
  val useReleaseKey: Boolean,
)

/**
 * Pure decision logic for the ProtoViewer release variant. Fail-closed: when [requireRelease] is
 * set (release workflows), any missing signing input or a version that is not plain
 * `MAJOR.MINOR.PATCH` is an error, so a misconfigured run can never publish a debug-signed or
 * `-SNAPSHOT` build. Without it (local and pull-request builds), an incomplete keystore falls back
 * to the debug key and a fixed [ProtoViewerVersioning.LOCAL_VERSION_CODE]. Debug builds never
 * consult this: they always use the debug key.
 */
object ProtoViewerReleaseConfig {
  fun plan(
    inputs: ProtoViewerReleaseInputs,
    keystoreExists: (String) -> Boolean,
  ): ProtoViewerReleasePlan {
    val errors = mutableListOf<String>()
    val missing =
      listOf(
          ProtoViewerInputNames.KEYSTORE_PATH to inputs.keystorePath,
          ProtoViewerInputNames.KEYSTORE_PASSWORD to inputs.keystorePassword,
          ProtoViewerInputNames.KEY_ALIAS to inputs.keyAlias,
          ProtoViewerInputNames.KEY_PASSWORD to inputs.keyPassword,
        )
        .filter { it.second.isNullOrBlank() }
        .map { it.first }
    val keystoreFound = !inputs.keystorePath.isNullOrBlank() && keystoreExists(inputs.keystorePath)
    val complete = missing.isEmpty() && keystoreFound
    if (inputs.requireRelease) {
      if (missing.isNotEmpty()) {
        errors.add(
          "ProtoViewer release signing is required (${ProtoViewerInputNames.REQUIRE_RELEASE}) " +
            "but these inputs are missing: ${missing.joinToString()}. " +
            "The release build would otherwise be signed with the debug key.",
        )
      } else if (!keystoreFound) {
        errors.add(
          "ProtoViewer release signing is required but ${ProtoViewerInputNames.KEYSTORE_PATH} " +
            "does not point to an existing keystore file.",
        )
      }
    }
    var versionName: String? = null
    var versionCode = ProtoViewerVersioning.LOCAL_VERSION_CODE
    val releaseVersion = inputs.releaseVersion?.trim().orEmpty()
    if (releaseVersion.isNotEmpty()) {
      try {
        versionCode = ProtoViewerVersioning.versionCode(releaseVersion)
        versionName = releaseVersion
      } catch (e: IllegalArgumentException) {
        errors.add("${ProtoViewerInputNames.RELEASE_VERSION}: ${e.message}")
      }
    } else if (inputs.requireRelease) {
      errors.add(
        "ProtoViewer release signing is required but ${ProtoViewerInputNames.RELEASE_VERSION} " +
          "is not set; it supplies the versionName and the derived versionCode.",
      )
    }
    return ProtoViewerReleasePlan(errors, versionName, versionCode, complete)
  }
}
