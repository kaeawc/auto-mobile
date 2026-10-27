package dev.jasonpearson.automobile.prototype

import android.os.Build
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeShaderCapabilities

/** Entry point for the embedded prototype renderer. */
object AutoMobilePrototype {
  /**
   * The spec features this renderer supports. The embedding app checks a spec's required
   * capabilities against this set.
   */
  val capabilities: Set<String>
    get() = capabilitiesForSdk(Build.VERSION.SDK_INT)

  fun capabilities(platform: PrototypePlatform): Set<String> =
    (capabilities + platform.registry.capabilities).toSortedSet()

  internal fun capabilitiesForSdk(sdkInt: Int): Set<String> =
    (baseCapabilities + prototypeShaderCapabilities(sdkInt)).sorted().toSet()

  private val baseCapabilities: Set<String> =
    setOf(
      "prototype_bar_scroll_v1",
      "prototype_carousel_v1",
      "prototype_chart_v1",
      "prototype_chat_scroll_v1",
      "prototype_checks_v1",
      "prototype_choreography_v1",
      "prototype_data_actions_v1",
      "prototype_data_model_v1",
      "prototype_design_platform_v1",
      "prototype_drawer_v1",
      "prototype_emit_context_v1",
      "prototype_flow_grid_v1",
      "prototype_format_v1",
      "prototype_gestures_v1",
      "prototype_lazy_list_v1",
      "prototype_linkify_v1",
      "prototype_loading_states_v1",
      "prototype_menus_v1",
      "prototype_motion_v2",
      "prototype_network_device_v1",
      "prototype_network_v1",
      "prototype_pager_options_v1",
      "prototype_platform_device_v1",
      "prototype_platform_v1",
      "prototype_pager_state_key_v1",
      "prototype_refresh_v1",
      "prototype_rich_text_v1",
      "prototype_scroll_motion_v1",
      "prototype_search_bar_v1",
      "prototype_semantics_v1",
      "prototype_stack_transitions_v1",
      "prototype_stack_v1",
      "prototype_storage_v1",
      "prototype_style_polish_v2",
      "prototype_strings_v1",
      "prototype_string_conditions_v1",
      "prototype_swipe_actions_v1",
      "prototype_text_field_actions_v1",
      "prototype_text_field_leading_icon_v1",
      "prototype_text_field_options_v1",
      "prototype_theme_modes_v1",
      "prototype_timers_v1",
      "prototype_tooltip_v1",
    )
}
