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
      val raw = channel.text("url").orEmpty()
      val websocket = channel.text("kind") == "websocket"
      if (websocket && !raw.startsWith("ws:", true) && !raw.startsWith("wss:", true))
        return fail("$at.url", "A websocket channel url must use ws or wss")
      val url =
        if (websocket) raw.replaceFirst(Regex("^ws(s?):", RegexOption.IGNORE_CASE), "http$1:")
        else raw
      PrototypeRequestRules.requestUrlError(url)?.let {
        return fail("$at.url", it)
      }
      val headers = channel.member("headers").orEmpty()
      for (name in headers.keys.sorted()) {
        if (name.startsWith("sec-websocket-", true) || name.equals("last-event-id", true))
          return fail(keyPath("$at.headers", name), "Forbidden channel header")
      }
      PrototypeRequestRules.requestEntryError(JsonObject(headers.toSortedMap()), at, "headers")
        ?.let {
          return it
        }
      if (!websocket && channel["protocols"] != null)
        return fail("$at.protocols", "protocols are only available for websocket channels")
      channel.text("statusKey")?.let { key ->
        val state = root.member("state").orEmpty()
        if (key !in state) return fail("$at.statusKey", "statusKey must name a declared state key")
        if ((state[key] as? JsonPrimitive)?.isString != true)
          return fail("$at.statusKey", "statusKey requires a string state key")
      }
      channel.member("reconnect")?.let {
        if (
          it.getValue("initialDelayMs").jsonPrimitive.double >
            it.getValue("maxDelayMs").jsonPrimitive.double
        )
          return fail("$at.reconnect.initialDelayMs", "initialDelayMs must not exceed maxDelayMs")
      }
      (channel["routes"] as? JsonArray).orEmpty().forEachIndexed { index, route ->
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
    return if (action.text("call") == "realtime.send" && channel.text("kind") != "websocket")
      fail("$path.call", "realtime.send requires a websocket channel")
    else null
  }

  fun validRead(pointer: String, channels: JsonObject): Boolean {
    val tokens = PrototypeDataPointer.tokens(pointer)
    return tokens.size == 3 &&
      tokens[1] in channels &&
      tokens[2] in PrototypePlatformModules.module("realtime")!!.member("state")!!
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
