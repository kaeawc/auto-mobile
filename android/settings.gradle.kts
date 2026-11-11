dependencyResolutionManagement {
  @Suppress("UnstableApiUsage") repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
  // Use Maven Central as the default repository (where Gradle will download dependencies) in all
  // subprojects.
  @Suppress("UnstableApiUsage")
  repositories {
    google()
    mavenCentral()
  }
}

pluginManagement {
  // Convention plugins (e.g. automobile.kotlin-common) live in the build-logic
  // included build.
  includeBuild("build-logic")
  repositories {
    google {
      content {
        includeGroupByRegex("com\\.android.*")
        includeGroupByRegex("com\\.google.*")
        includeGroupByRegex("androidx.*")
      }
    }
    mavenCentral()
    gradlePluginPortal()
  }
}

plugins {
  // Use the Foojay Toolchains plugin to automatically download JDKs required by subprojects.
  id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

include(":control-proxy")

include(":content-seeder")

// On-device baseline profile generator for CtrlProxy (#17417); never runs in CI.
include(":control-proxy-baselineprofile")

include(":auto-mobile-sdk")

// Deterministic Android Automotive OS fixture app for automotive checks (#16745).
include(":automotive-fixture")

include(":killprofile-fixture")

// Deterministic Wear OS fixture app for watch checks (#16828).
include(":wear-fixture")

// Deterministic Android TV fixture apps, Compose for TV and Leanback, for TV checks (#16736).
include(":tv-fixture")

include(":leanback-fixture")

// Deterministic Android XR glasses input fixture for glasses checks (#16842).
include(":glasses-fixture")

include(":protocol")

include(":prototype-compose")

// Saved-prototype store and device HTTP transport, split from CtrlProxy for ProtoViewer (#13617).
include(":prototype-saved")

// Standalone template APK for disposable prototype apps (#14185).
include(":prototype-app-shell")

include(":protoviewer")

include(":junit-runner")

include(":test-plan-validation")

include(":video-server")

include(":desktop-domain")

include(":desktop-core")

include(":ide-plugin")

include(":desktop-app")

include(":playground:analytics")

include(":playground:app")

include(":playground:design:assets")

include(":playground:design:system")

include(":playground:discover")

include(":playground:demos")

include(":playground:experimentation")

include(":playground:home")

include(":playground:login")

include(":playground:mediaplayer")

include(":playground:onboarding")

include(":playground:settings")

include(":playground:slides")

include(":playground:storage")

rootProject.name = "auto-mobile-android"
