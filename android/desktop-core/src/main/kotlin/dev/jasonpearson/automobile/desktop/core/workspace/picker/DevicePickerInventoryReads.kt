package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevicesResponse
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.workspace.Platform

internal suspend fun DevicePickerViewModel.readDeviceImages(): List<DeviceImageInfo> =
  when (val result = resourceClient.readResource(IMAGES_URI)) {
    is ResourceReadResult.Success ->
      DeviceResourceParser.parseDeviceImages(result.content)?.images
        ?: throw IllegalStateException("Malformed device-images payload")
    is ResourceReadResult.Error ->
      throw IllegalStateException("Failed to read device images: ${result.message}")
  }

internal fun completePickerSources(
  sourcePlatforms: Map<String, Platform>,
  observation: BootedDevicesResponse,
): Set<String> =
  sourcePlatforms
    .filter { (source, platform) ->
      observation.sourceObservations[source]?.observationComplete
        ?: observation.platformObservations[platform.name.lowercase()]?.observationComplete
        ?: observation.observationComplete
    }
    .keys
