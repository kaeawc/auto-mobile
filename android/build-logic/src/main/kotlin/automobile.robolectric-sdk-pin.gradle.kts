import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.dsl.LibraryExtension
import com.android.build.api.variant.AndroidComponentsExtension
import dev.jasonpearson.automobile.buildlogic.robolectric.VerifyRobolectricSdkPinTask
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.api.tasks.testing.Test
import org.gradle.kotlin.dsl.getByType

val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
val robolectricMaxSdk = libs.findVersion("build-robolectric-maxSdk").get().requiredVersion.toInt()

val verifyRobolectricSdkPin =
  tasks.register<VerifyRobolectricSdkPinTask>("verifyRobolectricSdkPin") {
    testFiles.from(
      fileTree(projectDir) {
        include(
          "src/test*/**/*.kt",
          "src/test*/**/*.java",
          "src/test*/resources/**/robolectric.properties",
        )
      },
    )
    moduleDir.set(layout.projectDirectory)
    maxSupportedSdk.set(robolectricMaxSdk)
    minSdk.set(1)
    includeAndroidResources.set(false)
  }

tasks.matching { it.name == "check" }.configureEach { dependsOn(verifyRobolectricSdkPin) }

tasks.withType<Test>().configureEach { dependsOn(verifyRobolectricSdkPin) }

pluginManager.withPlugin("com.android.application") {
  extensions.configure<AndroidComponentsExtension<ApplicationExtension, *, *>>(
    "androidComponents",
  ) {
    finalizeDsl { androidDsl ->
      val moduleTargetSdk = androidDsl.defaultConfig.targetSdk
      val moduleMinSdk = androidDsl.defaultConfig.minSdk
      val moduleIncludesResources = androidDsl.testOptions.unitTests.isIncludeAndroidResources
      verifyRobolectricSdkPin.configure {
        if (moduleTargetSdk != null) targetSdk.set(moduleTargetSdk)
        minSdk.set(moduleMinSdk ?: 1)
        includeAndroidResources.set(moduleIncludesResources)
      }
    }
  }
}

pluginManager.withPlugin("com.android.library") {
  extensions.configure<AndroidComponentsExtension<LibraryExtension, *, *>>("androidComponents") {
    finalizeDsl { androidDsl ->
      val moduleMinSdk = androidDsl.defaultConfig.minSdk
      val moduleIncludesResources = androidDsl.testOptions.unitTests.isIncludeAndroidResources
      verifyRobolectricSdkPin.configure {
        minSdk.set(moduleMinSdk ?: 1)
        includeAndroidResources.set(moduleIncludesResources)
      }
    }
  }
}
