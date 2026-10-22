import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import com.vanniktech.maven.publish.JavadocJar
import org.gradle.api.artifacts.component.ProjectComponentIdentifier

plugins {
  id("automobile.android-library")
  id("automobile.robolectric-sdk-pin")
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.mavenPublish)
  id("automobile.published-library")
}

android {
  namespace = "dev.jasonpearson.automobile.prototype"

  defaultConfig { testInstrumentationRunner = null }

  buildFeatures { compose = true }

  testOptions { unitTests.isIncludeAndroidResources = true }
}

kotlin {
  compilerOptions {
    optIn.add("dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi")
  }
}

dependencies {
  // Spec, action and validation types are part of this library's API.
  api(projects.protocol)

  api(platform(libs.compose.bom))
  api(libs.compose.ui.core)
  // PrototypeHttpRequest.body exposes JsonElement, so host transports compile against it.
  api(libs.kotlinx.serialization)
  implementation(libs.androidx.core)
  implementation(libs.androidx.activity.compose)
  implementation(libs.compose.ui.util)
  implementation(libs.compose.ui.graphics)
  implementation(libs.compose.ui.foundation)
  implementation(libs.compose.material)
  implementation(libs.compose.material.icons.extended)
  implementation(libs.kotlinx.coroutines)

  testImplementation(libs.bundles.unit.test)
  testImplementation(libs.robolectric)
  testImplementation(libs.compose.ui.junit)
  debugImplementation(libs.bundles.compose.ui.debug)
}

mavenPublishing {
  // Same Central-compliant empty Javadoc jar as the SDK (#4852); the sources jar is real.
  configure(AndroidSingleVariantLibrary(javadocJar = JavadocJar.Empty()))
}

// Keep the extraction boundary executable: protocol is the only AutoMobile project permitted on
// the renderer's runtime classpath. Transport implementations belong to the host.
val rendererDependencies = providers.provider {
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

val verifyRendererDependencies =
  tasks.register("verifyRendererDependencies") {
    group = "verification"
    description = "Verifies the renderer has no host or HTTP transport dependencies."
    inputs.property("resolvedDependencies", rendererDependencies)
    doLast {
      val dependencies = inputs.properties.getValue("resolvedDependencies") as List<*>
      val forbidden = dependencies.filter { id ->
        val name = id.toString()
        (name.startsWith("project ") &&
          name !in setOf("project :prototype-compose", "project :protocol")) ||
          name.startsWith("com.squareup.okhttp3:") ||
          name.startsWith("com.squareup.retrofit2:") ||
          name.startsWith("io.ktor:")
      }
      check(forbidden.isEmpty()) { "Renderer depends on host/transport code: $forbidden" }
      logger.lifecycle(dependencies.joinToString("\n"))
    }
  }

tasks.named("check") { dependsOn(verifyRendererDependencies) }

// Preserve the CtrlProxy performance-report switch for the code now compiled in this module.
if (providers.gradleProperty("automobile.composeCompilerReports").orNull == "true") {
  composeCompiler {
    reportsDestination = layout.buildDirectory.dir("compose-compiler-reports")
    metricsDestination = layout.buildDirectory.dir("compose-compiler-reports")
  }
}

// Renderer tests use the same checked-in contract fixtures as their original CtrlProxy location.
tasks.withType<Test>().configureEach {
  inputs.dir(layout.projectDirectory.dir("../../test/fixtures/prototype-spec"))
  inputs.dir(layout.projectDirectory.dir("../../test/fixtures/prototype-embedded-routing"))
  inputs.dir(layout.projectDirectory.dir("../../test/fixtures/prototype-capabilities"))
}
