package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient

data class DeviceInputTarget(
  val client: AutoMobileClient?,
  val platform: String,
  val deviceId: String?,
  val onError: (String) -> Unit,
  val frameContext: String,
)
