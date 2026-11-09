package dev.jasonpearson.automobile.buildlogic.r8

import org.gradle.api.DefaultTask
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

/** Generates release R8 inputs without accessing Project at execution time. */
@CacheableTask
abstract class GeneratePrototypeIconRulesTask : DefaultTask() {
  @get:InputFile
  @get:PathSensitive(PathSensitivity.NONE)
  abstract val contractFile: RegularFileProperty

  @get:OutputFile abstract val rulesFile: RegularFileProperty

  @TaskAction
  fun generate() {
    val names = PrototypeIconRules.names(contractFile.get().asFile.readText())
    val output = rulesFile.get().asFile
    output.parentFile.mkdirs()
    output.writeText(PrototypeIconRules.rules(names))
  }
}
