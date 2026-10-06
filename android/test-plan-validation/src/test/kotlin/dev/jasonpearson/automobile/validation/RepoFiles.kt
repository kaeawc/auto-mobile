package dev.jasonpearson.automobile.validation

import java.io.File

/** Locates files in the repository checkout the unit tests run from (the module's working dir). */
internal object RepoFiles {
  fun find(relativePath: String): File =
    generateSequence(File("").absoluteFile) { it.parentFile }
      .map { File(it, relativePath) }
      .firstOrNull { it.isFile }
      ?: throw IllegalStateException(
        "Unable to locate $relativePath above ${File("").absolutePath}"
      )
}
