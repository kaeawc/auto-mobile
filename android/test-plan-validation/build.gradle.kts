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
  api(libs.kotlin.stdlib.consumer)

  // YAML processing and schema validation
  implementation(libs.snakeyaml)
  implementation(libs.json.schema.validator)

  // Kotlin serialization for JSON conversion
  implementation(libs.kotlinx.serialization)

  // Test dependencies
  testImplementation(libs.kotlin.test)
  testImplementation(libs.bundles.unit.test)
}

// Configure Kotlin compilation options
tasks.withType<KotlinCompile>().configureEach {
  compilerOptions {
    languageVersion.set(
      KotlinVersion.valueOf(
        "KOTLIN_${libs.versions.build.kotlin.language.get().replace(".", "_")}",
      ),
    )
    apiVersion.set(KotlinVersion.fromVersion(libs.versions.build.kotlin.consumer.api.get()))
  }
}

// CoordinationParamsParityTest reads the fixture the daemon's TypeScript test also runs. Declaring
// it as an input keeps a fixture-only edit from reusing a cached test result.
tasks.withType<Test>().configureEach {
  inputs
    .dir(rootDir.resolve("../test/fixtures/plan-coordination-params"))
    .withPropertyName("coordinationParamsFixtures")
    .withPathSensitivity(PathSensitivity.RELATIVE)
  inputs
    .file(rootDir.resolve("../test/fixtures/plan-schedule-feasibility/cases.json"))
    .withPropertyName("scheduleFeasibilityCases")
    .withPathSensitivity(PathSensitivity.RELATIVE)
  inputs
    .file(rootDir.resolve("../schemas/tool-definitions.json"))
    .withPropertyName("toolDefinitions")
    .withPathSensitivity(PathSensitivity.RELATIVE)
}
