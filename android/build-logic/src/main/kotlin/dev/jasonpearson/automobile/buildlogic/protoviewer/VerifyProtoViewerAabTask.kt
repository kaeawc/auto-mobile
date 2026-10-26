package dev.jasonpearson.automobile.buildlogic.protoviewer

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

/** Verifies the built ProtoViewer AAB; all state comes from declared inputs. */
abstract class VerifyProtoViewerAabTask : DefaultTask() {
  @get:InputFile
  @get:PathSensitive(PathSensitivity.NONE)
  abstract val bundleFile: RegularFileProperty

  @get:Input abstract val requireReleaseSignature: Property<Boolean>

  @get:Input abstract val requireMapping: Property<Boolean>

  @get:OutputFile abstract val reportFile: RegularFileProperty

  @TaskAction
  fun verify() {
    val contents = ProtoViewerAabInspector.read(bundleFile.get().asFile)
    val violations =
      ProtoViewerAabInspector.violations(
        contents,
        requireReleaseSignature.get(),
        requireMapping.get(),
      )
    val report = reportFile.get().asFile
    report.parentFile.mkdirs()
    report.writeText(
      buildString {
        appendLine("ProtoViewer AAB: ${bundleFile.get().asFile.name}")
        appendLine("entries: ${contents.entryNames.size}")
        appendLine("signers: ${contents.signerSubjects.joinToString(" | ").ifEmpty { "none" }}")
        violations.forEach { appendLine("violation: $it") }
      },
    )
    if (violations.isNotEmpty()) {
      throw GradleException(
        "ProtoViewer AAB verification failed:\n${violations.joinToString("\n")}",
      )
    }
    logger.lifecycle("ProtoViewer AAB verification passed: ${contents.entryNames.size} entries")
  }
}

/** Fails a release build, before any compilation, when the resolved plan has errors. */
abstract class VerifyProtoViewerReleaseInputsTask : DefaultTask() {
  @get:Input abstract val errors: ListProperty<String>

  @TaskAction
  fun verify() {
    val found = errors.get()
    if (found.isNotEmpty()) throw GradleException(found.joinToString("\n"))
  }
}
