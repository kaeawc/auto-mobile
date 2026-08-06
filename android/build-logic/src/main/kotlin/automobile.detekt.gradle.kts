import dev.detekt.gradle.extensions.DetektExtension
import org.gradle.kotlin.dsl.configure

// Applies and configures detekt for every Kotlin/Android module. Replaces the
// root `subprojects {}` detekt wiring so no cross-project configuration remains
// (a prerequisite for Gradle Isolated Projects).
listOf(
    "org.jetbrains.kotlin.jvm",
    "org.jetbrains.kotlin.android",
    "com.android.application",
    "com.android.library",
  )
  .forEach { pluginId -> pluginManager.withPlugin(pluginId) { pluginManager.apply("dev.detekt") } }

pluginManager.withPlugin("dev.detekt") {
  extensions.configure<DetektExtension> {
    // Resolve the shared config from the root project directory without touching
    // the rootProject model (rootDir is build-level info, Isolated-Projects safe).
    config.setFrom(files(rootDir.resolve("config/detekt/detekt.yml")))
    buildUponDefaultConfig = true
    // Analyze files across threads within a single detekt task. Gradle's
    // org.gradle.parallel only parallelizes across projects, so without this a
    // large module analyzes single-threaded.
    parallel = true
    // On Android modules `detektMain` fans out to one task per build type, so
    // `release` re-analyzes the same `main` sources `debug` already covered.
    // Skipping release halves Android analysis and avoids compiling the release
    // variant classpath purely to feed detekt.
    ignoredBuildTypes = listOf("release")
  }
}
