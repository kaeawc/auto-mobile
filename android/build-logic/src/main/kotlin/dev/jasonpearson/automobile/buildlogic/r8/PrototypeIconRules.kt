package dev.jasonpearson.automobile.buildlogic.r8

import groovy.json.JsonSlurper

/** The closed reflective surface shared by rule generation and release verification. */
object PrototypeIconRules {
  val styles = listOf("filled", "outlined", "rounded", "sharp", "twotone")

  // Keep this regex and Pascal derivation identical to PrototypeIcons.kt. Its contract-wide JVM
  // test exercises the actual reflective getter for every name and style.
  private val iconName = Regex("[a-z][a-z0-9]*(_[a-z0-9]+)*")

  fun pascal(name: String): String {
    require(iconName.matches(name)) { "Invalid prototype icon name: $name" }
    return name.split('_').joinToString("") { it.replaceFirstChar(Char::uppercase) }
  }

  fun names(contract: String): List<String> {
    // The JDK has no JSON parser. gradleApi() already exposes Gradle's bundled Groovy JSON parser;
    // AGP's Gson is only a runtime dependency, not a build-logic compile dependency.
    val root = JsonSlurper().parseText(contract) as? Map<*, *>
    val definitions = root?.get("definitions") as? Map<*, *>
    val definition =
      requireNotNull(definitions?.get("iconName") as? Map<*, *>) {
        "Missing definitions.iconName in prototype contract"
      }
    require(definition["kind"] == "enum") { "definitions.iconName must be an enum" }
    val values = definition["values"] as? List<*>
    require(!values.isNullOrEmpty()) { "definitions.iconName.values must not be empty" }
    return values
      .map { value ->
        require(value is String) {
          "definitions.iconName.values must contain only strings"
        }
        value.also { pascal(it) }
      }
      .distinct()
      .sorted()
  }

  fun members(names: List<String>): List<String> = names.flatMap { name ->
    val pascal = pascal(name)
    styles.map { "androidx.compose.material.icons.$it.${pascal}Kt#get$pascal" }
  }

  fun rules(names: List<String>): String = buildString {
    appendLine("# Generated from definitions.iconName in prototype-spec-contract.json.")
    for (member in members(names)) {
      val owner = member.substringBefore('#')
      val getter = member.substringAfter('#')
      // Keep only the reflected public static getter; R8 follows its implementation dependencies.
      appendLine("-keep class $owner { public static *** $getter(...); }")
    }
  }
}
