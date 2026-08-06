import com.vanniktech.maven.publish.MavenPublishBaseExtension
import org.gradle.api.publish.PublishingExtension
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

buildscript {
  dependencies {
    // Necessary if we are to override R8
    // classpath(libs.r8)
    classpath(libs.agp)
    classpath(libs.kgp)
  }
}

plugins {
  `version-catalog`
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.kotlin.serialization) apply false
  alias(libs.plugins.compose.compiler) apply false
  alias(libs.plugins.compose.hot.reload) apply false
  alias(libs.plugins.mavenPublish) apply false
  alias(libs.plugins.metro) apply false
  alias(libs.plugins.detekt) apply false
}

// Read version from gradle.properties
val versionName: String = property("VERSION_NAME") as String
val groupName: String = property("GROUP") as String

allprojects {
  group = groupName
  version = versionName
}

plugins.withId(libs.plugins.mavenPublish.get().pluginId) {
  if (project.path != ":compiler") {
    apply(plugin = "org.jetbrains.dokka")
  }

  // Configure vanniktech to publish to Maven Central with automatic release
  configure<MavenPublishBaseExtension> {
    publishToMavenCentral(automaticRelease = true)
    signAllPublications()
  }

  // configuration required to produce unique META-INF/*.kotlin_module file names
  tasks.withType<KotlinCompile>().configureEach {
    compilerOptions { moduleName.set(project.property("POM_ARTIFACT_ID") as String) }
  }
}

// Local file repository used only by the Maven publication manifest preflight
// (issue #4853). Publishing to it stages the exact set of files a release would
// upload to Maven Central -- primary artifacts, POM, Gradle module metadata,
// sources and javadoc jars, PGP signatures, and checksums -- into one directory
// so the preflight can enumerate them deterministically, without Maven Central
// credentials or a remote publish. It never uploads anywhere and has no effect on
// the real Central publication path (publishAllPublicationsToMavenCentral...).
allprojects {
  plugins.withId("com.vanniktech.maven.publish") {
    // Register only when the preflight asks for it (-PmavenManifestStaging). The
    // production `publish` lifecycle task depends on the publish task of EVERY
    // configured repository, so registering this unconditionally would make the
    // real release also write to the local repo. Gating keeps it off that path.
    if (providers.gradleProperty("mavenManifestStaging").isPresent) {
      configure<PublishingExtension> {
        repositories {
          maven {
            name = "centralManifest"
            url = rootProject.layout.buildDirectory.dir("central-manifest").get().asFile.toURI()
          }
        }
      }
    }
  }
}
