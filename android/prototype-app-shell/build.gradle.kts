import com.android.build.api.artifact.SingleArtifact
import java.security.MessageDigest
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

import org.gradle.api.artifacts.component.ProjectComponentIdentifier

plugins {
  id("automobile.android-application")
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "dev.jasonpearson.automobile.prototype.appshell"
  defaultConfig {
    applicationId = "dev.jasonpearson.automobile.app.template"
    minSdk = 26
    versionCode = 1
    testInstrumentationRunner = null
  }
  flavorDimensions += "template"
  productFlavors { create("base") { dimension = "template" } }
  buildTypes {
    // Keep local debug builds on the same package identity as the release template.
    getByName("debug") { isDebuggable = false }
    getByName("release") { isMinifyEnabled = false }
  }
  buildFeatures { compose = true }
}

dependencies {
  implementation(projects.prototypeCompose)
  implementation(projects.protocol)
  implementation(libs.androidx.core)
  implementation(libs.androidx.core.splashscreen)
  implementation(libs.androidx.activity.compose)
  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui.foundation)
  implementation(libs.compose.material)
  implementation(libs.kotlinx.coroutines)
  implementation(libs.kotlinx.serialization)
  testImplementation(libs.junit)
}

// Resolve both shipped variants, including transitive project edges.
val appShellDependencies = providers.provider {
  listOf("baseDebugRuntimeClasspath", "baseReleaseRuntimeClasspath")
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

val verifyAppShellDependencies =
  tasks.register("verifyAppShellDependencies") {
    group = "verification"
    description = "Verifies the disposable app shell links no privileged or host component."
    inputs.property("resolvedDependencies", appShellDependencies)
    doLast {
      val dependencies = inputs.properties.getValue("resolvedDependencies") as List<*>
      val allowedProjects =
        setOf("project :prototype-app-shell", "project :prototype-compose", "project :protocol")
      val forbidden = dependencies.filter { id ->
        val name = id.toString()
        (name.startsWith("project ") && name !in allowedProjects) ||
          name.startsWith("io.ktor:") ||
          name.startsWith("com.squareup.okhttp3:") ||
          name.startsWith("com.squareup.retrofit2:")
      }
      check(forbidden.isEmpty()) { "App shell depends on privileged/transport code: $forbidden" }
      logger.lifecycle(dependencies.joinToString("\n"))
    }
  }

tasks.named("check") { dependsOn(verifyAppShellDependencies) }

@CacheableTask
abstract class PackageStampTemplate : DefaultTask() {
  @get:InputDirectory
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val apkDirectory: DirectoryProperty

  @get:InputFile
  @get:PathSensitive(PathSensitivity.NONE)
  abstract val mergedManifest: RegularFileProperty

  @get:InputFile
  @get:PathSensitive(PathSensitivity.NONE)
  abstract val stampPoints: RegularFileProperty

  @get:InputFile
  @get:PathSensitive(PathSensitivity.NONE)
  abstract val capabilities: RegularFileProperty

  @get:Input abstract val templateName: Property<String>
  @get:Input abstract val templateApplicationId: Property<String>
  @get:OutputDirectory abstract val outputDirectory: DirectoryProperty

  @TaskAction
  fun packageTemplate() {
    val apk = apkDirectory.get().asFile.walkTopDown().filter { it.extension == "apk" }.toList().single()
    val output = outputDirectory.get().asFile
    output.deleteRecursively()
    output.mkdirs()
    apk.copyTo(output.resolve("template.apk"))
    mergedManifest.get().asFile.copyTo(output.resolve("AndroidManifest.xml"))
    stampPoints.get().asFile.copyTo(output.resolve("stamp-points.json"))
    capabilities.get().asFile.copyTo(output.resolve("capabilities.json"))
    val digest = MessageDigest.getInstance("SHA-256").digest(apk.readBytes()).joinToString("") { "%02x".format(it) }
    output.resolve("template.json").writeText(
      """{"template":"${templateName.get()}","applicationId":"${templateApplicationId.get()}","apkSha256":"$digest"}
"""
    )
  }
}

androidComponents {
  onVariants(selector().withBuildType("release")) { variant ->
    val flavor = variant.flavorName ?: error("Stamp templates require a flavor")
    tasks.register<PackageStampTemplate>("package${flavor.replaceFirstChar { it.uppercaseChar() }}StampTemplate") {
      group = "build"
      description = "Packages the unsigned $flavor APK and text manifest for host stamping."
      apkDirectory.set(variant.artifacts.get(SingleArtifact.APK))
      mergedManifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
      stampPoints.set(layout.projectDirectory.file("stamp-points.json"))
      capabilities.set(layout.projectDirectory.file("src/$flavor/assets/capabilities.json"))
      templateName.set(flavor)
      templateApplicationId.set(variant.applicationId)
      outputDirectory.set(layout.buildDirectory.dir("outputs/stamp-template/$flavor"))
    }
  }
}
