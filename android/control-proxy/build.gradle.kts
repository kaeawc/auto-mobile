plugins {
  id("automobile.kotlin-common")
  id("automobile.android-app-signing")
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.compose.compiler)
}

android {
  namespace = "dev.jasonpearson.automobile.ctrlproxy"
  compileSdk = libs.versions.build.android.compileSdk.get().toInt()
  buildToolsVersion = libs.versions.build.android.buildTools.get()

  defaultConfig {
    applicationId = "dev.jasonpearson.automobile.ctrlproxy"
    minSdk = libs.versions.build.android.minSdk.get().toInt()
    targetSdk = libs.versions.build.android.targetSdk.get().toInt()
    versionCode = 1
    versionName = "0.0.84-SNAPSHOT"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  lint {
    // Suppress ProtectedPermissions for MANAGE_CA_CERTIFICATES
    // This permission is used when the app is set as device owner/profile owner
    disable += "ProtectedPermissions"
  }

  buildFeatures { compose = true }

  // Robolectric needs the merged resources to render Compose Material 3 off-device (its components
  // read library string resources); used by the prototype renderer screenshot tests. The default
  // Robolectric SDK this would otherwise change is pinned in
  // src/test/resources/robolectric.properties.
  testOptions { unitTests.isIncludeAndroidResources = true }

  compileOptions {
    sourceCompatibility = JavaVersion.toVersion(libs.versions.build.java.target.get())
    targetCompatibility = JavaVersion.toVersion(libs.versions.build.java.target.get())
  }

  packaging {
    resources {
      // Exclude duplicate META-INF files from Ktor dependencies
      excludes += "/META-INF/INDEX.LIST"
      excludes += "/META-INF/*.kotlin_module"
    }
  }
}

dependencies {
  implementation(libs.androidx.core)

  // AutoMobile SDK for navigation event tracking
  implementation(projects.autoMobileSdk)

  // Protocol module for type-safe WebSocket messages
  implementation(projects.protocol)

  // Compose BOM
  implementation(platform(libs.compose.bom))
  implementation(libs.bundles.compose.ui)
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Kotlin coroutines
  implementation(libs.kotlinx.coroutines)

  // Kotlinx Serialization for navigation
  implementation(libs.kotlinx.serialization)

  // WebSocket server dependencies
  implementation(libs.ktor.server.core)
  implementation(libs.ktor.server.cors)
  // CIO engine used instead of Netty to support lower minSdk (Netty requires API 26+)
  implementation(libs.ktor.server.sse)
  implementation(libs.ktor.server.cio)
  implementation(libs.ktor.server.websockets)
  implementation(libs.ktor.server.content.negotiation)
  implementation(libs.ktor.serialization.kotlinx.json)
  implementation(libs.okhttp)
  implementation(libs.okhttp.sse)

  // Test dependencies
  testImplementation(libs.bundles.unit.test)
  testImplementation(projects.junitRunner)
  testImplementation(libs.robolectric)
  // createComposeRule's mainClock drives prototype motion frame by frame (#10442).
  testImplementation(libs.compose.ui.junit)
  testImplementation(libs.ktor.client.core)
  testImplementation(libs.ktor.client.cio)
  testImplementation(libs.ktor.client.websockets)
  testImplementation(libs.ktor.client.content.negotiation)

  // Compose test dependencies
  debugImplementation(libs.bundles.compose.ui.debug)
}

// Forward the prototype renderer screenshot and preview switches from the Gradle invocation to the
// forked test JVM so `-Dscreenshot.record=true` (and friends) reach the tests. See
// src/test/kotlin/.../prototype/screenshot/PrototypeScreenshotEnvironment.kt and
// PrototypePreview.kt for
// the supported flags.
val screenshotProperties =
  listOf(
    "screenshot.record",
    "screenshot.reference.os",
    "screenshot.golden.dir",
    "screenshot.report.dir",
    "prototype.preview.spec",
    "prototype.preview.out",
    "prototype.preview.width",
    "prototype.preview.height",
    "prototype.preview.density",
    "prototype.preview.theme",
  )

tasks.withType<Test>().configureEach {
  screenshotProperties.forEach { key ->
    System.getProperty(key)?.let { value -> systemProperty(key, value) }
  }
  // A preview reads spec files Gradle does not track, so never reuse an up-to-date or cached
  // result.
  if (System.getProperty("prototype.preview.spec") != null) {
    outputs.upToDateWhen { false }
    outputs.doNotCacheIf("prototype preview reads untracked spec files") { true }
  }
}
