import org.gradle.api.artifacts.component.ProjectComponentIdentifier

plugins {
  id("automobile.android-application")
  id("automobile.android-app-signing")
  id("automobile.robolectric-sdk-pin")
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "dev.jasonpearson.automobile.protoviewer"
  defaultConfig {
    applicationId = "dev.jasonpearson.automobile.protoviewer"
    versionCode = 1
  }
  buildFeatures { compose = true }
  testOptions { unitTests.isIncludeAndroidResources = true }
}

kotlin {
  compilerOptions {
    optIn.add("dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi")
  }
}

dependencies {
  implementation(projects.prototypeCompose)
  implementation(projects.prototypeSaved)
  implementation(projects.protocol)
  implementation(libs.androidx.core)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.lifecycle.runtime)
  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui.foundation)
  implementation(libs.compose.material)
  implementation(libs.kotlinx.coroutines)
  implementation(libs.kotlinx.serialization)
  testImplementation(libs.bundles.unit.test)
  testImplementation(libs.robolectric)
  testImplementation(libs.compose.ui.junit)
  debugImplementation(libs.bundles.compose.ui.debug)
}

// Keep the standalone app's unprivileged project boundary executable.
val protoViewerDependencies = providers.provider {
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

val verifyProtoViewerDependencies =
  tasks.register("verifyProtoViewerDependencies") {
    group = "verification"
    description = "Verifies the ProtoViewer links no privileged or host component."
    inputs.property("resolvedDependencies", protoViewerDependencies)
    doLast {
      val dependencies = inputs.properties.getValue("resolvedDependencies") as List<*>
      val allowedProjects =
        setOf(
          "project :protoviewer",
          "project :prototype-saved",
          "project :prototype-compose",
          "project :protocol",
        )
      val forbidden = dependencies.filter { id ->
        val name = id.toString()
        (name.startsWith("project ") && name !in allowedProjects) || name.startsWith("io.ktor:")
      }
      check(forbidden.isEmpty()) { "ProtoViewer depends on privileged code: $forbidden" }
      logger.lifecycle(dependencies.joinToString("\n"))
    }
  }

tasks.named("check") { dependsOn(verifyProtoViewerDependencies) }
