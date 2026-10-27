package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.json
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object PrototypeSpecContract {
  internal val json = Json { ignoreUnknownKeys = false }
  val contract: JsonObject =
    json
      .parseToJsonElement(
        checkNotNull(javaClass.getResourceAsStream("/prototype-spec-contract.json")) {
            "Missing prototype structural contract"
          }
          .bufferedReader()
          .use { it.readText() },
      )
      .jsonObject
  // Explicit whitespace and strict end assertions keep Java, ECMAScript and ICU in agreement.
  val patterns =
    contract.getValue("patterns").jsonObject.mapValues { Regex(it.value.jsonPrimitive.content) }
  val pathKeyPattern = patterns.getValue("pathKey")
  val stateKeyPattern = patterns.getValue("stateKey")
  val colorPattern = patterns.getValue("color")
  val blankTextPattern = patterns.getValue("blankText")
  val numberTokenPattern = patterns.getValue("numberToken")
  val checkControls =
    contract.getValue("checkControls").jsonObject.mapValues {
      it.value.jsonArray.map { control -> control.jsonPrimitive.content }
    }
  val definitions = contract.getValue("definitions").jsonObject
  val limits = contract.getValue("limits").jsonObject
  val motionTokens = contract.getValue("motionTokens").jsonObject
  val checkPatternMaxLength =
    definitions
      .getValue("check")
      .jsonObject
      .getValue("fields")
      .jsonObject
      .getValue("pattern")
      .jsonObject
      .getValue("rule")
      .jsonObject
      .getValue("max")
      .jsonPrimitive
      .content
      .toInt()
}
