package dev.jasonpearson.automobile.buildlogic.test

import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters

/**
 * A build-wide lock that lets one AGP JaCoCo coverage report generate at a time (#16376).
 *
 * Each report copies its HTML resources out of the JaCoCo report jar. With `org.gradle.parallel`,
 * several modules' report workers run in one daemon at once, and a report failed with `IOException:
 * Stream closed` in `org.jacoco.report.internal.html.resources.Resources.copyResource` while
 * another worker was reading the same jar. Registered with `maxParallelUsages = 1`.
 */
abstract class CoverageReportLock : BuildService<BuildServiceParameters.None> {
  companion object {
    const val SERVICE_NAME = "automobileCoverageReportLock"

    /** AGP's report tasks: `create<Variant>UnitTestCoverageReport` and its siblings. */
    fun isCoverageReportTask(name: String): Boolean =
      name.startsWith("create") && name.endsWith("CoverageReport")
  }
}
