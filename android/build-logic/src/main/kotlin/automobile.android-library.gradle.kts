import com.android.build.api.dsl.LibraryExtension
import org.gradle.api.JavaVersion
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.getByType

// Shared Android library defaults, replacing the duplicated per-module DSL.
// Namespace, Compose, lint disables, and extra test options stay in each module; libraries
// without an instrumentation runner can clear the default in their own DSL.
pluginManager.apply("automobile.kotlin-common")

pluginManager.apply("com.android.library")

val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
val androidCompileSdk = libs.findVersion("build-android-compileSdk").get().requiredVersion.toInt()
val androidBuildTools = libs.findVersion("build-android-buildTools").get().requiredVersion
val androidMinSdk = libs.findVersion("build-android-minSdk").get().requiredVersion.toInt()
val javaTarget = libs.findVersion("build-java-target").get().requiredVersion

extensions.configure<LibraryExtension> {
  compileSdk = androidCompileSdk
  buildToolsVersion = androidBuildTools

  defaultConfig {
    minSdk = androidMinSdk
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    consumerProguardFiles("consumer-rules.pro")
  }

  buildTypes {
    getByName("release") {
      isMinifyEnabled = false
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
