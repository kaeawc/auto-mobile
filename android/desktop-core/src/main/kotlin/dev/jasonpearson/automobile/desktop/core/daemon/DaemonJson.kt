package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.Json

/** Canonical wire JSON configuration for clients that communicate with the AutoMobile daemon. */
internal val DaemonJson = Json {
  ignoreUnknownKeys = true
  encodeDefaults = true
  explicitNulls = false
}
