package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Explicit-null encoding: the frames whose hand-built form wrote nulls, and the prototype frames.
 */
internal val resultFrameJson = Json {
  prettyPrint = false
  encodeDefaults = true
}

/**
 * The hand-built frames omitted absent optionals, so these typed classes are encoded with
 * `explicitNulls = false` rather than per-field `@EncodeDefault(NEVER)`: the latter would alter the
 * response fixture, which encodes the same classes with explicit nulls.
 */
private val omitNullsFrameJson = Json {
  prettyPrint = false
  encodeDefaults = true
  explicitNulls = false
}

internal fun typedResultFrame(response: WebSocketResponse): String =
  omitNullsFrameJson.encodeToString<WebSocketResponse>(response)

/**
 * For the frames whose hand-built form wrote some nulls explicitly (a `"key":null` file clear, a
 * success `"error":null`). Their classes mark the optionals the old frames omitted with
 * `@EncodeDefault(NEVER)`, so only the meaningful nulls reach the wire.
 */
internal fun explicitNullsResultFrame(response: WebSocketResponse): String =
  resultFrameJson.encodeToString<WebSocketResponse>(response)
