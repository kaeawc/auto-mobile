import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.api.plugins.JavaBasePlugin
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.getByType
import org.gradle.kotlin.dsl.withType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

// Shared Kotlin compiler configuration for every Kotlin module (JVM and Android).
// This is the single source of truth for the language version, JVM target, the
// opt-in list, and the Java toolchain -- previously duplicated in the root
// `subprojects {}` block and re-declared in individual module build files.

val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
val kotlinLanguageVersion = libs.findVersion("build-kotlin-language").get().requiredVersion
val javaTarget = libs.findVersion("build-java-target").get().requiredVersion

// Pin compilation and unit tests to the Java toolchain so `./gradlew` works
// regardless of the developer's default JDK. Robolectric cannot instrument newer
// JDK bytecode (e.g. JDK 26), so without this a newer default JDK breaks the
// Android unit tests. AGP registers JavaPluginExtension for Android modules too,
// so this one hook covers both JVM and Android; KGP picks up the Java toolchain.
plugins.withType<JavaBasePlugin>().configureEach {
  extensions.configure<JavaPluginExtension> {
    toolchain { languageVersion.set(JavaLanguageVersion.of(javaTarget.toInt())) }
  }
}

tasks.withType<KotlinCompile>().configureEach {
  compilerOptions {
    languageVersion.set(KotlinVersion.fromVersion(kotlinLanguageVersion))
    jvmTarget.set(JvmTarget.fromTarget(javaTarget))
    // addAll (not assignment) so plugin-contributed args -- Compose, Metro, explicit
    // API, -Xallow-unstable-dependencies, etc. -- are preserved.
    freeCompilerArgs.addAll(
      "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
      "-opt-in=androidx.media3.common.util.UnstableApi",
      "-opt-in=kotlin.time.ExperimentalTime,kotlin.RequiresOptIn",
      "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
      "-opt-in=kotlin.ExperimentalUnsignedTypes",
      "-opt-in=kotlin.time.ExperimentalTime",
      "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
      "-opt-in=kotlinx.coroutines.FlowPreview",
    )
  }
}
