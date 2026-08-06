import org.gradle.api.publish.PublishingExtension
import org.gradle.kotlin.dsl.configure

// Preflight-only local Maven repository (issue #4853). When `-PmavenManifestStaging`
// is set, publishing stages the exact release file set into
// <rootDir>/build/central-manifest so the manifest preflight can enumerate it
// deterministically -- no Maven Central credentials, no remote publish. The gate
// keeps this off the real release path, whose `publish` lifecycle would otherwise
// also write here.
//
// Resolving the staging dir from `rootDir` (build-level info) rather than the
// `rootProject` model keeps this Isolated-Projects safe; it is the same
// android/build/central-manifest directory the preflight script reads.
pluginManager.withPlugin("com.vanniktech.maven.publish") {
  if (providers.gradleProperty("mavenManifestStaging").isPresent) {
    extensions.configure<PublishingExtension> {
      repositories {
        maven {
          name = "centralManifest"
          url = rootDir.resolve("build/central-manifest").toURI()
        }
      }
    }
  }
}
