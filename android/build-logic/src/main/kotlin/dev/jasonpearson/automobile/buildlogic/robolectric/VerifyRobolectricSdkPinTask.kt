package dev.jasonpearson.automobile.buildlogic.robolectric

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

abstract class VerifyRobolectricSdkPinTask : DefaultTask() {
  @get:InputFiles
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val testFiles: ConfigurableFileCollection

  @get:Internal abstract val moduleDir: DirectoryProperty

  @get:Input @get:Optional abstract val targetSdk: Property<Int>
  @get:Input abstract val minSdk: Property<Int>
  @get:Input abstract val includeAndroidResources: Property<Boolean>
  @get:Input abstract val maxSupportedSdk: Property<Int>

  @TaskAction
  fun verify() {
    val violations = mutableListOf<String>()
    val primary = "src/test/resources/robolectric.properties"
    val files = testFiles.files.sortedBy { it.path }
    for (file in files) {
      val relative = moduleDir.get().asFile.toPath().relativize(file.toPath()).toString()
      if (file.name == "robolectric.properties") {
        violations +=
          RobolectricSdkPins.propertiesViolations(
            file.readText(),
            relative,
            minSdk.get(),
            maxSupportedSdk.get(),
            relative == primary,
          )
      } else {
        violations +=
          RobolectricSdkPins.sourceViolations(file.readText(), relative, maxSupportedSdk.get())
      }
    }
    if (files.none { it.path.endsWith(primary) }) {
      violations +=
        RobolectricSdkPins.violations(
          null,
          targetSdk.orNull,
          minSdk.get(),
          includeAndroidResources.get(),
          maxSupportedSdk.get(),
        )
    }
    if (violations.isNotEmpty()) {
      throw GradleException(
        "Robolectric SDK pin verification failed:\n${violations.joinToString("\n")}",
      )
    }
  }
}
