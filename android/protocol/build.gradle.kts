import org.gradle.api.tasks.PathSensitivity
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
  id("automobile.kotlin-common")
  kotlin("jvm")
  alias(libs.plugins.kotlin.serialization)
  `java-library`
  alias(libs.plugins.mavenPublish)
  id("automobile.published-library")
}

dependencies {
  implementation(libs.kotlinx.serialization)

  testImplementation(libs.kotlin.test)
  testImplementation(libs.bundles.unit.test)
  testImplementation(libs.junit.jupiter)
}

tasks.withType<Test>().configureEach {
  useJUnitPlatform()
  inputs
    .dir(layout.projectDirectory.dir("../../test/fixtures/prototype-spec"))
    .withPathSensitivity(PathSensitivity.RELATIVE)
    .withPropertyName("prototypeSpecFixtures")
  inputs
    .dir(layout.projectDirectory.dir("../../test/fixtures/prototype-bundle"))
    .withPathSensitivity(PathSensitivity.RELATIVE)
    .withPropertyName("prototypeBundleFixtures")
  inputs
    .dir(layout.projectDirectory.dir("../../test/fixtures/android-contract"))
    .withPathSensitivity(PathSensitivity.RELATIVE)
    .withPropertyName("androidWireContractFixtures")
  val fixtureOutput = providers.environmentVariable("AUTOMOBILE_FIXTURE_OUT_DIR")
  inputs.property("wireContractOutputDirectory", fixtureOutput.orElse(""))
  if (fixtureOutput.isPresent) {
    environment("AUTOMOBILE_FIXTURE_OUT_DIR", fixtureOutput.get())
    outputs.upToDateWhen { false }
    outputs.doNotCacheIf("Regenerating wire contract fixture") { true }
  }
}

// Configure Kotlin compilation options
tasks.withType<KotlinCompile>().configureEach {
  compilerOptions {
    languageVersion.set(
      KotlinVersion.valueOf(
        "KOTLIN_${libs.versions.build.kotlin.language.get().replace(".", "_")}",
      ),
    )
  }
}

// The structural vocabulary and the asset limits are packaged with the JVM artifact and imported by
// TypeScript.
sourceSets.main {
  resources.srcDir(layout.projectDirectory.dir("../../schemas"))
  resources.include("prototype-spec-contract.json")
  resources.include("prototype-asset-contract.json")
}
