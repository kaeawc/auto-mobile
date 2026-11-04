package dev.jasonpearson.automobile.buildlogic.robolectric

import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ValueSource
import org.gradle.api.provider.ValueSourceParameters

/**
 * The SDK levels a module's Robolectric tests need (see [RobolectricAndroidAll.moduleSdks]), read
 * from its `src/test*` sources. A ValueSource so the configuration cache re-checks it when a test
 * adds or changes an `@Config(sdk = ...)`.
 */
abstract class RobolectricModuleSdksSource :
  ValueSource<List<Int>, RobolectricModuleSdksSource.Parameters> {
  interface Parameters : ValueSourceParameters {
    val moduleDir: DirectoryProperty
  }

  override fun obtain(): List<Int> {
    val src = parameters.moduleDir.get().asFile.resolve("src")
    val testRoots = src.listFiles { file -> file.isDirectory && file.name.startsWith("test") }
    val files = testRoots.orEmpty().flatMap { root -> root.walkTopDown().filter { it.isFile } }
    val sources = files.filter { it.extension == "kt" || it.extension == "java" }
    val properties = files.filter { it.name == "robolectric.properties" }
    val primary = src.resolve("test/resources/robolectric.properties")
    return RobolectricAndroidAll.moduleSdks(
        sources = sources.map { it.readText() },
        propertiesFiles = properties.map { it.readText() },
        hasPrimaryPin = primary.isFile,
      )
      .sorted()
  }
}
