import com.android.build.api.dsl.ApplicationExtension
import java.io.File
import org.gradle.kotlin.dsl.configure

// Shared release-signing convention for AutoMobile's Android application modules
// (control-proxy and playground/app), replacing the byte-identical signing block
// each carried. Keystore coordinates come from the environment (CI) or
// gradle.properties (local); when a complete keystore is present the release cert
// is used, otherwise both build types fall back to debug signing — behavior
// identical to the per-module blocks this replaces. Keystore paths resolve
// against rootDir (build-level info, Isolated-Projects safe) rather than the
// rootProject model. isMinifyEnabled/proguardFiles stay in the modules.

val releaseStoreFilePath: String? =
  System.getenv("RELEASE_KEYSTORE_PATH") ?: findProperty("RELEASE_KEYSTORE_PATH") as String?
val releaseStorePassword: String? =
  System.getenv("RELEASE_KEYSTORE_PASSWORD") ?: findProperty("RELEASE_KEYSTORE_PASSWORD") as String?
val releaseKeyAlias: String? =
  System.getenv("RELEASE_KEY_ALIAS") ?: findProperty("RELEASE_KEY_ALIAS") as String?
val releaseKeyPassword: String? =
  System.getenv("RELEASE_KEY_PASSWORD") ?: findProperty("RELEASE_KEY_PASSWORD") as String?
val releaseStoreFile: File? = releaseStoreFilePath?.let { path ->
  val file = File(path)
  if (file.isAbsolute) file else rootDir.resolve(path)
}
val hasReleaseSigning =
  releaseStoreFile?.exists() == true &&
    !releaseStorePassword.isNullOrBlank() &&
    !releaseKeyAlias.isNullOrBlank() &&
    !releaseKeyPassword.isNullOrBlank()

pluginManager.withPlugin("com.android.application") {
  extensions.configure<ApplicationExtension> {
    signingConfigs {
      create("release") {
        storeFile = releaseStoreFile
        storePassword = releaseStorePassword
        keyAlias = releaseKeyAlias
        keyPassword = releaseKeyPassword
      }
    }
    buildTypes {
      getByName("release") {
        signingConfig =
          if (hasReleaseSigning) {
            signingConfigs.getByName("release")
          } else {
            signingConfigs.getByName("debug")
          }
      }
      getByName("debug") {
        signingConfig =
          if (hasReleaseSigning) {
            signingConfigs.getByName("release")
          } else {
            signingConfigs.getByName("debug")
          }
      }
    }
  }
}
