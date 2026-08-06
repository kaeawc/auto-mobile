package dev.jasonpearson.automobile.sdk.capabilities

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
    assertEquals(
      SdkCapabilityState.UNSUPPORTED,
      registry.snapshot().capabilities.first { it.id == "storage.read" }.state,
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
  fun `removing a capability revokes its policy`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()
    registry.register(SdkCapabilityDescriptor("storage.mutation", SdkCapabilityState.SUPPORTED))
    registry.updatePolicy(SdkCapturePolicy(allowMutations = true))

    registry.unregister("storage.mutation")

    assertFalse(registry.snapshot().policy.allowMutations)
  }

  @Test
  fun `lifecycle remains unavailable until its hook is installed`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()

    assertEquals(
      SdkCapabilityState.UNSUPPORTED,
      registry.snapshot().capabilities.first { it.id == "events.lifecycle" }.state,
    )

    registry.markLifecycleReady()

    assertEquals(
      SdkCapabilityState.SUPPORTED,
      registry.snapshot().capabilities.first { it.id == "events.lifecycle" }.state,
    )
  }

  @Test
  fun `default serialization includes the schema version and false policy values`() {
    val json = Json.encodeToString(SdkCapabilityDocument.serializer(), SdkCapabilityRegistry().snapshot())

    assertTrue(json.contains("\"schemaVersion\":1"))
    assertTrue(json.contains("\"captureHeaders\":false"))
    assertTrue(json.contains("\"captureBodies\":false"))
    assertTrue(json.contains("\"allowMutations\":false"))
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
  fun `network control can authorize mutation policy independently`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()
    registry.register(SdkCapabilityDescriptor("network.control", SdkCapabilityState.SUPPORTED))

    registry.updatePolicy(SdkCapturePolicy(allowMutations = true))

    assertTrue(registry.snapshot().policy.allowMutations)
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
