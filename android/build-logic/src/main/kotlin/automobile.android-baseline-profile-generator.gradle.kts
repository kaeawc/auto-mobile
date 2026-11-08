import com.android.build.api.dsl.TestExtension
import org.gradle.api.JavaVersion
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.getByType

// Shared defaults for a Macrobenchmark baseline-profile producer (a com.android.test module whose
// targetProjectPath is the app). Namespace and targetProjectPath stay in the module. The app
// applies `androidx.baselineprofile` itself and declares `baselineProfile(<this module>)`.
pluginManager.apply("automobile.kotlin-common")

pluginManager.apply("com.android.test")

pluginManager.apply("androidx.baselineprofile")

val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
val androidCompileSdk = libs.findVersion("build-android-compileSdk").get().requiredVersion.toInt()
val androidBuildTools = libs.findVersion("build-android-buildTools").get().requiredVersion
val androidTargetSdk = libs.findVersion("build-android-targetSdk").get().requiredVersion.toInt()
val javaTarget = libs.findVersion("build-java-target").get().requiredVersion

// Baseline profile collection needs API 28+ (rooted) or 33+; Macrobenchmark refuses lower.
val baselineProfileMinSdk = 28

extensions.configure<TestExtension> {
  compileSdk = androidCompileSdk
  buildToolsVersion = androidBuildTools

  defaultConfig {
    minSdk = baselineProfileMinSdk
    targetSdk = androidTargetSdk
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.toVersion(javaTarget)
    targetCompatibility = JavaVersion.toVersion(javaTarget)
  }
}
