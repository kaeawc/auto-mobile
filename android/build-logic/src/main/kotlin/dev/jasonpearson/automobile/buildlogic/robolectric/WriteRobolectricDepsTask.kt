package dev.jasonpearson.automobile.buildlogic.robolectric

import org.gradle.api.DefaultTask
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.work.DisableCachingByDefault

/**
 * Writes the robolectric-deps.properties file that points Robolectric at the android-all jars
 * Gradle resolved, so it never downloads them itself. The file holds absolute paths into this
 * machine's Gradle cache, so it is never stored in the build cache.
 */
@DisableCachingByDefault(because = "The output holds machine-specific absolute paths")
abstract class WriteRobolectricDepsTask : DefaultTask() {
  @get:InputFiles
  @get:PathSensitive(PathSensitivity.NAME_ONLY)
  abstract val jars: ConfigurableFileCollection

  @get:OutputFile abstract val depsFile: RegularFileProperty

  @TaskAction
  fun write() {
    val prefix = "${RobolectricAndroidAll.ARTIFACT}-"
    val byVersion =
      jars.files.associateBy { jar ->
        check(jar.name.startsWith(prefix) && jar.name.endsWith(".jar")) {
          "Unexpected Robolectric runtime artifact ${jar.name}; expected $prefix<version>.jar"
        }
        jar.name.removePrefix(prefix).removeSuffix(".jar")
      }
    depsFile.get().asFile.writeText(RobolectricAndroidAll.depsProperties(byVersion))
  }
}
