package dev.jasonpearson.automobile.buildlogic.apisignature

import dev.jasonpearson.automobile.buildlogic.api.SdkApiSignature
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.SetProperty
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

/**
 * Tracks a published library's public API with `javap -public -constants` over its compiled release
 * classes (BCV is incompatible with AGP 9). [ApiSignatureDumpTask] writes the baseline and
 * [ApiSignatureCheckTask] fails when the current API differs from it.
 */
abstract class ApiSignatureTask : DefaultTask() {
  @get:InputFiles
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val releaseClasses: ConfigurableFileCollection

  /** Packages whose classes form the tracked API; empty tracks every package. */
  @get:Input abstract val includedPackages: SetProperty<String>

  init {
    includedPackages.convention(emptySet())
  }

  protected fun generateApiSignature(): String {
    try {
      return SdkApiSignature(includedPackages = includedPackages.get())
        .generate(releaseClasses.files)
    } catch (error: IllegalStateException) {
      throw GradleException(error.message ?: "API signature generation failed", error)
    }
  }
}

abstract class ApiSignatureDumpTask : ApiSignatureTask() {
  @get:OutputFile abstract val apiFile: RegularFileProperty

  @TaskAction
  fun dump() {
    val signature = generateApiSignature()
    val output = apiFile.get().asFile
    output.parentFile.mkdirs()
    output.writeText(signature)
    logger.lifecycle("API dump written to ${output.name}")
  }
}

abstract class ApiSignatureCheckTask : ApiSignatureTask() {
  // InputFiles permits a missing baseline so the action can print the repair command.
  @get:InputFiles
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val baselineFiles: ConfigurableFileCollection

  /** The command that regenerates the baseline, printed when the check fails. */
  @get:Input abstract val dumpCommand: Property<String>

  @TaskAction
  fun check() {
    val expected = baselineFiles.singleFile
    val command = dumpCommand.get()
    if (!expected.exists()) {
      throw GradleException("API file ${expected.name} does not exist. Run $command first.")
    }
    val current = generateApiSignature()
    if (current != expected.readText()) {
      throw GradleException(
        "Public API has changed! Run $command to update the API file.\n" +
          "Expected file: ${expected.name}",
      )
    }
    logger.lifecycle("API check passed: public API matches ${expected.name}")
  }
}
