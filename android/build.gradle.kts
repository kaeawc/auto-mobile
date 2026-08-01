import com.vanniktech.maven.publish.MavenPublishBaseExtension
import dev.detekt.gradle.extensions.DetektExtension
import org.gradle.api.plugins.JavaBasePlugin
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.publish.PublishingExtension
import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
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

val gradleWorkerJvmArgs = providers.gradleProperty("org.gradle.testWorker.jvmargs").get()

subprojects {
  pluginManager.withPlugin("org.jetbrains.kotlin.jvm") { apply(plugin = "dev.detekt") }
  pluginManager.withPlugin("org.jetbrains.kotlin.android") { apply(plugin = "dev.detekt") }
  pluginManager.withPlugin("com.android.application") { apply(plugin = "dev.detekt") }
  pluginManager.withPlugin("com.android.library") { apply(plugin = "dev.detekt") }
  pluginManager.withPlugin("dev.detekt") {
    extensions.configure<DetektExtension> {
      config.setFrom(rootProject.files("config/detekt/detekt.yml"))
      buildUponDefaultConfig = true
      // Analyze files across threads within a single detekt task. Gradle's
      // org.gradle.parallel only parallelizes across projects, so without this a
      // large module analyzes single-threaded.
      parallel = true
      // On Android modules `detektMain` fans out to one task per build type, so
      // `release` re-analyzes the exact same `main` sources `debug` already
      // covered -- no module has a `src/release` source set, and the only
      // build-type source set in the project is `auto-mobile-sdk/src/debug`.
      // Skipping release halves the Android analysis and, more importantly,
      // avoids compiling the release variant classpath purely to feed detekt.
      ignoredBuildTypes = listOf("release")
    }
  }

  tasks.withType<Test>().configureEach {
    jvmArgs(gradleWorkerJvmArgs.split(" ").filter { it.isNotBlank() })
  }

  plugins.withId("java") {
    apply(plugin = "jacoco")
    tasks.withType<JacocoReport> {
      reports {
        xml.required.set(true)
        html.required.set(false)
      }
    }
  }

  plugins.withId("com.android.application") {
    configure<com.android.build.api.dsl.ApplicationExtension> {
      buildTypes { getByName("debug") { enableUnitTestCoverage = true } }
    }
  }

  plugins.withId("com.android.library") {
    configure<com.android.build.api.dsl.LibraryExtension> {
      buildTypes { getByName("debug") { enableUnitTestCoverage = true } }
    }
  }

  tasks.withType<KotlinCompile>().configureEach {
    compilerOptions {
      languageVersion.set(
        KotlinVersion.valueOf(
          "KOTLIN_${libs.versions.build.kotlin.language.get().replace(".", "_")}"
        )
      )
      jvmTarget.set(JvmTarget.valueOf("JVM_${libs.versions.build.java.target.get()}"))
      freeCompilerArgs.addAll(
        listOf(
          "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
          "-opt-in=androidx.media3.common.util.UnstableApi",
          "-opt-in=kotlin.time.ExperimentalTime,kotlin.RequiresOptIn",
          "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
          "-opt-in=kotlin.ExperimentalUnsignedTypes",
          "-opt-in=kotlin.time.ExperimentalTime",
          "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
          "-opt-in=kotlinx.coroutines.FlowPreview",
        )
      )
    }
  }

  // Pin compilation and unit tests to the Java toolchain (the java.target catalog value, 21) so
  // `./gradlew` works regardless of the developer's default JDK. Robolectric cannot instrument
  // newer JDK bytecode (e.g. JDK 26), so without this a newer default JDK breaks the Android unit
  // tests. CI already runs on JDK 21; the foojay resolver (settings.gradle.kts) supplies the JDK.
  plugins.withType<JavaBasePlugin>().configureEach {
    extensions.configure<JavaPluginExtension> {
      toolchain {
        languageVersion.set(JavaLanguageVersion.of(libs.versions.build.java.target.get().toInt()))
      }
    }
  }
}
