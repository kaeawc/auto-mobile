package dev.jasonpearson.automobile.buildlogic.robolectric

import org.gradle.api.file.FileCollection
import org.gradle.api.file.RegularFile
import org.gradle.api.provider.Provider
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.process.CommandLineArgumentProvider

/**
 * Hands the test JVM the robolectric-deps.properties path. The jars, not the machine-specific file,
 * are the tracked input, so test results stay relocatable in the build cache.
 */
class RobolectricDepsArgumentProvider(
  @get:Internal val depsFile: Provider<RegularFile>,
  @get:InputFiles @get:PathSensitive(PathSensitivity.NAME_ONLY) val jars: FileCollection,
) : CommandLineArgumentProvider {
  override fun asArguments(): Iterable<String> =
    listOf("-Drobolectric-deps.properties=${depsFile.get().asFile.absolutePath}")
}
