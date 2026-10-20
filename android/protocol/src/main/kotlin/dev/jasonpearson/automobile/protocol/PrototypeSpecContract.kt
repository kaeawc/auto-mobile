package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.json
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

internal object PrototypeSpecContract {
  val pathKeyPattern = Regex("^[A-Za-z_][A-Za-z0-9_]*$")
  internal val stateKeyPattern = Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")
  val colorPattern = Regex("^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
  val blankTextPattern =
    Regex(
      "^[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$",
    )
  val numberTokenPattern = Regex("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$")
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
  val definitions = contract.getValue("definitions").jsonObject
  val limits = contract.getValue("limits").jsonObject
}
