import com.vanniktech.maven.publish.MavenPublishBaseExtension
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

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
  alias(libs.plugins.compose.hot.reload) apply false
  alias(libs.plugins.mavenPublish) apply false
  alias(libs.plugins.metro) apply false
  alias(libs.plugins.detekt) apply false
}

// Read version from gradle.properties. Modules get their group/version from the
// automobile.kotlin-common convention; the root project sets its own here (the
// former `allprojects {}` block was an Isolated Projects blocker).
group = property("GROUP") as String

version = property("VERSION_NAME") as String

plugins.withId(libs.plugins.mavenPublish.get().pluginId) {
  if (project.path != ":compiler") {
    apply(plugin = "org.jetbrains.dokka")
  }

  // Configure vanniktech to publish to Maven Central with automatic release
  configure<MavenPublishBaseExtension> {
    publishToMavenCentral(automaticRelease = true)
    signAllPublications()
  }

  // configuration required to produce unique META-INF/*.kotlin_module file names
  tasks.withType<KotlinCompile>().configureEach {
    compilerOptions { moduleName.set(project.property("POM_ARTIFACT_ID") as String) }
  }
}

// The Maven publication manifest preflight's local `centralManifest` repository
// (issue #4853) moved to the automobile.maven-central-manifest convention so no
// cross-project `allprojects {}` configuration remains here.
