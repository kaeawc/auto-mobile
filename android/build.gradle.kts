buildscript {
  dependencies {
    // Necessary if we are to override R8
    // classpath(libs.r8)
    classpath(libs.agp)
    classpath(libs.kgp)
  }
}

plugins {
  `version-catalog`
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.kotlin.serialization) apply false
  alias(libs.plugins.compose.compiler) apply false
  // Declared here (not applied) so the Compose Multiplatform plugin shares the root
  // classloader with the hot-reload plugin below. Compose Hot Reload's
  // hasComposePluginAccess() does Class.forName("org.jetbrains.compose.ComposePlugin")
  // from its own classloader; without this the class is only visible in leaf-module
  // classloaders, the check fails ("Cannot access 'org.jetbrains.compose' plugin"),
  // and the plugin never auto-registers the :desktop-app:hotRun task.
  alias(libs.plugins.compose.multiplatform) apply false
  alias(libs.plugins.compose.hot.reload) apply false
  alias(libs.plugins.mavenPublish) apply false
  alias(libs.plugins.metro) apply false
  alias(libs.plugins.detekt) apply false
}

// Read version from gradle.properties. Modules get their group/version from the
// automobile.kotlin-common convention; the root project sets its own here (the
// former `allprojects {}` block was an Isolated Projects blocker).
group = property("GROUP") as String

version =
  property("VERSION_NAME")
    as
    String

// The Maven publication manifest preflight's local `centralManifest` repository
// (issue #4853) moved to the automobile.maven-central-manifest convention so no
// cross-project `allprojects {}` configuration remains here.
