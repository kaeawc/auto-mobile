package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** Contract-only realtime checks. No runtime advertises or opens these channels. */
internal object PrototypeChannels {
  fun handlers(root: JsonObject): List<Pair<JsonElement, String>> = buildList {
    for ((id, value) in root.member("channels").orEmpty().toSortedMap()) {
      val channel = value as? JsonObject ?: continue
      val at = keyPath("channels", id)
      for (name in listOf("onOpen", "onClose", "onError")) channel[name]?.let {
        add(it to "$at.$name")
      }
      (channel["routes"] as? JsonArray).orEmpty().forEachIndexed { index, route ->
        (route as? JsonObject)?.get("actions")?.let { add(it to "$at.routes[$index].actions") }
      }
    }
  }

  fun error(root: JsonObject): PrototypeSpecError? {
    val channels = root.member("channels") ?: return null
    if (
      (root.member("requires")?.get("platform") as? JsonArray)?.contains(
        JsonPrimitive("realtime"),
      ) != true
    )
      return fail("channels", "Channels require realtime in requires.platform")
    for ((id, value) in channels.toSortedMap()) {
      val channel = value as JsonObject
      val at = keyPath("channels", id)
      channelError(channel, at, root)?.let {
        return it
      }
    }
    return null
  }

  private fun channelError(channel: JsonObject, at: String, root: JsonObject): PrototypeSpecError? {
    PrototypeChannelDeclarations.urlError(channel, at)?.let {
      return it
    }
    PrototypeChannelDeclarations.headersError(channel, at)?.let {
      return it
    }
    PrototypeChannelDeclarations.protocolsError(channel, at)?.let {
      return it
    }
    for (name in listOf("onOpen", "onClose", "onError")) callbackError(channel[name], "$at.$name")
      ?.let {
        return it
      }
    PrototypeChannelDeclarations.statusError(channel, at, root)?.let {
      return it
    }
    PrototypeChannelDeclarations.reconnectError(channel, at)?.let {
      return it
    }
    PrototypeChannelDeclarations.routesError(channel, at)?.let {
      return it
    }
    return null
  }

  private fun callbackError(value: JsonElement?, path: String): PrototypeSpecError? {
    (value as? JsonArray).orEmpty().forEachIndexed { index, raw ->
      val action = raw.jsonObject
      val at = "$path[$index]"
      if (
        action.text("type") in
          setOf("request", "push", "replace", "pop", "popToRoot", "dismiss", "setPage") ||
          (action.text("type") == "platform" && action.text("call") == "realtime.connect")
      )
        return fail(
          "$at.${if (action.text("type") == "platform") "call" else "type"}",
          "Channel callbacks cannot request, navigate or connect",
        )
      for (key in listOf("actions", "onSuccess", "onError")) callbackError(action[key], "$at.$key")
        ?.let {
          return it
        }
    }
    return null
  }

  fun callError(action: JsonObject, path: String, root: JsonObject): PrototypeSpecError? {
    if (action.text("call")?.startsWith("realtime.") != true) return null
    val selector = action.member("args")?.get("channel")
    val id =
      (selector as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: (selector as? JsonObject)?.text("value")
    val channel =
      id?.let { root.member("channels")?.get(it) as? JsonObject }
        ?: return fail("$path.args.channel", "channel must name a declared channel")
    val literal = action.member("args")?.member("body")?.get("value")
    if (action.text("call") == "realtime.send" && literal != null) {
      val size =
        (literal as? JsonPrimitive)
          ?.takeIf { it.isString }
          ?.content
          ?.toByteArray(Charsets.UTF_8)
          ?.size ?: jsonBytes(literal)
      if (size > PrototypeChannelLimits.maxSendBytes)
        return fail("$path.args.body.value", "realtime.send body exceeds the byte limit")
    }
    return if (action.text("call") == "realtime.send" && channel.text("kind") != "websocket")
      fail("$path.call", "realtime.send requires a websocket channel")
    else null
  }

  // Match JSON.stringify at the static send boundary, including integral/exponent number text.
  private fun jsonBytes(value: JsonElement): Int =
    when (value) {
      is JsonObject ->
        2 +
          maxOf(0, value.size - 1) +
          value.entries.sumOf { (key, child) ->
            PrototypeSpecInput.canonicalString(key).toByteArray(Charsets.UTF_8).size +
              1 +
              jsonBytes(child)
          }
      is JsonArray -> 2 + maxOf(0, value.size - 1) + value.sumOf(::jsonBytes)
      is JsonPrimitive ->
        when {
          value.isString ->
            PrototypeSpecInput.canonicalString(value.content).toByteArray(Charsets.UTF_8).size
          value.doubleOrNull != null -> PrototypeRequests.numberText(value.double).length
          else -> value.content.length
        }
    }

  fun needsRealtimeCapability(action: JsonObject): Boolean =
    action.text("type") == "upsertData" || boundedAppend(action) || needsValueCapability(action)

  private fun boundedAppend(action: JsonObject): Boolean =
    action.text("type") == "appendData" && "maxItems" in action

  fun needsValueCapability(action: JsonObject): Boolean {
    val value = action.member("value")
    return (action.text("type") in
      setOf("setState", "setData", "appendData", "prependData", "upsertData") &&
      value != null &&
      ("event" in value || "platform" in value)) ||
      (action.text("type") == "platform" &&
        action.member("args").orEmpty().values.any { (it as? JsonObject)?.text("event") == "" })
  }

  fun validRead(pointer: String, channels: JsonObject): Boolean {
    val tokens = PrototypeDataPointer.tokens(pointer)
    return tokens.size == 3 &&
      tokens[1] in channels &&
      tokens[2] in checkNotNull(PrototypePlatformModules.module("realtime")?.member("state"))
  }
}

/** Limits read from the shared contract, mirroring prototypeChannelLimits.ts. */
object PrototypeChannelLimits {
  private fun limit(name: String): Int =
    PrototypeSpecContract.limits.getValue(name).jsonPrimitive.int

