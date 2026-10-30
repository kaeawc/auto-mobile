import com.android.build.api.artifact.ScopedArtifact
import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.ScopedArtifacts
import dev.jasonpearson.automobile.buildlogic.r8.VerifyR8KeptClassesTask
import dev.jasonpearson.automobile.buildlogic.signing.ReleaseSigningGuard
import org.gradle.api.artifacts.component.ProjectComponentIdentifier

plugins {
  id("automobile.android-application")
  id("automobile.protoviewer-play-release")
  id("automobile.robolectric-sdk-pin")
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.aboutlibraries)
}

val minifyRelease =
  providers
    .gradleProperty("automobile.protoviewer.minifyRelease")
    .map { !it.equals("false", ignoreCase = true) }
    .orElse(true)

android {
  namespace = "dev.jasonpearson.automobile.protoviewer"
  defaultConfig {
    // Bundle commit uses java.nio NOFOLLOW checks and same-volume atomic moves (API 26).
    minSdk = 26
    applicationId = "dev.jasonpearson.automobile.protoviewer"
    // Local and debug builds keep this; release builds derive it from the release version
    // (automobile.protoviewer-play-release, ProtoViewerVersioning).
    versionCode = 1
  }
  buildTypes {
    getByName("debug") { isPseudoLocalesEnabled = true }
    // Shrink the Play artifact; the shared mapping archive and VerifyR8KeptClassesTask below guard
    // it.
    getByName("release") { isMinifyEnabled = minifyRelease.get() }
  }
  buildFeatures { compose = true }
  testOptions { unitTests.isIncludeAndroidResources = true }
}

// R8 must keep the manifest components, the @Serializable prototype contract and the reflectively
// resolved icon set (see proguard-rules.pro). Same guard CtrlProxy uses; it also runs for
// bundleRelease because it finalizes every R8 invocation.
androidComponents {
  onVariants(selector().withBuildType("release")) { variant ->
    if (minifyRelease.get()) {
      val verify =
        tasks.register<VerifyR8KeptClassesTask>("verifyReleaseR8KeptClasses") {
          mappingFile.set(variant.artifacts.get(SingleArtifact.OBFUSCATION_MAPPING_FILE))
          mergedManifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
          namespace.set(variant.namespace)
          ownedPackagePrefixes.set(listOf("dev/jasonpearson/automobile/"))
          // Only the saved-prototype contract must survive; the unused :protocol wire models are
          // shrunk away.
          keptSerializablePrefixes.set(listOf("dev/jasonpearson/automobile/ctrlproxy/prototype/"))
          requiredMembers.set(
            listOf("filled", "outlined", "rounded", "sharp", "twotone").map {
              "androidx.compose.material.icons.$it.HomeKt#getHome"
            },
          )
          reportFile.set(layout.buildDirectory.file("reports/r8/release-kept-classes.txt"))
        }
      variant.artifacts
        .forScope(ScopedArtifacts.Scope.ALL)
        .use(verify)
        .toGet(
          ScopedArtifact.CLASSES,
          VerifyR8KeptClassesTask::classJars,
          VerifyR8KeptClassesTask::classDirs,
        )
      tasks.matching { it.name == "assembleRelease" }.configureEach { dependsOn(verify) }
      tasks.matching { it.name == "minifyReleaseWithR8" }.configureEach { finalizedBy(verify) }
    }
  }
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

val releaseSigningConfigName = providers.provider {
  android.buildTypes.getByName("release").signingConfig?.name.orEmpty()
}

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

// Generated third-party notices (#14158): the plugin collects the release runtime classpath's
// licenses into res/raw/aboutlibraries.json, which LicensesActivity renders. Strict mode fails the
// build when a dependency's license is outside the allow-list, so an unreviewed license never
// ships.
aboutLibraries {
  offlineMode = true
  collect {
    // Full Apache-2.0 text comes from the repository LICENSE (offline mode embeds none).
    configPath = file("license-config")
    // The Compose BOM is a version constraint with no code, owner or license of its own.
    includePlatform = false
    filterVariants.addAll("release")
  }
  license {
    strictMode = com.mikepenz.aboutlibraries.plugin.StrictMode.FAIL
    allowedLicenses.addAll("Apache-2.0")
  }
  // Strict mode accepts a library that declares no license at all; this rejects it.
  library { requireLicense = true }
}
