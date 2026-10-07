package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.WebSocketRequest
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.serialization.descriptors.elementDescriptors
import kotlinx.serialization.descriptors.elementNames
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Advertisement checks need neither an Android runner nor a started server. */
class CommandAdvertisementTest {
  private val scope = TestScope()
  private val requestDescriptor = WebSocketRequest.serializer().descriptor
  private val subtypeDescriptor =
    requestDescriptor.getElementDescriptor(requestDescriptor.getElementIndex("value"))
  private val sealedRequestTypes =
    subtypeDescriptor.elementDescriptors.map { it.serialName }.toSet()
  private val knownFlags =
    setOf(
      "node_selector_actions",
      "ime_key_events_v1",
      "ime_clear_field_v1",
      "ime_password_commit_v1",
      "tap_double_v1",
      "gesture_display_id_v1",
      "overlay_display_id_v1",
      "overlay_window_options_v1",
      "overlay_persistence_replay_v1",
      "full_command_set_v1",
      "request_id_echo_v1",
    )

  @After
  fun tearDown() {
    scope.cancel()
  }

  @Test
  fun `complete advertisement contains every sealed request on each supported API`() {
    for (sdk in listOf(29, 30, 36)) {
      val commands = WebSocketServer(port = 0, scope = scope, sdkInt = { sdk }).supportedCommands()
      assertTrue("All sealed requests on API $sdk", commands.containsAll(sealedRequestTypes))
      assertTrue(commands.contains("full_command_set_v1"))
      assertTrue("Request ID echo on API $sdk", commands.contains("request_id_echo_v1"))
      assertTrue(commands.contains("node_selector_actions"))
      assertTrue(commands.contains("ime_key_events_v1"))
      assertTrue(commands.contains("ime_clear_field_v1"))
      assertTrue(commands.contains("ime_password_commit_v1"))
      assertTrue(commands.contains("tap_double_v1"))
      assertTrue(commands.contains("overlay_window_options_v1"))
      assertTrue(commands.contains("overlay_persistence_replay_v1"))
      assertTrue(commands.contains("inspect_overlays"))
      assertEquals(commands.size, commands.toSet().size)
      assertTrue(commands.all { it in sealedRequestTypes || it in knownFlags })
      assertTrue(commands.contains("request_tap_coordinates"))
      assertTrue(commands.contains("request_set_text"))
      assertTrue(commands.contains("request_select_all"))
      assertFalse(commands.contains("request_press_key"))
      assertEquals(
        sdk >= GestureDisplayRouting.DISPLAY_API,
        commands.contains("gesture_display_id_v1"),
      )
      assertEquals(
        sdk >= GestureDisplayRouting.DISPLAY_API,
        commands.contains("overlay_display_id_v1"),
      )
    }
  }

  @Test
  fun `advertised requests match the wire decoder discriminator names`() {
    val commands =
      WebSocketServer(port = 0, scope = scope, sdkInt = { GestureDisplayRouting.DISPLAY_API })
        .supportedCommands()
        .filterNot { it in knownFlags }
    // protocolJson.decodeFromString<WebSocketRequest> uses this sealed serializer's subtype lookup.
    // Descriptor membership avoids inventing payloads for requests with required fields.
    val decoderNames = subtypeDescriptor.elementNames.toSet()
    assertEquals(decoderNames, commands.toSet())
    for (command in commands) {
      val index = subtypeDescriptor.getElementIndex(command)
      assertTrue("Wire decoder recognizes $command", index >= 0)
      assertEquals(command, subtypeDescriptor.getElementDescriptor(index).serialName)
    }
  }

  @Test
  fun `adding a sealed dispatchable request cannot leave it unadvertised`() {
    // CtrlProxyMessageHandler.handleMessage has an exhaustive when over WebSocketRequest.
    // Every sealed subtype must therefore be dispatched; a new subtype grows this expected set
    // automatically, so replacing the hierarchy derivation with an incomplete static list fails.
    val advertisedRequests =
      WebSocketServer(port = 0, scope = scope, sdkInt = { GestureDisplayRouting.DISPLAY_API })
        .supportedCommands()
        .toSet() - knownFlags
    assertEquals(sealedRequestTypes, advertisedRequests)
  }
}
