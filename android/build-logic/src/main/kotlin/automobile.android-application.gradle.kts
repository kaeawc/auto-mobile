import com.android.build.api.dsl.ApplicationExtension
import org.gradle.api.JavaVersion
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.getByType

// Shared Android application defaults for control-proxy and playground/app, replacing the
// duplicated per-module DSL. Namespace, applicationId, versionCode, minification, Compose, lint
// disables, packaging and test options stay in each module. versionName comes from VERSION_NAME
// in android/gradle.properties, the one Android version scripts/versioning/bump-versions.sh writes.
pluginManager.apply("automobile.kotlin-common")

pluginManager.apply("com.android.application")

val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
val androidCompileSdk = libs.findVersion("build-android-compileSdk").get().requiredVersion.toInt()
val androidBuildTools = libs.findVersion("build-android-buildTools").get().requiredVersion
val androidMinSdk = libs.findVersion("build-android-minSdk").get().requiredVersion.toInt()
val androidTargetSdk = libs.findVersion("build-android-targetSdk").get().requiredVersion.toInt()
val javaTarget = libs.findVersion("build-java-target").get().requiredVersion
val appVersionName = providers.gradleProperty("VERSION_NAME").get()

extensions.configure<ApplicationExtension> {
  compileSdk = androidCompileSdk
  buildToolsVersion = androidBuildTools

  defaultConfig {
    minSdk = androidMinSdk
    targetSdk = androidTargetSdk
    versionName = appVersionName
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    getByName("release") {
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  lint {
    // AGP creates even empty missing baselines and aborts. Only attach a missing
    // path during explicit generation; clean modules keep no baseline file.
    baseline =
      file("lint-baseline.xml").takeIf {
        it.isFile || System.getProperty("lint.baselines.continue") == "true"
      }
    abortOnError = true
    warningsAsErrors = true
    checkDependencies = false
    // These checks compare against what is published upstream today (newer Gradle/AGP/library
    // versions, current target API), so their findings change over time and can never be
    // baselined stably. Dependabot owns version freshness.
    disable +=
      setOf(
        "AndroidGradlePluginVersion",
        "GradleDependency",
        "NewerVersionAvailable",
        "OldTargetApi",
      )
  }

  compileOptions {
    sourceCompatibility = JavaVersion.toVersion(javaTarget)
    targetCompatibility = JavaVersion.toVersion(javaTarget)
  }
}
