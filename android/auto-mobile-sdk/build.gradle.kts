import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import com.vanniktech.maven.publish.JavadocJar
import java.util.concurrent.TimeUnit
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.mavenPublish)
  alias(libs.plugins.dokka)
}

android {
  namespace = "dev.jasonpearson.automobile.sdk"
  compileSdk = libs.versions.build.android.compileSdk.get().toInt()

  defaultConfig {
    minSdk = 24

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    consumerProguardFiles("consumer-rules.pro")
  }

  testOptions {
    unitTests.isReturnDefaultValues = true
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.toVersion(libs.versions.build.java.target.get())
    targetCompatibility = JavaVersion.toVersion(libs.versions.build.java.target.get())
  }

  buildFeatures { compose = true }
}

// Version comes from root project's gradle.properties (VERSION_NAME)

dependencies {
  // Protocol module for type-safe event serialization
  implementation(project(":protocol"))

  // Android core libraries
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.androidx.lifecycle.runtime)
  implementation(libs.androidx.lifecycle.process)

  // Kotlin coroutines
  implementation(libs.kotlinx.coroutines)

  // Kotlin serialization (for NetworkMockRuleStore broadcast parsing)
  implementation(libs.kotlinx.serialization)

  // OkHttp — compileOnly so consumers must bring their own dependency
  compileOnly(libs.okhttp)

  // Compose runtime for @Composable support
  implementation(platform(libs.compose.bom))
  implementation("androidx.compose.runtime:runtime")
  implementation(libs.bundles.compose.sdk)
  debugImplementation(libs.compose.ui.tooling)
  debugImplementation(libs.compose.ui.tooling.preview)

  // Navigation3 support for Compose navigation tracking
  implementation(libs.navigation3.runtime)

  // Optional CircuitX support. Consumers provide CircuitX when using this integration.
  compileOnly(libs.circuitx.navigation)

  // Test dependencies
  testImplementation(libs.kotlin.test)
  testImplementation(libs.junit)
  testImplementation(libs.bundles.unit.test)
  testImplementation(libs.robolectric)
  testImplementation(libs.okhttp)
  testImplementation(libs.circuit.test)
  testImplementation(libs.circuitx.navigation)
}

// Configure Kotlin compilation options
tasks.withType<KotlinCompile>().configureEach {
  compilerOptions {
    jvmTarget.set(
      org.jetbrains.kotlin.gradle.dsl.JvmTarget.fromTarget(libs.versions.build.java.target.get())
    )
    languageVersion.set(
      KotlinVersion.valueOf("KOTLIN_${libs.versions.build.kotlin.language.get().replace(".", "_")}")
    )
  }
}

// --- API surface tracking ---
// BCV (binary-compatibility-validator) is incompatible with AGP 9 because AGP 9 no longer
// applies the "kotlin-android" plugin ID that BCV's withPlugin callback relies on.
// These custom tasks use javap to produce a public API signature file from compiled release
// classes. apiDump generates the baseline and apiCheck verifies it hasn't changed.

fun generateApiSignature(classesDir: FileCollection): String {
  val classpath = classesDir.files.joinToString(":") { it.path }
  val classNames =
    classesDir.asFileTree
      .matching { include("**/*.class") }
      .files
      .sortedBy { it.path }
      .mapNotNull { classFile ->
        val relativePath =
          classesDir.files.firstNotNullOfOrNull { root ->
            if (classFile.startsWith(root)) classFile.relativeTo(root).path else null
          } ?: return@mapNotNull null
        if ("\$\$" in relativePath || "BuildConfig" in relativePath) return@mapNotNull null
        relativePath.removeSuffix(".class").replace('/', '.')
      }
  if (classNames.isEmpty()) return ""
  // Run javap once with all class names for efficiency
  val proc =
    ProcessBuilder(listOf("javap", "-public", "-classpath", classpath) + classNames)
      .redirectErrorStream(true)
      .start()
  val output = proc.inputStream.bufferedReader().readText()
  val exited = proc.waitFor(60, TimeUnit.SECONDS)
  if (!exited) {
    proc.destroyForcibly()
    throw GradleException("javap timed out after 60 seconds")
  }
  if (proc.exitValue() != 0) {
    throw GradleException("javap failed with exit code ${proc.exitValue()}: $output")
  }
  return output.trim() + "\n"
}

val apiFile = layout.projectDirectory.file("api/auto-mobile-sdk.api")
val kotlinReleaseClassesDir =
  layout.buildDirectory.dir("intermediates/built_in_kotlinc/release/compileReleaseKotlin/classes")

tasks.register("apiDump") {
  description = "Generate public API signature file from release classes"
  group = "verification"
  dependsOn("compileReleaseKotlin")
  inputs.dir(kotlinReleaseClassesDir)
  outputs.file(apiFile)
  doLast {
    val signature = generateApiSignature(files(kotlinReleaseClassesDir))
    val output = apiFile.asFile
    output.parentFile.mkdirs()
    output.writeText(signature)
    logger.lifecycle("API dump written to ${output.relativeTo(projectDir)}")
  }
}

tasks.register("apiCheck") {
  description = "Check that public API matches the checked-in signature file"
  group = "verification"
  dependsOn("compileReleaseKotlin")
  inputs.dir(kotlinReleaseClassesDir)
  inputs.file(apiFile)
  doLast {
    val expected = apiFile.asFile
    if (!expected.exists()) {
      throw GradleException(
        "API file ${expected.relativeTo(projectDir)} does not exist. " +
          "Run :auto-mobile-sdk:apiDump first."
      )
    }
    val current = generateApiSignature(files(kotlinReleaseClassesDir))
    if (current != expected.readText()) {
      throw GradleException(
        "Public API has changed! Run :auto-mobile-sdk:apiDump to update the API file.\n" +
          "Expected file: ${expected.relativeTo(projectDir)}"
      )
    }
    logger.lifecycle("API check passed: public API matches ${expected.relativeTo(projectDir)}")
  }
}

mavenPublishing {
  // Publish an empty (Central-compliant) Javadoc jar instead of the ~1.78 MB
  // Dokka HTML site (#4852). Maven Central requires a -javadoc.jar to exist, but
  // we do not ship HTML API docs. The single-arg form keeps vanniktech's defaults
  // for everything else -- the release aar and the real sources jar are unchanged
  // -- and Dokka stays applied for local/hosted doc generation.
  configure(AndroidSingleVariantLibrary(javadocJar = JavadocJar.Empty()))

  // Coordinates: group and version from root, artifact from local gradle.properties
  coordinates(
    property("GROUP").toString(),
    property("POM_ARTIFACT_ID").toString(),
    version.toString(),
  )

  pom {
    name.set(property("POM_NAME").toString())
    description.set(property("POM_DESCRIPTION").toString())
    inceptionYear.set("2025")
    url.set(property("POM_URL").toString())
    licenses {
      license {
        name.set(property("POM_LICENCE_NAME").toString())
        url.set(property("POM_LICENCE_URL").toString())
        distribution.set("repo")
      }
    }
    developers {
      developer {
        id.set(property("POM_DEVELOPER_ID").toString())
        name.set(property("POM_DEVELOPER_NAME").toString())
        url.set("https://github.com/${property("POM_DEVELOPER_ID")}/")
        email.set(property("POM_DEVELOPER_EMAIL").toString())
      }
    }
    scm {
      url.set(property("POM_SCM_URL").toString())
      connection.set(property("POM_SCM_CONNECTION").toString())
      developerConnection.set(property("POM_SCM_DEV_CONNECTION").toString())
    }
  }
}
