package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypePlatformHandlers
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray

private val testJson = Json { classDiscriminator = "type" }

/**
 * Platform handlers from typed actions; the spec keeps them as raw JSON so `{event}` can bind
 * first.
 */
internal fun platformHandlers(handlers: Map<String, List<PrototypeAction>>) =
  PrototypePlatformHandlers(
    handlers.mapValues { (_, actions) ->
      testJson.encodeToJsonElement(ListSerializer(PrototypeAction.serializer()), actions)
        as JsonArray
    },
  )
