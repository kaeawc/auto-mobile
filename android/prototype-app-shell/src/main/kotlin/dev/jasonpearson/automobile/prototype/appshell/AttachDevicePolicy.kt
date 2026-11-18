package dev.jasonpearson.automobile.prototype.appshell

/** Device identity is injected so listener policy can be tested without Android. */
internal fun interface AttachDeviceEnvironment {
  fun isEmulator(): Boolean
}

internal class AttachDevicePolicy(
  private val environment: AttachDeviceEnvironment,
  private val allowPhysicalDevice: Boolean = false,
) {
  fun allowsListener(): Boolean = allowPhysicalDevice || environment.isEmulator()
}
