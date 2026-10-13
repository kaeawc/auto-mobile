package dev.jasonpearson.automobile.buildlogic.r8

import java.io.File
import java.util.jar.JarFile
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.Directory
import org.gradle.api.file.RegularFile
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Classpath
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

/** All execution state comes from declared inputs; no Project access during task execution. */
@CacheableTask
abstract class VerifyR8KeptClassesTask : DefaultTask() {
  @get:InputFile
  @get:PathSensitive(PathSensitivity.NONE)
  abstract val mappingFile: RegularFileProperty

  @get:InputFile
  @get:PathSensitive(PathSensitivity.NONE)
  abstract val mergedManifest: RegularFileProperty

  @get:Input abstract val namespace: Property<String>

  @get:InputFiles @get:Classpath abstract val classJars: ListProperty<RegularFile>

  @get:InputFiles @get:Classpath abstract val classDirs: ListProperty<Directory>

  @get:Input abstract val ownedPackagePrefixes: ListProperty<String>

  @get:Input abstract val requiredMembers: ListProperty<String>

  @get:OutputFile abstract val reportFile: RegularFileProperty

  @TaskAction
  fun verify() {
    val prefixes = ownedPackagePrefixes.get()
    val result =
      R8KeptClasses.analyze(
        mappingFile.get().asFile.readText(),
        mergedManifest.get().asFile.readText(),
        namespace.get(),
        readClasses(classJars.get().map { it.asFile }, classDirs.get().map { it.asFile }, prefixes),
        prefixes,
        requiredMembers.get(),
      )
    val report = reportFile.get().asFile
    report.parentFile.mkdirs()
    report.writeText(result.report())
    if (result.violations.isNotEmpty()) {
      throw GradleException(
        "R8 kept-class verification failed:\n${result.violations.joinToString("\n")}",
      )
    }
    logger.lifecycle("R8 kept-class verification passed: ${result.counts}")
  }

  private fun readClasses(
    jars: List<File>,
    directories: List<File>,
    ownedPackagePrefixes: List<String>,
  ): Sequence<ByteArray> =
    sequence {
      for (file in jars) {
        JarFile(file).use { jar ->
          val entries = jar.entries()
          while (entries.hasMoreElements()) {
            val entry = entries.nextElement()
            if (
              !entry.isDirectory &&
                entry.name.endsWith(".class") &&
                ownedPackagePrefixes.any { entry.name.contains(it) }
            ) {
              yield(jar.getInputStream(entry).use { it.readBytes() })
            }
          }
        }
      }
      for (directory in directories) {
        for (file in directory.walkTopDown().filter { it.isFile && it.extension == "class" }) {
          val path = file.relativeTo(directory).invariantSeparatorsPath
          if (ownedPackagePrefixes.none { path.contains(it) }) continue
          yield(file.readBytes())
        }
      }
    }
}
