import dev.jasonpearson.automobile.buildlogic.signing.ReleaseSigningGuard
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
    // Bundle commit uses java.nio NOFOLLOW checks and same-volume atomic moves (API 26).
    minSdk = 26
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
  implementation(libs.okhttp) // Existing transport dependency; no alternate HTTP stack.
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

// Fail closed for the published artifact (#15301). The shared signing convention falls back to
// the debug key when any keystore input is missing, which is right for local and fork-PR builds
// but must never produce a release asset. The release workflow sets
// PROTOVIEWER_REQUIRE_RELEASE_SIGNING=true; then building the release variant without the
// release signing config fails (before any compilation) instead of shipping a debug-signed APK.
val requireProtoViewerReleaseSigning =
  providers
    .environmentVariable("PROTOVIEWER_REQUIRE_RELEASE_SIGNING")
    .orElse(providers.gradleProperty("PROTOVIEWER_REQUIRE_RELEASE_SIGNING"))
    .map { it.equals("true", ignoreCase = true) }
    .orElse(false)

val releaseSigningConfigName =
  providers.provider { android.buildTypes.getByName("release").signingConfig?.name.orEmpty() }

val verifyProtoViewerReleaseSigning =
  tasks.register("verifyProtoViewerReleaseSigning") {
    group = "verification"
    description = "Fails when a required ProtoViewer release build is not release-key signed."
    val required = requireProtoViewerReleaseSigning
    val configName = releaseSigningConfigName
    doLast {
      ReleaseSigningGuard.violation(required.get(), configName.get())?.let { error(it) }
    }
  }

tasks.configureEach {
  if (name == "preReleaseBuild") dependsOn(verifyProtoViewerReleaseSigning)
}
