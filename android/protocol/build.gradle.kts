import org.gradle.api.tasks.PathSensitivity
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
  id("automobile.kotlin-common")
  kotlin("jvm")
  alias(libs.plugins.kotlin.serialization)
  `java-library`
  alias(libs.plugins.mavenPublish)
}

java {
  toolchain { languageVersion.set(JavaLanguageVersion.of(libs.versions.build.java.target.get())) }
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

// Version comes from root project's gradle.properties (VERSION_NAME)

mavenPublishing {
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
