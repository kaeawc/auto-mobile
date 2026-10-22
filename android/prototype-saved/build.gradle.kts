import org.gradle.api.artifacts.component.ProjectComponentIdentifier

plugins {
  id("automobile.android-library")
  id("automobile.robolectric-sdk-pin")
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "dev.jasonpearson.automobile.prototype.saved"

  defaultConfig { testInstrumentationRunner = null }

  testOptions { unitTests.isIncludeAndroidResources = true }
}

kotlin {
  compilerOptions {
    optIn.add("dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi")
  }
}

dependencies {
  // Saved-prototype store, asset source and screen state build on the renderer's contracts.
  api(projects.prototypeCompose)
  api(projects.protocol)

  implementation(libs.androidx.core)
  implementation(libs.kotlinx.coroutines)
  implementation(libs.kotlinx.serialization)
  // The device-side HTTP transport and its egress policy (no Ktor, no host link).
  implementation(libs.okhttp)
  implementation(libs.retrofit)

  testImplementation(libs.bundles.unit.test)
  testImplementation(libs.robolectric)
  testImplementation(libs.okhttp.mockwebserver)
}

// Keep the extraction boundary executable: this module is what a standalone, unprivileged
// ProtoViewer links, so it must never reach accessibility, IME or overlay code (CtrlProxy), the
// SDK, or the host (Ktor) transport. Only protocol and the renderer are permitted AutoMobile
// projects on its runtime classpath.
val savedPrototypeDependencies = providers.provider {
  listOf("debugRuntimeClasspath", "releaseRuntimeClasspath")
    .flatMap { configuration ->
      configurations.getByName(configuration).incoming.resolutionResult.allComponents.map {
        component ->
        when (val id = component.id) {
          is ProjectComponentIdentifier -> "project ${id.buildTreePath}"
          else -> id.displayName
        }
      }
    }
    .distinct()
    .sorted()
}

val verifySavedPrototypeDependencies =
  tasks.register("verifySavedPrototypeDependencies") {
    group = "verification"
    description = "Verifies the saved-prototype module links no privileged or host component."
    inputs.property("resolvedDependencies", savedPrototypeDependencies)
    doLast {
      val dependencies = inputs.properties.getValue("resolvedDependencies") as List<*>
      val allowedProjects =
        setOf("project :prototype-saved", "project :prototype-compose", "project :protocol")
      val forbidden = dependencies.filter { id ->
        val name = id.toString()
        (name.startsWith("project ") && name !in allowedProjects) || name.startsWith("io.ktor:")
      }
      check(forbidden.isEmpty()) { "Saved-prototype module depends on privileged code: $forbidden" }
      logger.lifecycle(dependencies.joinToString("\n"))
    }
  }

tasks.named("check") { dependsOn(verifySavedPrototypeDependencies) }
