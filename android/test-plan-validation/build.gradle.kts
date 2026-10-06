import groovy.json.JsonSlurper
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

// Plan `tool:` names come from the tool registry's own schema, not a hand-kept list (#10126): this
// writes every tool name in schemas/tool-definitions.json to a resource that ValidTools reads, so the
// published artifact needs no repository checkout at runtime and the allowlist cannot drift.
val toolDefinitionsFile = layout.projectDirectory.file("../../schemas/tool-definitions.json")
val planToolNamesDir = layout.buildDirectory.dir("generated/planToolNames")

val generatePlanToolNames by
  tasks.registering {
    val definitions = toolDefinitionsFile
    val outputDir = planToolNamesDir
    inputs.file(definitions)
    outputs.dir(outputDir)
    doLast {
      val tools = JsonSlurper().parse(definitions.asFile) as List<*>
      val names = tools.map { (it as Map<*, *>)["name"] as String }.sorted()
      require(names.isNotEmpty()) { "No tools found in ${definitions.asFile}" }
      val target =
        outputDir.get().file("dev/jasonpearson/automobile/validation/plan-tool-names.txt").asFile
      target.parentFile.mkdirs()
      target.writeText(names.joinToString("\n", postfix = "\n"))
    }
  }

sourceSets.named("main") { resources.srcDir(generatePlanToolNames) }

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
      KotlinVersion.valueOf("KOTLIN_${libs.versions.build.kotlin.language.get().replace(".", "_")}")
    )
    apiVersion.set(KotlinVersion.fromVersion(libs.versions.build.kotlin.consumer.api.get()))
  }
}
