package dev.jasonpearson.automobile.buildlogic.baselineprofile

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

/**
 * Fails when a packaged APK lacks `assets/dexopt/baseline.prof` or the profile does not list the
 * app classes in [requiredClasses] (#17417). Library profiles alone still compile to a non-empty
 * file, so presence is not enough.
 */
@CacheableTask
abstract class VerifyApkBaselineProfileTask : DefaultTask() {
  /** The variant's `SingleArtifact.APK` output directory. */
  @get:InputDirectory
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val apkDirectory: DirectoryProperty

  /** Class descriptors such as `Lcom/example/MainActivity;` that must be in the profile. */
  @get:Input abstract val requiredClasses: ListProperty<String>

  @get:OutputFile abstract val reportFile: RegularFileProperty

  @TaskAction
  fun verify() {
    val apks =
      apkDirectory.get().asFile.walkTopDown().filter { it.isFile && it.extension == "apk" }.toList()
    if (apks.isEmpty()) throw GradleException("No APK found in ${apkDirectory.get().asFile}")
    val results = apks.associateWith { apk ->
      ApkBaselineProfile.violations(ApkBaselineProfile.read(apk), requiredClasses.get())
    }
    val report = reportFile.get().asFile
    report.parentFile.mkdirs()
    report.writeText(
      results.entries.joinToString("\n", postfix = "\n") { (apk, violations) ->
        "${apk.name}: ${if (violations.isEmpty()) "ok" else violations.joinToString("; ")}"
      },
    )
    val failures = results.filterValues { it.isNotEmpty() }
    if (failures.isNotEmpty()) {
      throw GradleException(
        "Baseline profile verification failed:\n" +
          failures.entries.joinToString("\n") { (apk, violations) ->
            "${apk.name}: ${violations.joinToString("; ")}"
          },
      )
    }
    logger.lifecycle("Baseline profile verification passed for ${apks.joinToString { it.name }}")
  }
}
