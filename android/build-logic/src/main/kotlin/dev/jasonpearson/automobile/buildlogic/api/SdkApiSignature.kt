package dev.jasonpearson.automobile.buildlogic.api

import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/** Public SDK signatures, shared by the Gradle tasks and their JVM regression tests. */
class SdkApiSignature(private val javapExecutable: String = "javap") {
  fun generate(classDirectories: Collection<File>): String {
    val classNames = selectClassNames(classDirectories)
    if (classNames.isEmpty()) return ""
    val classpath = classDirectories.joinToString(File.pathSeparator) { it.path }
    val blocks = parseBlocks(runJavap(classpath, classNames))
    val publicClasses = blocks.filter { it.isPublic }.map { it.name }.toSet()
    val signature =
      blocks
        .filter { it.isPublic && hasPublicEnclosingClasses(it.name, publicClasses) }
        .joinToString("\n") { it.text }
    return if (signature.isEmpty()) "" else signature.trim() + "\n"
  }

  private fun selectClassNames(classDirectories: Collection<File>): List<String> =
    classDirectories
      .flatMap { root ->
        root.walkTopDown().filter { it.isFile && it.extension == "class" }.toList()
      }
      .sortedBy { it.path }
      .mapNotNull { classFile ->
        val relativePath =
          classDirectories.firstNotNullOfOrNull { root ->
            if (classFile.startsWith(root)) classFile.relativeTo(root).invariantSeparatorsPath
            else null
          } ?: return@mapNotNull null
        val name = relativePath.removeSuffix(".class").replace('/', '.')
        val lastSegment = name.substringAfterLast('$')
        val anonymous = lastSegment.isNotEmpty() && lastSegment.all { it.isDigit() }
        if ("\$\$" in name || "BuildConfig" in name || anonymous) null else name
      }

  private fun runJavap(classpath: String, classNames: List<String>): String {
    // Redirect to a file so reading stdout cannot block before the bounded wait begins.
    val outputFile = Files.createTempFile("sdk-api-javap-", ".txt")
    try {
      val process =
        ProcessBuilder(
            listOf(javapExecutable, "-public", "-constants", "-classpath", classpath) + classNames,
          )
          .redirectErrorStream(true)
          .redirectOutput(outputFile.toFile())
          .start()
      try {
        check(process.waitFor(JAVAP_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
          "javap timed out after 60 seconds"
        }
        val output = outputFile.toFile().readText()
        check(process.exitValue() == 0) {
          "javap failed with exit code ${process.exitValue()}: $output"
        }
        return output
      } finally {
        if (process.isAlive) process.destroyForcibly()
      }
    } finally {
      Files.deleteIfExists(outputFile)
    }
  }

  private fun parseBlocks(output: String): List<ClassBlock> {
    val blocks = mutableListOf<ClassBlock>()
    val lines = mutableListOf<String>()
    for (line in output.lineSequence()) {
      lines.add(line)
      if (line == "}") {
        val declaration = lines.firstNotNullOfOrNull { CLASS_DECLARATION.matchEntire(it) }
        checkNotNull(declaration) {
          "Missing class declaration in javap output: ${lines.joinToString("\n")}"
        }
        // Inspect the declaration's modifiers, never its members. javap's header does not
        // expose InnerClasses access overrides: a Java protected/private nested class whose
        // class-file flags are ACC_PUBLIC may still be included. Kotlin private classes lack it.
        blocks.add(
          ClassBlock(
            declaration.groupValues[2],
            "public" in declaration.groupValues[1].split(' '),
            lines.joinToString("\n").trim(),
          ),
        )
        lines.clear()
      }
    }
    return blocks
  }

  private fun hasPublicEnclosingClasses(name: String, publicClasses: Set<String>): Boolean =
    name.indices.filter { name[it] == '$' }.all { name.substring(0, it) in publicClasses }

  private data class ClassBlock(val name: String, val isPublic: Boolean, val text: String)

  private companion object {
    const val JAVAP_TIMEOUT_SECONDS = 60L
    val CLASS_DECLARATION = Regex("""^((?:\w+\s+)*)(?:class|interface)\s+([^\s<{]+).* \{$""")
  }
}