  val maxChannels = limit("MAX_PROTOTYPE_CHANNELS")
  val maxFrameBytes = limit("MAX_PROTOTYPE_CHANNEL_FRAME_BYTES")
  val maxSendBytes = limit("MAX_PROTOTYPE_CHANNEL_SEND_BYTES")
  val maxChannelsOpen = limit("MAX_PROTOTYPE_CHANNELS_OPEN")
  val flushMs = limit("PROTOTYPE_CHANNEL_FLUSH_MS")
}

private object PrototypeChannelDeclarations {
  fun headersError(channel: JsonObject, at: String): PrototypeSpecError? {
    val headers = channel.member("headers").orEmpty()
    for (name in headers.keys.sorted()) {
      if (name.startsWith("sec-websocket-", true) || name.equals("last-event-id", true))
        return fail(keyPath("$at.headers", name), "Forbidden channel header")
    }
    PrototypeRequestRules.requestEntryError(JsonObject(headers.toSortedMap()), at, "headers")?.let {
      return it
    }

    return null
  }

  fun protocolsError(channel: JsonObject, at: String): PrototypeSpecError? {
    if (channel.text("kind") != "websocket" && channel["protocols"] != null)
      return fail("$at.protocols", "protocols are only available for websocket channels")
    val protocols = (channel["protocols"] as? JsonArray)?.map { it.jsonPrimitive.content }
    if (
      protocols != null &&
        (protocols.toSet().size != protocols.size ||
          protocols.any { !Regex("^[!#\$%&'*+\\-.^_`|~0-9A-Za-z]{1,64}$").matches(it) })
    )
      return fail(
        "$at.protocols",
        "protocols must be unique RFC 7230 tokens of 1 to 64 characters",
      )

    return null
  }

  fun statusError(channel: JsonObject, at: String, root: JsonObject): PrototypeSpecError? {
    channel.text("statusKey")?.let { key ->
      val state = root.member("state").orEmpty()
      if (key !in state) return fail("$at.statusKey", "statusKey must name a declared state key")
      if ((state[key] as? JsonPrimitive)?.isString != true)
        return fail("$at.statusKey", "statusKey requires a string state key")
    }

    return null
  }

  fun reconnectError(channel: JsonObject, at: String): PrototypeSpecError? {
    channel.member("reconnect")?.let {
      if (
        it.getValue("initialDelayMs").jsonPrimitive.double >
          it.getValue("maxDelayMs").jsonPrimitive.double
      )
        return fail("$at.reconnect.initialDelayMs", "initialDelayMs must not exceed maxDelayMs")
    }

    return null
  }

  fun routesError(channel: JsonObject, at: String): PrototypeSpecError? {
    (channel["routes"] as? JsonArray).orEmpty().forEachIndexed { index, route ->
      if (
        channel.text("kind") == "websocket" &&
          (route.jsonObject["when"] as? JsonObject)?.get("event") != null
      )
        return fail(
          "$at.routes[$index].when.event",
          "Event name matchers are only available for sse channels",
        )
      (route.jsonObject["actions"] as JsonArray).forEachIndexed { actionIndex, action ->
        if (
          action.jsonObject.text("type") !in
            setOf(
              "setState",
              "toggle",
              "increment",
              "decrement",
              "setData",
              "appendData",
              "prependData",
              "upsertData",
              "removeData",
            )
        )
          return fail(
            "$at.routes[$index].actions[$actionIndex].type",
            "Channel routes only allow state and data actions",
          )
      }
    }

    return null
  }

  fun urlError(channel: JsonObject, at: String): PrototypeSpecError? {
    val raw = channel.text("url").orEmpty()
    val websocket = channel.text("kind") == "websocket"
    if (websocket && !raw.startsWith("ws:", true) && !raw.startsWith("wss:", true))
      return fail("$at.url", "A websocket channel url must use ws or wss")
    // Check the authored scheme before the request parser normalizes control
    // characters/backslashes.
    val schemes = if (websocket) listOf("ws", "wss") else listOf("http", "https")
    if (schemes.none { raw.startsWith("$it://", ignoreCase = true) }) {
      val name = if (websocket) "websocket channel" else "request"
      val message =
        if ('{' in raw)
          "A templated $name url must start with a literal ${schemes.joinToString(" or ") { "$it://" }}"
        else "A $name url must be an absolute ${schemes.joinToString(" or ")} URL"
      return fail("$at.url", message)
    }
    val url =
      if (websocket) raw.replaceFirst(Regex("^ws(s?):", RegexOption.IGNORE_CASE), "http$1:")
      else raw
    PrototypeRequestRules.requestUrlError(url)?.let {
      return fail(
        "$at.url",
        if (websocket)
          it
            .replace("request", "websocket channel")
            .replace("http or https", "ws or wss")
            .replace("http:// or https://", "ws:// or wss://")
        else it,
      )
    }
    return null
  }
}
