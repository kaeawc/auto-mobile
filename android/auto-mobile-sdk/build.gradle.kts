import com.android.build.api.dsl.LibraryExtension
import com.vanniktech.maven.publish.AndroidMultiVariantLibrary
import com.vanniktech.maven.publish.JavadocJar
import dev.jasonpearson.automobile.buildlogic.api.SdkApiSignature
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
  id("automobile.kotlin-common")
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

  // Compile the same signature implementation for JVM tests without shipping it in the SDK.
  // Use the new DSL type to avoid AGP's legacy AndroidLibrarySourceSet cast.
  (this as LibraryExtension)
    .sourceSets
    .getByName("test")
    .kotlin
    .directories
    .add("../build-logic/src/main/kotlin/dev/jasonpearson/automobile/buildlogic/api")

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
      org.jetbrains.kotlin.gradle.dsl.JvmTarget.fromTarget(libs.versions.build.java.target.get()),
    )
    languageVersion.set(
      KotlinVersion.valueOf(
        "KOTLIN_${libs.versions.build.kotlin.language.get().replace(".", "_")}",
      ),
    )
  }
}

// --- API surface tracking ---
// BCV (binary-compatibility-validator) is incompatible with AGP 9 because AGP 9 no longer
// applies the "kotlin-android" plugin ID that BCV's withPlugin callback relies on.
// These custom tasks use javap -public -constants to track declarations and inlined constant
// values from compiled release classes. Only public declarations with public enclosing classes
// are included; anonymous/local/lambda classes are excluded. apiDump generates the baseline
// and apiCheck verifies it hasn't changed.

abstract class SdkApiSignatureTask : DefaultTask() {
  @get:InputFiles
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val releaseClasses: ConfigurableFileCollection

  protected fun generateApiSignature(): String {
    try {
      return SdkApiSignature().generate(releaseClasses.files)
    } catch (error: IllegalStateException) {
      throw GradleException(error.message ?: "API signature generation failed", error)
    }
  }
}

abstract class SdkApiDumpTask : SdkApiSignatureTask() {
  @get:OutputFile abstract val apiFile: RegularFileProperty

  @TaskAction
  fun dump() {
    val signature = generateApiSignature()
    val output = apiFile.get().asFile
    output.parentFile.mkdirs()
    output.writeText(signature)
    logger.lifecycle("API dump written to ${output.name}")
  }
}

abstract class SdkApiCheckTask : SdkApiSignatureTask() {
  // InputFiles permits a missing baseline so the action can print the repair command.
  @get:InputFiles
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val baselineFiles: ConfigurableFileCollection

  @TaskAction
  fun check() {
    val expected = baselineFiles.singleFile
    if (!expected.exists()) {
      throw GradleException(
        "API file ${expected.name} does not exist. " +
          "Run cd android && ./gradlew :auto-mobile-sdk:apiDump first.",
      )
    }
    val current = generateApiSignature()
    if (current != expected.readText()) {
      throw GradleException(
        "Public API has changed! Run cd android && ./gradlew :auto-mobile-sdk:apiDump " +
          "to update the API file.\nExpected file: ${expected.name}",
      )
    }
    logger.lifecycle("API check passed: public API matches ${expected.name}")
  }
}

val sdkApiFile = layout.projectDirectory.file("api/auto-mobile-sdk.api")
val kotlinReleaseClassesDir =
  layout.buildDirectory.dir("intermediates/built_in_kotlinc/release/compileReleaseKotlin/classes")

tasks.register<SdkApiDumpTask>("apiDump") {
  description = "Generate public API signature file from release classes"
  group = "verification"
  dependsOn("compileReleaseKotlin")
  releaseClasses.from(kotlinReleaseClassesDir)
  apiFile.set(sdkApiFile)
}

tasks.register<SdkApiCheckTask>("apiCheck") {
  description = "Check that public API matches the checked-in signature file"
  group = "verification"
  dependsOn("compileReleaseKotlin")
  releaseClasses.from(kotlinReleaseClassesDir)
  baselineFiles.from(sdkApiFile)
}

mavenPublishing {
  // Publish BOTH the release and debug variants (#5714). The storage-inspection
  // ContentProviders and their manifest entries live in `src/debug` only, so a
  // single-variant (release) publication left Maven consumers unable to install
  // database / shared-preference inspection endpoints even in a debug build.
  // AndroidMultiVariantLibrary publishes the debug AAR (with those providers) and
  // release AAR under Gradle Module Metadata, so a consumer's debug build resolves
  // the provider-bearing debug variant while its release build resolves the release
  // variant that carries no exported inspection components.
  //
  // Publish an empty (Central-compliant) Javadoc jar instead of the ~1.78 MB Dokka
  // HTML site (#4852). Maven Central requires a -javadoc.jar to exist, but we do
  // not ship HTML API docs. The remaining defaults keep the real sources jar, and
  // Dokka stays applied for local/hosted doc generation.
  configure(AndroidMultiVariantLibrary(javadocJar = JavadocJar.Empty()))

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
