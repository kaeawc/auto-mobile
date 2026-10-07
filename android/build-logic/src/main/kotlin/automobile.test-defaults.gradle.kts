import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.dsl.LibraryExtension
import dev.jasonpearson.automobile.buildlogic.test.JUnitRunStartArgumentProvider
import dev.jasonpearson.automobile.buildlogic.test.JUnitRunStartService
import org.gradle.api.tasks.testing.Test
import org.gradle.kotlin.dsl.apply
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.withType
import org.gradle.testing.jacoco.tasks.JacocoReport

// Test worker JVM args, local test-fork parallelism, Jacoco XML-only reports, and
// Android debug unit-test coverage. Replaces the root `subprojects {}` wiring.

val workerJvmArgs = providers.gradleProperty("org.gradle.testWorker.jvmargs").getOrElse("")

// One run-start timestamp shared by every test fork of this build, so the AutoMobile JUnit
// runner's CI forced daemon restart happens once per build, not once per fork (#10170).
val junitRunStart =
  gradle.sharedServices.registerIfAbsent(
    JUnitRunStartArgumentProvider.SERVICE_NAME,
    JUnitRunStartService::class.java,
  ) {}

tasks.withType<Test>().configureEach {
  if (workerJvmArgs.isNotBlank()) {
    jvmArgs(workerJvmArgs.split(" ").filter { it.isNotBlank() })
  }
  usesService(junitRunStart)
  jvmArgumentProviders.add(JUnitRunStartArgumentProvider(junitRunStart))
  // Robolectric-heavy modules otherwise run a single fork. Cross-module tasks
  // already parallelize via org.gradle.parallel; this parallelizes within a module.
  maxParallelForks = (Runtime.getRuntime().availableProcessors() / 2).coerceAtLeast(1)
}

pluginManager.withPlugin("java") {
  apply(plugin = "jacoco")
  tasks.withType<JacocoReport>().configureEach {
    reports {
      xml.required.set(true)
      html.required.set(false)
    }
  }
}

pluginManager.withPlugin("com.android.application") {
  extensions.configure<ApplicationExtension> {
    buildTypes { getByName("debug") { enableUnitTestCoverage = true } }
  }
}

pluginManager.withPlugin("com.android.library") {
  extensions.configure<LibraryExtension> {
    buildTypes { getByName("debug") { enableUnitTestCoverage = true } }
  }
}
