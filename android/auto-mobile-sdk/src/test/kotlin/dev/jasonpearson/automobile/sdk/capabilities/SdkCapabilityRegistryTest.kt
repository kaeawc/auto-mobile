package dev.jasonpearson.automobile.sdk.capabilities

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SdkCapabilityRegistryTest {
  @Test
  fun `capabilities are distinct before and after initialization`() {
    val registry = SdkCapabilityRegistry()

    assertEquals(
      SdkCapabilityState.NOT_INITIALIZED,
      registry.snapshot().capabilities.first { it.id == "network.capture" }.state,
    )

    registry.markInitialized()

    assertEquals(
      SdkCapabilityState.SUPPORTED,
      registry.snapshot().capabilities.first { it.id == "network.capture" }.state,
    )
  }

  @Test
  fun `disabled state is distinct from unsupported state`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()
    registry.setEnabled(false)

    assertEquals(
      SdkCapabilityState.DISABLED,
      registry.snapshot().capabilities.first { it.id == "network.capture" }.state,
    )
    assertEquals(
      SdkCapabilityState.UNSUPPORTED,
      registry.snapshot().capabilities.first { it.id == "ui.observe" }.state,
    )
  }

  @Test
  fun `registration and removal update the document`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()
    registry.register(SdkCapabilityDescriptor("navigation.compose", SdkCapabilityState.SUPPORTED))

    assertTrue(registry.snapshot().capabilities.any { it.id == "navigation.compose" })

    registry.unregister("navigation.compose")

    assertFalse(registry.snapshot().capabilities.any { it.id == "navigation.compose" })
  }

  @Test
  fun `policy changes are complete atomic snapshots`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()

    registry.updatePolicy(SdkCapturePolicy(captureHeaders = true, captureBodies = true))

    assertEquals(
      SdkCapturePolicy(captureHeaders = true, captureBodies = true),
      registry.snapshot().policy,
    )
  }

  @Test(expected = IllegalArgumentException::class)
  fun `mutation policy requires a registered mutation capability`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()

    registry.updatePolicy(SdkCapturePolicy(allowMutations = true))
  }

  @Test
  fun `registered permission denial is preserved`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()
    registry.register(
      SdkCapabilityDescriptor(
        "network.control",
        SdkCapabilityState.PERMISSION_DENIED,
        "Host did not grant control permission",
      )
    )

    val descriptor = registry.snapshot().capabilities.first { it.id == "network.control" }
    assertEquals(SdkCapabilityState.PERMISSION_DENIED, descriptor.state)
    assertEquals("Host did not grant control permission", descriptor.reason)
  }
}
