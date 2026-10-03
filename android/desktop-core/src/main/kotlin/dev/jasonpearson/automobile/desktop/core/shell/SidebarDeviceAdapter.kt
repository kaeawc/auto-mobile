package dev.jasonpearson.automobile.desktop.core.shell

import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceIdentity
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceLifecycle
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceRuntime
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import dev.jasonpearson.automobile.desktop.core.mcp.knownSourceImageId

/** Preserve runtime IDs for selection/actions and source identity for the shell's device model. */
internal fun BootedDevice.toSidebarDeviceInfo(): BootedDeviceInfo =
  BootedDeviceInfo(
    name = name,
    platform =
      if (type == DeviceType.iOSSimulator || type == DeviceType.iOSPhysical) "ios" else "android",
    isVirtual = type == DeviceType.AndroidEmulator || type == DeviceType.iOSSimulator,
    identity = DeviceIdentity(knownSourceImageId() ?: id),
    identityUnresolved = knownSourceImageId() == null,
    runtime =
      DeviceRuntime(deviceId = id, lifecycle = DeviceLifecycle(state = status, known = true)),
  )
