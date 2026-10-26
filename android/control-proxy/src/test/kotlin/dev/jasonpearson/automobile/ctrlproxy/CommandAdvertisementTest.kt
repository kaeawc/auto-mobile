package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeDisplayRouting
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
      "prototype_saved_v1",
      "prototype_storage_v1",
      "node_selector_actions",
      "ime_key_events_v1",
      "ime_clear_field_v1",
      "ime_password_commit_v1",
      "ime_inserted_text_v1",
      "ime_commit_trace_v1",
      "tap_double_v1",
      "multi_finger_gesture_v1",
      "network_mock_rules_report_v1",
      "sdk_capabilities_user_id_v1",
      "gesture_display_id_v1",
      "prototype_display_id_v1",
      "prototype_display_id_v2",
      "prototype_multi_surface_v1",
      "prototype_window_options_v1",
      "prototype_window_chrome_v1",
      "prototype_theme_modes_v1",
      "prototype_timers_v1",
      "prototype_flow_grid_v1",
      "prototype_pager_options_v1",
      "prototype_data_model_v1",
      "prototype_data_actions_v1",
      "prototype_network_v1",
      "prototype_network_device_v1",
      "prototype_platform_v1",
      "prototype_platform_test_v1",
      "prototype_platform_device_v1",
      "prototype_text_field_options_v1",
      "prototype_gestures_v1",
      "prototype_swipe_actions_v1",
      "prototype_text_field_actions_v1",
      "prototype_carousel_v1",
      "prototype_text_field_leading_icon_v1",
      "prototype_refresh_v1",
      "prototype_search_bar_v1",
      "prototype_rich_text_v1",
      "prototype_loading_states_v1",
      "prototype_style_polish_v2",
      "prototype_motion_v2",
      "prototype_choreography_v1",
      "prototype_stack_transitions_v1",
      "prototype_chart_v1",
      "prototype_linkify_v1",
      "prototype_chat_scroll_v1",
      "prototype_emit_context_v1",
      "prototype_checks_v1",
      "prototype_appearance_v1",
      "prototype_backdrop_v1",
      "prototype_persistence_replay_v1",
      "prototype_show_in_place_v1",
      "prototype_patch_v1",
      "prototype_stack_v1",
      "prototype_anchor_v1",
      "prototype_window_metadata_v1",
      "screenshot_hide_prototype_v1",
      "prototype_menus_v1",
      "semantic_node_actions_v1",
      "global_action_power_dialog_v1",
      "global_action_quick_settings_v1",
      "global_action_split_screen_v1",
      "global_action_lock_screen_v1",
      "global_action_screenshot_v1",
      "global_action_dismiss_notification_shade_v1",
      "full_command_set_v1",
      "request_id_echo_v1",
    )

  @After
  fun tearDown() {
    scope.cancel()
  }

  @Test
  fun `complete advertisement contains every sealed request on each supported API`() {
    for (sdk in listOf(29, 30, 31, 32, 33, 34, 35, 36)) {
      val commands =
        WebSocketServer(port = 0, scope = scope, options = WebSocketServerOptions(sdkInt = { sdk }))
          .supportedCommands()
      assertTrue("All sealed requests on API $sdk", commands.containsAll(sealedRequestTypes))
      assertTrue("Request ID echo on API $sdk", commands.contains("request_id_echo_v1"))
      assertCoreCommands(commands)
      assertPrototypeCommands(commands)
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
        sdk >= PrototypeDisplayRouting.DISPLAY_API,
        commands.contains("prototype_display_id_v1"),
      )
      assertEquals(
        sdk >= PrototypeDisplayRouting.DISPLAY_API,
        commands.contains("prototype_display_id_v2"),
      )
      assertEquals(
        SystemGlobalActions.advertisedFlags(sdk),
        commands.filter { it.startsWith("global_action_") },
      )
      assertEquals(sdk >= 28, commands.contains("global_action_lock_screen_v1"))
      assertEquals(sdk >= 31, commands.contains("global_action_dismiss_notification_shade_v1"))
    }
  }

  private fun assertCoreCommands(commands: List<String>) {
    assertTrue(commands.contains("full_command_set_v1"))
    assertTrue(commands.contains("node_selector_actions"))
    assertTrue(commands.contains("ime_key_events_v1"))
    assertTrue(commands.contains("ime_clear_field_v1"))
    assertTrue(commands.contains("ime_password_commit_v1"))
    assertTrue(commands.contains("ime_inserted_text_v1"))
    assertTrue(commands.contains("ime_commit_trace_v1"))
    assertTrue(commands.contains("tap_double_v1"))
    assertTrue(commands.contains("multi_finger_gesture_v1"))
  }

  private fun assertPrototypeCommands(commands: List<String>) {
    assertTrue(commands.contains("prototype_multi_surface_v1"))
    assertTrue(commands.contains("prototype_window_options_v1"))
    assertTrue(commands.contains("prototype_window_chrome_v1"))
    assertTrue(commands.contains("prototype_theme_modes_v1"))
    assertTrue(commands.contains("prototype_flow_grid_v1"))
    assertTrue(commands.contains("prototype_pager_options_v1"))
    assertTrue(commands.contains("prototype_data_model_v1"))
    assertTrue(commands.contains("prototype_data_actions_v1"))
    assertTrue(commands.contains("prototype_network_v1"))
    assertTrue(commands.contains("prototype_network_device_v1"))
    assertTrue(commands.contains("prototype_platform_v1"))
    assertTrue(commands.contains("prototype_platform_device_v1"))
    assertFalse(commands.contains("prototype_platform_test_v1"))
    assertTrue(commands.contains("prototype_text_field_options_v1"))
    assertTrue(commands.contains("prototype_gestures_v1"))
    assertTrue(commands.contains("prototype_swipe_actions_v1"))
    assertTrue(commands.contains("prototype_text_field_actions_v1"))
    assertTrue(commands.contains("prototype_carousel_v1"))
    assertTrue(commands.contains("prototype_text_field_leading_icon_v1"))
    assertTrue(commands.contains("prototype_refresh_v1"))
    assertTrue(commands.contains("prototype_search_bar_v1"))
    assertTrue(commands.contains("prototype_rich_text_v1"))
    assertTrue(commands.contains("prototype_linkify_v1"))
    assertTrue(commands.contains("prototype_chat_scroll_v1"))
    assertTrue(commands.contains("prototype_emit_context_v1"))
    assertTrue(commands.contains("prototype_checks_v1"))
    assertTrue(commands.contains("prototype_style_polish_v2"))
    assertTrue(commands.contains("prototype_appearance_v1"))
    assertTrue(commands.contains("prototype_persistence_replay_v1"))
    assertTrue(commands.contains("prototype_saved_v1"))
    assertTrue(commands.contains("prototype_show_in_place_v1"))
    assertTrue(commands.contains("prototype_stack_v1"))
    assertTrue(commands.contains("prototype_anchor_v1"))
    assertTrue(commands.contains("inspect_prototypes"))
    assertTrue(commands.contains("patch_prototype"))
    assertTrue(commands.contains("prototype_patch_v1"))
    assertTrue(commands.contains("network_mock_rules_report_v1"))
    assertTrue(commands.contains("prototype_window_metadata_v1"))
    assertTrue(commands.contains("prototype_menus_v1"))
    assertTrue(commands.contains("screenshot_hide_prototype_v1"))
    assertTrue(commands.contains("sdk_capabilities_user_id_v1"))
  }

  @Test
  fun `advertised requests match the wire decoder discriminator names`() {
    val commands =
      WebSocketServer(
          port = 0,
          scope = scope,
          options = WebSocketServerOptions(sdkInt = { GestureDisplayRouting.DISPLAY_API }),
        )
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
      WebSocketServer(
          port = 0,
          scope = scope,
          options = WebSocketServerOptions(sdkInt = { GestureDisplayRouting.DISPLAY_API }),
        )
        .supportedCommands()
        .toSet() - knownFlags
    assertEquals(sealedRequestTypes, advertisedRequests)
  }
}
