import com.android.build.api.dsl.ApplicationExtension
import org.gradle.api.JavaVersion
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.getByType

// Shared Android application defaults for control-proxy and playground/app, replacing the
// duplicated per-module DSL. Namespace, applicationId, versionCode, versionName, minification,
// Compose, lint disables, packaging and test options stay in each module (versionName is rewritten
// in place by scripts/versioning/bump-versions.sh, so its literal must stay in the module).
pluginManager.apply("automobile.kotlin-common")

pluginManager.apply("com.android.application")

val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
val androidCompileSdk = libs.findVersion("build-android-compileSdk").get().requiredVersion.toInt()
val androidBuildTools = libs.findVersion("build-android-buildTools").get().requiredVersion
val androidMinSdk = libs.findVersion("build-android-minSdk").get().requiredVersion.toInt()
val androidTargetSdk = libs.findVersion("build-android-targetSdk").get().requiredVersion.toInt()
val javaTarget = libs.findVersion("build-java-target").get().requiredVersion

extensions.configure<ApplicationExtension> {
  compileSdk = androidCompileSdk
  buildToolsVersion = androidBuildTools

  defaultConfig {
    minSdk = androidMinSdk
    targetSdk = androidTargetSdk
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
  }

  compileOptions {
    sourceCompatibility = JavaVersion.toVersion(javaTarget)
    targetCompatibility = JavaVersion.toVersion(javaTarget)
  }
}
