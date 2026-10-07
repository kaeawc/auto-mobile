package dev.jasonpearson.automobile.buildlogic.test

import java.util.function.LongSupplier
import org.gradle.api.provider.Provider
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.gradle.api.tasks.Internal
import org.gradle.process.CommandLineArgumentProvider

/**
 * One timestamp per Gradle build, taken when the first test task forks a JVM. The AutoMobile JUnit
 * runner compares it with the daemon's `startedAt`, so a test fork started after a sibling fork (or
 * another module's test task) already force-restarted the daemon reuses it instead of restarting it
 * again and failing the sibling's in-flight plans (#10170).
 *
 * Read through [LongSupplier] (a JDK type): projects load this convention in separate classloaders,
 * so the shared instance may not be castable to this class from another project.
 */
abstract class JUnitRunStartService : BuildService<BuildServiceParameters.None>, LongSupplier {
  private val startedAtMs: Long = System.currentTimeMillis()

  override fun getAsLong(): Long = startedAtMs
}

/**
 * Passes the build's run start to a test JVM. Internal (not an input), so the per-build value never
 * invalidates up-to-date checks or the build cache.
 */
class JUnitRunStartArgumentProvider(@get:Internal val runStart: Provider<out LongSupplier>) :
  CommandLineArgumentProvider {
  override fun asArguments(): Iterable<String> =
    listOf("-D$RUN_STARTED_AT_PROPERTY=${runStart.get().asLong}")

  companion object {
    /** Read by `DaemonSocketPaths.resolveRunnerStartedAtMs` in android/junit-runner. */
    const val RUN_STARTED_AT_PROPERTY = "automobile.junit.runStartedAtMs"
    const val SERVICE_NAME = "automobileJUnitRunStart"
  }
}
