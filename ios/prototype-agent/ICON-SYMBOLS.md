# Prototype icon names on iOS (SF Symbols)

Generated from schemas/prototype-ios-icon-symbols.json; do not edit. Regenerate: bun scripts/ios/generate-prototype-icon-symbols.ts

- Contract icon names: 2075
- Mapped to an SF Symbol: 934
- Fallback (draw the placeholder): 1141
- Mapped names with a filled form: 542
- Mapped names with an outlined form: 558
- Minimum iOS: 17.0
- Placeholder symbol: `questionmark.square`

## Rules

iOS draws Apple SF Symbols only, never Material artwork. A contract name without an honest SF Symbol equivalent draws the placeholder, and the host lists it in `platformNotes`. Symbols Apple restricts to its own products or services (per the `symbol_restrictions` list in macOS CoreGlyphs, for example `video`, `icloud.*`, `iphone`, `ipad`, `touchid`, `applewatch`, `safari`) are never used, which is why names such as `videocam`, `cloud_upload`, `fingerprint` and `phone_iphone` are fallbacks. Several Material names may share one symbol where SF Symbols has no finer distinction. The `filled` and `outlined` icon-node variants use the listed form when present; otherwise, and for `rounded`, `sharp` and `twoTone`, the default symbol is drawn. At runtime a symbol the OS cannot load falls back to the entry's default symbol, then the placeholder.

## Fallback names (1141)

- `account_tree`
- `ad_units`
- `adb`
- `add_a_photo`
- `add_alarm`
- `add_alert`
- `add_business`
- `add_card`
- `add_chart`
- `add_home`
- `add_home_work`
- `add_location`
- `add_location_alt`
- `add_moderator`
- `add_reaction`
- `add_road`
- `add_task`
- `add_to_drive`
- `add_to_home_screen`
- `add_to_queue`
- `addchart`
- `adjust`
- `admin_panel_settings`
- `ads_click`
- `agriculture`
- `airline_seat_flat`
- `airline_seat_flat_angled`
- `airline_seat_individual_suite`
- `airline_seat_legroom_extra`
- `airline_seat_legroom_normal`
- `airline_seat_legroom_reduced`
- `airline_seat_recline_extra`
- `airline_seat_recline_normal`
- `airline_stops`
- `airlines`
- `airplane_ticket`
- `airplanemode_inactive`
- `alarm_add`
- `alarm_off`
- `alarm_on`
- `all_out`
- `amp_stories`
- `anchor`
- `android`
- `animation`
- `announcement`
- `aod`
- `api`
- `app_blocking`
- `app_registration`
- `app_settings_alt`
- `app_shortcut`
- `apps_outage`
- `architecture`
- `area_chart`
- `arrow_drop_down_circle`
- `art_track`
- `assignment_late`
- `assignment_return`
- `assignment_returned`
- `assignment_turned_in`
- `assist_walker`
- `assistant`
- `assistant_direction`
- `assured_workload`
- `atm`
- `attach_email`
- `attractions`
- `attribution`
- `audio_file`
- `auto_awesome_motion`
- `auto_delete`
- `auto_fix_normal`
- `auto_fix_off`
- `auto_graph`
- `auto_mode`
- `autofps_select`
- `baby_changing_station`
- `back_hand`
- `backup`
- `backup_table`
- `bakery_dining`
- `balance`
- `balcony`
- `batch_prediction`
- `battery_1_bar`
- `battery_2_bar`
- `battery_4_bar`
- `battery_5_bar`
- `battery_6_bar`
- `battery_alert`
- `battery_saver`
- `battery_unknown`
- `bedroom_baby`
- `bedroom_child`
- `bedroom_parent`
- `bedtime_off`
- `beenhere`
- `bento`
- `bike_scooter`
- `biotech`
- `blender`
- `blind`
- `bloodtype`
- `bluetooth`
- `bluetooth_audio`
- `bluetooth_connected`
- `bluetooth_disabled`
- `bluetooth_drive`
- `bluetooth_searching`
- `blur_circular`
- `blur_linear`
- `blur_off`
- `blur_on`
- `book_online`
- `bookmark_add`
- `bookmark_added`
- `bookmarks`
- `border_bottom`
- `border_color`
- `border_horizontal`
- `border_inner`
- `border_left`
- `border_right`
- `border_style`
- `border_top`
- `border_vertical`
- `boy`
- `branding_watermark`
- `breakfast_dining`
- `brightness_2`
- `brightness_4`
- `brightness_6`
- `brightness_auto`
- `brightness_medium`
- `broadcast_on_home`
- `broadcast_on_personal`
- `broken_image`
- `browse_gallery`
- `browser_updated`
- `brunch_dining`
- `bubble_chart`
- `bug_report`
- `build_circle`
- `bungalow`
- `bus_alert`
- `cabin`
- `calculate`
- `calendar_view_month`
- `calendar_view_week`
- `call_missed`
- `call_missed_outgoing`
- `call_to_action`
- `camera`
- `camera_enhance`
- `camera_front`
- `camera_indoor`
- `camera_outdoor`
- `camera_rear`
- `cancel_schedule_send`
- `candlestick_chart`
- `car_crash`
- `car_rental`
- `car_repair`
- `carpenter`
- `cases`
- `cast`
- `cast_connected`
- `cast_for_education`
- `castle`
- `catching_pokemon`
- `category`
- `cell_wifi`
- `center_focus_strong`
- `center_focus_weak`
- `chalet`
- `charging_station`
- `chat`
- `checklist_rtl`
- `checkroom`
- `child_care`
- `chrome_reader_mode`
- `church`
- `circle_notifications`
- `cleaning_services`
- `clear_all`
- `closed_caption_disabled`
- `closed_caption_off`
- `cloud_done`
- `cloud_download`
- `cloud_off`
- `cloud_queue`
- `cloud_sync`
- `cloud_upload`
- `co_present`
- `code_off`
- `coffee_maker`
- `collections_bookmark`
- `comment_bank`
- `comments_disabled`
- `commit`
- `commute`
- `compare`
- `compass_calibration`
- `compress`
- `connect_without_contact`
- `connected_tv`
- `connecting_airports`
- `construction`
- `contact_emergency`
- `contact_mail`
- `contact_phone`
- `contactless`
- `content_paste_go`
- `content_paste_off`
- `content_paste_search`
- `control_camera`
- `control_point_duplicate`
- `cookie`
- `cottage`
- `countertops`
- `credit_card_off`
- `credit_score`
- `crib`
- `crisis_alert`
- `crop_169`
- `crop_32`
- `crop_54`
- `crop_75`
- `crop_din`
- `crop_landscape`
- `crop_original`
- `crop_portrait`
- `crop_square`
- `cruelty_free`
- `css`
- `currency_bitcoin`
- `currency_exchange`
- `dashboard_customize`
- `data_array`
- `data_exploration`
- `data_saver_off`
- `data_saver_on`
- `data_thresholding`
- `data_usage`
- `dataset_linked`
- `deblur`
- `deck`
- `delete_forever`
- `delete_sweep`
- `delivery_dining`
- `density_large`
- `density_medium`
- `density_small`
- `departure_board`
- `deselect`
- `desk`
- `desktop_access_disabled`
- `details`
- `developer_board`
- `developer_board_off`
- `developer_mode`
- `device_hub`
- `device_unknown`
- `devices`
- `devices_fold`
- `devices_other`
- `dialer_sip`
- `difference`
- `directions_off`
- `dirty_lens`
- `disabled_visible`
- `disc_full`
- `display_settings`
- `diversity_1`
- `diversity_2`
- `diversity_3`
- `do_disturb_alt`
- `do_disturb_off`
- `do_not_disturb_off`
- `do_not_disturb_on_total_silence`
- `do_not_step`
- `do_not_touch`
- `dock`
- `domain_add`
- `domain_disabled`
- `domain_verification`
- `done_all`
- `donut_large`
- `donut_small`
- `door_back`
- `doorbell`
- `download_done`
- `drag_indicator`
- `drive_file_move`
- `drive_file_move_rtl`
- `drive_folder_upload`
- `dry`
- `duo`
- `dvr`
- `dynamic_feed`
- `dynamic_form`
- `e_mobiledata`
- `earbuds_battery`
- `edgesensor_high`
- `edgesensor_low`
- `edit_attributes`
- `edit_calendar`
- `edit_location`
- `edit_location_alt`
- `edit_notifications`
- `edit_road`
- `egg`
- `egg_alt`
- `elderly`
- `elderly_woman`
- `electric_bike`
- `electric_car`
- `electric_meter`
- `electric_moped`
- `electric_rickshaw`
- `elevator`
- `emergency_recording`
- `emergency_share`
- `emoji_nature`
- `emoji_symbols`
- `energy_savings_leaf`
- `engineering`
- `enhanced_encryption`
- `escalator`
- `escalator_warning`
- `event_note`
- `event_repeat`
- `explicit`
- `explore`
- `explore_off`
- `exposure_neg_1`
- `exposure_neg_2`
- `exposure_plus_1`
- `exposure_plus_2`
- `exposure_zero`
- `extension_off`
- `face`
- `face_2`
- `face_3`
- `face_4`
- `face_5`
- `face_6`
- `face_retouching_natural`
- `face_retouching_off`
- `facebook`
- `fact_check`
- `factory`
- `featured_video`
- `female`
- `fence`
- `fiber_dvr`
- `fiber_new`
- `fiber_pin`
- `fiber_smart_record`
- `file_download_done`
- `file_download_off`
- `file_open`
- `file_present`
- `filter`
- `filter_1`
- `filter_2`
- `filter_3`
- `filter_4`
- `filter_5`
- `filter_6`
- `filter_7`
- `filter_8`
- `filter_9`
- `filter_9_plus`
- `filter_alt_off`
- `filter_b_and_w`
- `filter_drama`
- `filter_frames`
- `filter_hdr`
- `filter_list_off`
- `filter_tilt_shift`
- `filter_vintage`
- `find_replace`
- `fingerprint`
- `fire_extinguisher`
- `fire_hydrant_alt`
- `fire_truck`
- `fit_screen`
- `fitbit`
- `flaky`
- `flare`
- `flight_class`
- `flip_to_back`
- `flip_to_front`
- `flood`
- `flutter_dash`
- `fmd_bad`
- `folder_copy`
- `folder_off`
- `folder_open`
- `folder_special`
- `folder_zip`
- `follow_the_signs`
- `font_download`
- `font_download_off`
- `food_bank`
- `forest`
- `fork_left`
- `fork_right`
- `format_clear`
- `format_color_fill`
- `format_color_reset`
- `format_color_text`
- `format_line_spacing`
- `format_list_numbered_rtl`
- `format_overline`
- `format_paint`
- `format_shapes`
- `format_textdirection_l_to_r`
- `format_textdirection_r_to_l`
- `fort`
- `foundation`
- `free_breakfast`
- `free_cancellation`
- `g_mobiledata`
- `g_translate`
- `gas_meter`
- `gavel`
- `generating_tokens`
- `gesture`
- `gif`
- `gif_box`
- `girl`
- `gite`
- `golf_course`
- `gradient`
- `grain`
- `grass`
- `grid_4x_4`
- `grid_goldenratio`
- `grid_off`
- `group_add`
- `group_remove`
- `group_work`
- `groups_2`
- `groups_3`
- `h_mobiledata`
- `h_plus_mobiledata`
- `hail`
- `handshake`
- `hd`
- `hdr_auto`
- `hdr_auto_select`
- `hdr_enhanced_select`
- `hdr_off`
- `hdr_off_select`
- `hdr_on`
- `hdr_on_select`
- `hdr_plus`
- `hdr_strong`
- `hdr_weak`
- `headphones_battery`
- `headset_mic`
- `headset_off`
- `hearing_disabled`
- `heart_broken`
- `heat_pump`
- `hevc`
- `hide_image`
- `hide_source`
- `high_quality`
- `highlight_alt`
- `history_edu`
- `history_toggle_off`
- `hive`
- `hls`
- `hls_off`
- `holiday_village`
- `home_max`
- `home_mini`
- `home_repair_service`
- `home_work`
- `horizontal_distribute`
- `hot_tub`
- `hotel_class`
- `hourglass_bottom`
- `hourglass_disabled`
- `hourglass_empty`
- `hourglass_full`
- `hourglass_top`
- `house_siding`
- `houseboat`
- `how_to_vote`
- `html`
- `http`
- `hub`
- `hvac`
- `icecream`
- `image_not_supported`
- `image_search`
- `imagesearch_roller`
- `important_devices`
- `incomplete_circle`
- `insert_page_break`
- `insights`
- `install_desktop`
- `install_mobile`
- `integration_instructions`
- `interests`
- `interpreter_mode`
- `inventory_2`
- `invert_colors_off`
- `iron`
- `iso`
- `javascript`
- `join_full`
- `join_inner`
- `join_left`
- `join_right`
- `kayaking`
- `kebab_dining`
- `keyboard_double_arrow_down`
- `keyboard_double_arrow_up`
- `keyboard_tab`
- `king_bed`
- `kitesurfing`
- `label_important`
- `label_off`
- `landslide`
- `laptop_chromebook`
- `laptop_windows`
- `layers_clear`
- `leaderboard`
- `leak_add`
- `leak_remove`
- `leave_bags_at_home`
- `legend_toggle`
- `lens_blur`
- `library_add_check`
- `line_axis`
- `line_style`
- `line_weight`
- `linear_scale`
- `link_off`
- `linked_camera`
- `live_tv`
- `local_car_wash`
- `local_convenience_store`
- `local_drink`
- `local_florist`
- `local_library`
- `local_pharmacy`
- `local_pizza`
- `local_post_office`
- `local_taxi`
- `lock_clock`
- `lock_person`
- `lock_reset`
- `logo_dev`
- `looks`
- `low_priority`
- `loyalty`
- `lte_mobiledata`
- `lte_plus_mobiledata`
- `lunch_dining`
- `lyrics`
- `macro_off`
- `mail_lock`
- `male`
- `man_2`
- `man_3`
- `man_4`
- `manage_accounts`
- `manage_history`
- `maps_home_work`
- `maps_ugc`
- `margin`
- `mark_chat_read`
- `mark_chat_unread`
- `mark_email_read`
- `mark_unread_chat_alt`
- `markunread_mailbox`
- `maximize`
- `media_bluetooth_off`
- `media_bluetooth_on`
- `mediation`
- `medical_information`
- `menu_open`
- `mic_external_off`
- `mic_external_on`
- `minimize`
- `minor_crash`
- `missed_video_call`
- `mms`
- `mobile_friendly`
- `mobile_off`
- `mobile_screen_share`
- `mobiledata_off`
- `mode`
- `mode_fan_off`
- `mode_of_travel`
- `mode_standby`
- `model_training`
- `money_off`
- `money_off_csred`
- `monochrome_photos`
- `mood_bad`
- `moped`
- `more`
- `more_time`
- `mosque`
- `motion_photos_auto`
- `motion_photos_off`
- `motion_photos_on`
- `motion_photos_pause`
- `motion_photos_paused`
- `motorcycle`
- `move_down`
- `move_up`
- `movie`
- `movie_creation`
- `movie_filter`
- `moving`
- `mp`
- `multiline_chart`
- `multiple_stop`
- `museum`
- `music_off`
- `music_video`
- `nat`
- `nature_people`
- `nearby_error`
- `nearby_off`
- `nest_cam_wired_stand`
- `network_check`
- `network_locked`
- `network_ping`
- `network_wifi_1_bar`
- `network_wifi_2_bar`
- `network_wifi_3_bar`
- `new_label`
- `new_releases`
- `next_week`
- `nfc`
- `night_shelter`
- `nightlife`
- `nights_stay`
- `no_adult_content`
- `no_backpack`
- `no_cell`
- `no_crash`
- `no_drinks`
- `no_food`
- `no_luggage`
- `no_meals`
- `no_meeting_room`
- `no_photography`
- `no_sim`
- `no_stroller`
- `no_transfer`
- `noise_aware`
- `noise_control_off`
- `nordic_walking`
- `not_accessible`
- `not_listed_location`
- `not_started`
- `note_alt`
- `notification_add`
- `notification_important`
- `notifications_paused`
- `offline_bolt`
- `offline_pin`
- `offline_share`
- `oil_barrel`
- `on_device_training`
- `online_prediction`
- `open_in_browser`
- `open_in_new_off`
- `other_houses`
- `outdoor_grill`
- `outlined_flag`
- `output`
- `padding`
- `pages`
- `panorama_photosphere`
- `panorama_photosphere_select`
- `panorama_vertical`
- `panorama_vertical_select`
- `panorama_wide_angle`
- `panorama_wide_angle_select`
- `paragliding`
- `party_mode`
- `password`
- `pattern`
- `pending_actions`
- `perm_camera_mic`
- `perm_contact_calendar`
- `perm_data_setting`
- `perm_device_information`
- `perm_media`
- `perm_scan_wifi`
- `person_2`
- `person_3`
- `person_4`
- `person_add_disabled`
- `person_pin`
- `person_pin_circle`
- `person_search`
- `personal_injury`
- `pest_control_rodent`
- `phishing`
- `phone_android`
- `phone_bluetooth_speaker`
- `phone_callback`
- `phone_disabled`
- `phone_iphone`
- `phone_locked`
- `phone_missed`
- `phone_paused`
- `phonelink`
- `phonelink_erase`
- `phonelink_lock`
- `phonelink_off`
- `phonelink_ring`
- `phonelink_setup`
- `photo_camera_back`
- `photo_camera_front`
- `photo_filter`
- `photo_size_select_actual`
- `photo_size_select_large`
- `photo_size_select_small`
- `php`
- `piano_off`
- `picture_as_pdf`
- `pin_drop`
- `pin_end`
- `pin_invoke`
- `pinch`
- `pivot_table_chart`
- `pix`
- `plagiarism`
- `play_disabled`
- `play_for_work`
- `play_lesson`
- `playlist_add_check_circle`
- `playlist_add_circle`
- `playlist_play`
- `plus_one`
- `podcasts`
- `point_of_sale`
- `policy`
- `polyline`
- `polymer`
- `portable_wifi_off`
- `power_input`
- `power_off`
- `precision_manufacturing`
- `pregnant_woman`
- `present_to_all`
- `price_change`
- `price_check`
- `print_disabled`
- `private_connectivity`
- `production_quantity_limits`
- `propane`
- `propane_tank`
- `psychology_alt`
- `public_off`
- `published_with_changes`
- `punch_clock`
- `query_stats`
- `queue`
- `queue_play_next`
- `quickreply`
- `quiz`
- `r_mobiledata`
- `radar`
- `railway_alert`
- `ramen_dining`
- `ramp_left`
- `ramp_right`
- `raw_off`
- `raw_on`
- `real_estate_agent`
- `receipt`
- `receipt_long`
- `recent_actors`
- `recommend`
- `record_voice_over`
- `reduce_capacity`
- `remember_me`
- `remove_done`
- `remove_from_queue`
- `remove_moderator`
- `remove_road`
- `remove_shopping_cart`
- `repartition`
- `repeat_on`
- `repeat_one_on`
- `report_off`
- `request_page`
- `request_quote`
- `reset_tv`
- `restore_from_trash`
- `restore_page`
- `rice_bowl`
- `rocket`
- `rocket_launch`
- `roofing`
- `room_preferences`
- `room_service`
- `roundabout_left`
- `roundabout_right`
- `rounded_corner`
- `rsvp`
- `rtt`
- `rule`
- `rule_folder`
- `running_with_errors`
- `rv_hookup`
- `safety_check`
- `safety_divider`
- `sanitizer`
- `satellite`
- `satellite_alt`
- `save_as`
- `saved_search`
- `savings`
- `scale`
- `scanner`
- `schedule_send`
- `schema`
- `score`
- `scoreboard`
- `screen_lock_landscape`
- `screen_lock_portrait`
- `screen_lock_rotation`
- `screen_rotation`
- `screen_rotation_alt`
- `screen_share`
- `screenshot`
- `screenshot_monitor`
- `scuba_diving`
- `sd_card_alert`
- `search_off`
- `security_update`
- `security_update_good`
- `security_update_warning`
- `segment`
- `send_and_archive`
- `send_time_extension`
- `send_to_mobile`
- `sensor_door`
- `sensor_occupied`
- `sensor_window`
- `sensors_off`
- `sentiment_dissatisfied`
- `sentiment_neutral`
- `sentiment_very_dissatisfied`
- `sentiment_very_satisfied`
- `set_meal`
- `settings_accessibility`
- `settings_applications`
- `settings_backup_restore`
- `settings_bluetooth`
- `settings_brightness`
- `settings_cell`
- `settings_ethernet`
- `settings_input_component`
- `settings_input_composite`
- `settings_input_hdmi`
- `settings_input_svideo`
- `settings_overscan`
- `settings_phone`
- `settings_power`
- `settings_remote`
- `settings_suggest`
- `settings_system_daydream`
- `settings_voice`
- `severe_cold`
- `shape_line`
- `share_location`
- `shield_moon`
- `shop`
- `shop_2`
- `shop_two`
- `shopping_cart_checkout`
- `shuffle_on`
- `shutter_speed`
- `sick`
- `sign_language`
- `signal_cellular_0_bar`
- `signal_cellular_alt_1_bar`
- `signal_cellular_alt_2_bar`
- `signal_cellular_connected_no_internet_0_bar`
- `signal_cellular_connected_no_internet_4_bar`
- `signal_cellular_no_sim`
- `signal_cellular_nodata`
- `signal_cellular_null`
- `signal_cellular_off`
- `signal_wifi_0_bar`
- `signal_wifi_4_bar_lock`
- `signal_wifi_statusbar_null`
- `sim_card_alert`
- `sim_card_download`
- `single_bed`
- `sip`
- `skateboarding`
- `sledding`
- `smart_button`
- `smart_screen`
- `smart_toy`
- `smoke_free`
- `smoking_rooms`
- `sms_failed`
- `snippet_folder`
- `snooze`
- `snowmobile`
- `snowshoeing`
- `soap`
- `social_distance`
- `solar_power`
- `sort_by_alpha`
- `sos`
- `soup_kitchen`
- `source`
- `spa`
- `space_bar`
- `space_dashboard`
- `spatial_audio`
- `spatial_audio_off`
- `spatial_tracking`
- `speaker`
- `speaker_notes_off`
- `speaker_phone`
- `spoke`
- `sports`
- `sports_bar`
- `sports_golf`
- `sports_kabaddi`
- `sports_mma`
- `sports_motorsports`
- `square_foot`
- `ssid_chart`
- `stacked_bar_chart`
- `stacked_line_chart`
- `stadium`
- `star_border_purple_500`
- `start`
- `stay_current_landscape`
- `stay_current_portrait`
- `stay_primary_landscape`
- `stay_primary_portrait`
- `stop_screen_share`
- `storage`
- `streetview`
- `style`
- `subtitles_off`
- `supervised_user_circle`
- `supervisor_account`
- `support_agent`
- `surround_sound`
- `swap_calls`
- `swipe`
- `swipe_down`
- `swipe_down_alt`
- `swipe_left`
- `swipe_left_alt`
- `swipe_right`
- `swipe_right_alt`
- `swipe_up`
- `swipe_up_alt`
- `swipe_vertical`
- `switch_access_shortcut`
- `switch_access_shortcut_add`
- `switch_account`
- `switch_left`
- `switch_right`
- `switch_video`
- `synagogue`
- `sync_disabled`
- `sync_lock`
- `system_security_update`
- `system_security_update_good`
- `system_security_update_warning`
- `system_update`
- `system_update_alt`
- `tab`
- `tab_unselected`
- `table_bar`
- `table_chart`
- `table_rows`
- `table_view`
- `tablet`
- `tablet_android`
- `tablet_mac`
- `takeout_dining`
- `tap_and_play`
- `tapas`
- `task`
- `taxi_alert`
- `temple_buddhist`
- `temple_hindu`
- `text_rotate_up`
- `text_rotate_vertical`
- `text_rotation_angledown`
- `text_rotation_angleup`
- `text_rotation_down`
- `text_rotation_none`
- `texture`
- `thermostat_auto`
- `thumbs_up_down`
- `timelapse`
- `timer_10`
- `timer_10_select`
- `timer_3`
- `timer_3_select`
- `timer_off`
- `tips_and_updates`
- `tire_repair`
- `toggle_off`
- `toggle_on`
- `token`
- `toll`
- `tonality`
- `topic`
- `tour`
- `toys`
- `track_changes`
- `traffic`
- `transcribe`
- `transfer_within_a_station`
- `transform`
- `transgender`
- `transit_enterexit`
- `travel_explore`
- `trending_down`
- `trending_up`
- `trip_origin`
- `troubleshoot`
- `try`
- `tsunami`
- `tty`
- `tungsten`
- `turn_sharp_left`
- `turn_sharp_right`
- `turn_slight_left`
- `turn_slight_right`
- `two_wheeler`
- `type_specimen`
- `unfold_less`
- `unfold_less_double`
- `unfold_more_double`
- `unpublished`
- `unsubscribe`
- `upcoming`
- `update_disabled`
- `usb`
- `usb_off`
- `vape_free`
- `vaping_rooms`
- `vertical_distribute`
- `vibration`
- `video_call`
- `video_camera_back`
- `video_camera_front`
- `video_file`
- `video_label`
- `video_library`
- `video_settings`
- `video_stable`
- `videocam`
- `videocam_off`
- `videogame_asset_off`
- `view_array`
- `view_carousel`
- `view_comfy`
- `view_comfy_alt`
- `view_compact`
- `view_compact_alt`
- `view_cozy`
- `view_day`
- `view_in_ar`
- `view_kanban`
- `view_module`
- `view_quilt`
- `view_timeline`
- `view_week`
- `vignette`
- `villa`
- `voice_over_off`
- `volcano`
- `volunteer_activism`
- `vpn_lock`
- `vrpano`
- `wallpaper`
- `warehouse`
- `wash`
- `watch`
- `watch_off`
- `water_damage`
- `waterfall_chart`
- `wb_auto`
- `wb_iridescent`
- `wb_shade`
- `wc`
- `web`
- `web_asset`
- `web_asset_off`
- `web_stories`
- `webhook`
- `whatsapp`
- `wheelchair_pickup`
- `where_to_vote`
- `widgets`
- `width_full`
- `width_normal`
- `width_wide`
- `wifi_1_bar`
- `wifi_2_bar`
- `wifi_calling`
- `wifi_calling_3`
- `wifi_channel`
- `wifi_find`
- `wifi_lock`
- `wifi_password`
- `wifi_protected_setup`
- `wifi_tethering_error`
- `wifi_tethering_error_rounded`
- `wifi_tethering_off`
- `wind_power`
- `woman`
- `woman_2`
- `work_history`
- `work_off`
- `workspaces`
- `wrap_text`
- `wrong_location`
- `yard`
- `youtube_searched_for`

## Mapped names (934)

| Name | Default symbol | Filled | Outlined |
| --- | --- | --- | --- |
| `abc` | `textformat.abc` |  |  |
| `ac_unit` | `snowflake` |  |  |
| `access_alarm` | `alarm` | `alarm.fill` | `alarm` |
| `access_alarms` | `alarm` | `alarm.fill` | `alarm` |
| `access_time` | `clock` | `clock.fill` | `clock` |
| `access_time_filled` | `clock.fill` | `clock.fill` |  |
| `accessibility` | `figure.arms.open` |  |  |
| `accessibility_new` | `figure.arms.open` |  |  |
| `accessible` | `figure.roll` |  |  |
| `accessible_forward` | `figure.roll.runningpace` |  |  |
| `account_balance` | `building.columns` | `building.columns.fill` | `building.columns` |
| `account_balance_wallet` | `wallet.pass` | `wallet.pass.fill` | `wallet.pass` |
| `account_box` | `person.crop.square` | `person.crop.square.fill` | `person.crop.square` |
| `account_circle` | `person.crop.circle` | `person.crop.circle.fill` | `person.crop.circle` |
| `add` | `plus` |  |  |
| `add_box` | `plus.square.fill` | `plus.square.fill` | `plus.square` |
| `add_circle` | `plus.circle.fill` | `plus.circle.fill` | `plus.circle` |
| `add_circle_outline` | `plus.circle` |  | `plus.circle` |
| `add_comment` | `plus.bubble` | `plus.bubble.fill` | `plus.bubble` |
| `add_ic_call` | `phone.badge.plus` | `phone.fill.badge.plus` | `phone.badge.plus` |
| `add_link` | `link.badge.plus` |  |  |
| `add_photo_alternate` | `photo.badge.plus` | `photo.badge.plus.fill` | `photo.badge.plus` |
| `add_shopping_cart` | `cart.badge.plus` | `cart.fill.badge.plus` | `cart.badge.plus` |
| `add_to_photos` | `rectangle.stack.badge.plus` | `rectangle.stack.fill.badge.plus` | `rectangle.stack.badge.plus` |
| `adf_scanner` | `scanner` | `scanner.fill` | `scanner` |
| `air` | `wind` |  |  |
| `airplanemode_active` | `airplane` |  |  |
| `airplay` | `airplayvideo` |  |  |
| `airport_shuttle` | `bus` | `bus.fill` | `bus` |
| `alarm` | `alarm` | `alarm.fill` | `alarm` |
| `album` | `opticaldisc` | `opticaldisc.fill` | `opticaldisc` |
| `align_horizontal_center` | `align.horizontal.center` | `align.horizontal.center.fill` | `align.horizontal.center` |
| `align_horizontal_left` | `align.horizontal.left` | `align.horizontal.left.fill` | `align.horizontal.left` |
| `align_horizontal_right` | `align.horizontal.right` | `align.horizontal.right.fill` | `align.horizontal.right` |
| `align_vertical_bottom` | `align.vertical.bottom` | `align.vertical.bottom.fill` | `align.vertical.bottom` |
| `align_vertical_center` | `align.vertical.center` | `align.vertical.center.fill` | `align.vertical.center` |
| `align_vertical_top` | `align.vertical.top` | `align.vertical.top.fill` | `align.vertical.top` |
| `all_inbox` | `tray.2` | `tray.2.fill` | `tray.2` |
| `all_inclusive` | `infinity` |  |  |
| `alt_route` | `arrow.triangle.branch` |  |  |
| `alternate_email` | `at` |  |  |
| `analytics` | `chart.bar` | `chart.bar.fill` | `chart.bar` |
| `apartment` | `building.2` | `building.2.fill` | `building.2` |
| `approval` | `checkmark.seal` | `checkmark.seal.fill` | `checkmark.seal` |
| `apps` | `square.grid.3x3` | `square.grid.3x3.fill` | `square.grid.3x3` |
| `archive` | `archivebox` | `archivebox.fill` | `archivebox` |
| `arrow_back` | `arrow.left` |  |  |
| `arrow_back_ios` | `chevron.left` |  |  |
| `arrow_back_ios_new` | `chevron.left` |  |  |
| `arrow_circle_down` | `arrow.down.circle` | `arrow.down.circle.fill` | `arrow.down.circle` |
| `arrow_circle_left` | `arrow.left.circle` | `arrow.left.circle.fill` | `arrow.left.circle` |
| `arrow_circle_right` | `arrow.right.circle` | `arrow.right.circle.fill` | `arrow.right.circle` |
| `arrow_circle_up` | `arrow.up.circle` | `arrow.up.circle.fill` | `arrow.up.circle` |
| `arrow_downward` | `arrow.down` |  |  |
| `arrow_drop_down` | `arrowtriangle.down.fill` | `arrowtriangle.down.fill` | `arrowtriangle.down` |
| `arrow_drop_up` | `arrowtriangle.up.fill` | `arrowtriangle.up.fill` | `arrowtriangle.up` |
| `arrow_forward` | `arrow.right` |  |  |
| `arrow_forward_ios` | `chevron.right` |  |  |
| `arrow_left` | `arrowtriangle.left.fill` | `arrowtriangle.left.fill` | `arrowtriangle.left` |
| `arrow_outward` | `arrow.up.right` |  |  |
| `arrow_right` | `arrowtriangle.right.fill` | `arrowtriangle.right.fill` | `arrowtriangle.right` |
| `arrow_right_alt` | `arrow.right` |  |  |
| `arrow_upward` | `arrow.up` |  |  |
| `article` | `doc.text` | `doc.text.fill` | `doc.text` |
| `aspect_ratio` | `aspectratio` | `aspectratio.fill` | `aspectratio` |
| `assessment` | `chart.bar` | `chart.bar.fill` | `chart.bar` |
| `assignment` | `clipboard` | `clipboard.fill` | `clipboard` |
| `assignment_ind` | `person.crop.rectangle` | `person.crop.rectangle.fill` | `person.crop.rectangle` |
| `assistant_photo` | `flag` | `flag.fill` | `flag` |
| `attach_file` | `paperclip` |  |  |
| `attach_money` | `dollarsign` |  |  |
| `attachment` | `paperclip` |  |  |
| `audiotrack` | `music.note` |  |  |
| `auto_awesome` | `sparkles` |  |  |
| `auto_awesome_mosaic` | `square.grid.2x2` | `square.grid.2x2.fill` | `square.grid.2x2` |
| `auto_fix_high` | `wand.and.stars` |  |  |
| `auto_stories` | `book` | `book.fill` | `book` |
| `autorenew` | `arrow.triangle.2.circlepath` |  |  |
| `av_timer` | `timer` |  |  |
| `backpack` | `backpack` | `backpack.fill` | `backpack` |
| `backspace` | `delete.left` | `delete.left.fill` | `delete.left` |
| `badge` | `person.text.rectangle` | `person.text.rectangle.fill` | `person.text.rectangle` |
| `ballot` | `checklist` |  |  |
| `bar_chart` | `chart.bar` | `chart.bar.fill` | `chart.bar` |
| `bathroom` | `bathtub` | `bathtub.fill` | `bathtub` |
| `bathtub` | `bathtub` | `bathtub.fill` | `bathtub` |
| `battery_0_bar` | `battery.0percent` |  |  |
| `battery_3_bar` | `battery.50percent` |  |  |
| `battery_charging_full` | `battery.100percent.bolt` |  |  |
| `battery_full` | `battery.100percent` |  |  |
| `battery_std` | `battery.100percent` |  |  |
| `beach_access` | `beach.umbrella` | `beach.umbrella.fill` | `beach.umbrella` |
| `bed` | `bed.double` | `bed.double.fill` | `bed.double` |
| `bedtime` | `moon` | `moon.fill` | `moon` |
| `blinds` | `blinds.horizontal.open` |  |  |
| `blinds_closed` | `blinds.horizontal.closed` |  |  |
| `block` | `nosign` |  |  |
| `bolt` | `bolt` | `bolt.fill` | `bolt` |
| `book` | `book` | `book.fill` | `book` |
| `bookmark` | `bookmark` | `bookmark.fill` | `bookmark` |
| `bookmark_border` | `bookmark` |  | `bookmark` |
| `bookmark_remove` | `bookmark.slash` | `bookmark.slash.fill` | `bookmark.slash` |
| `border_all` | `square.grid.3x3` | `square.grid.3x3.fill` | `square.grid.3x3` |
| `border_clear` | `square.dashed` |  |  |
| `border_outer` | `square` | `square.fill` | `square` |
| `brightness_1` | `circle.fill` | `circle.fill` | `circle` |
| `brightness_3` | `moon` | `moon.fill` | `moon` |
| `brightness_5` | `sun.min` | `sun.min.fill` | `sun.min` |
| `brightness_7` | `sun.max` | `sun.max.fill` | `sun.max` |
| `brightness_high` | `sun.max` | `sun.max.fill` | `sun.max` |
| `brightness_low` | `sun.min` | `sun.min.fill` | `sun.min` |
| `browser_not_supported` | `rectangle.slash` | `rectangle.slash.fill` | `rectangle.slash` |
| `brush` | `paintbrush` | `paintbrush.fill` | `paintbrush` |
| `build` | `wrench.and.screwdriver` | `wrench.and.screwdriver.fill` | `wrench.and.screwdriver` |
| `burst_mode` | `square.stack` | `square.stack.fill` | `square.stack` |
| `business` | `building.2` | `building.2.fill` | `building.2` |
| `business_center` | `briefcase` | `briefcase.fill` | `briefcase` |
| `cable` | `cable.connector` |  |  |
| `cached` | `arrow.triangle.2.circlepath` |  |  |
| `cake` | `birthday.cake` | `birthday.cake.fill` | `birthday.cake` |
| `calendar_month` | `calendar` |  |  |
| `calendar_today` | `calendar` |  |  |
| `calendar_view_day` | `calendar.day.timeline.left` |  |  |
| `call` | `phone` | `phone.fill` | `phone` |
| `call_end` | `phone.down` | `phone.down.fill` | `phone.down` |
| `call_made` | `phone.arrow.up.right` | `phone.arrow.up.right.fill` | `phone.arrow.up.right` |
| `call_merge` | `arrow.merge` |  |  |
| `call_received` | `phone.arrow.down.left` | `phone.arrow.down.left.fill` | `phone.arrow.down.left` |
| `call_split` | `arrow.branch` |  |  |
| `camera_alt` | `camera` | `camera.fill` | `camera` |
| `camera_roll` | `photo.on.rectangle` |  |  |
| `cameraswitch` | `arrow.triangle.2.circlepath.camera` | `arrow.triangle.2.circlepath.camera.fill` | `arrow.triangle.2.circlepath.camera` |
| `campaign` | `megaphone` | `megaphone.fill` | `megaphone` |
| `cancel` | `xmark.circle` | `xmark.circle.fill` | `xmark.circle` |
| `cancel_presentation` | `rectangle.badge.xmark` | `rectangle.fill.badge.xmark` | `rectangle.badge.xmark` |
| `card_giftcard` | `giftcard` | `giftcard.fill` | `giftcard` |
| `card_membership` | `creditcard` | `creditcard.fill` | `creditcard` |
| `card_travel` | `suitcase` | `suitcase.fill` | `suitcase` |
| `casino` | `dice` | `dice.fill` | `dice` |
| `celebration` | `party.popper` | `party.popper.fill` | `party.popper` |
| `cell_tower` | `antenna.radiowaves.left.and.right` |  |  |
| `chair` | `chair` | `chair.fill` | `chair` |
| `chair_alt` | `chair` | `chair.fill` | `chair` |
| `change_circle` | `arrow.triangle.2.circlepath.circle` | `arrow.triangle.2.circlepath.circle.fill` | `arrow.triangle.2.circlepath.circle` |
| `change_history` | `triangle` | `triangle.fill` | `triangle` |
| `chat_bubble` | `bubble.left` | `bubble.left.fill` | `bubble.left` |
| `chat_bubble_outline` | `bubble.left` |  | `bubble.left` |
| `check` | `checkmark` |  |  |
| `check_box` | `checkmark.square.fill` | `checkmark.square.fill` | `checkmark.square` |
| `check_box_outline_blank` | `square` |  | `square` |
| `check_circle` | `checkmark.circle` | `checkmark.circle.fill` | `checkmark.circle` |
| `check_circle_outline` | `checkmark.circle` |  | `checkmark.circle` |
| `checklist` | `checklist` |  |  |
| `chevron_left` | `chevron.left` |  |  |
| `chevron_right` | `chevron.right` |  |  |
| `child_friendly` | `stroller` | `stroller.fill` | `stroller` |
| `circle` | `circle.fill` | `circle.fill` | `circle` |
| `class` | `book.closed` | `book.closed.fill` | `book.closed` |
| `clean_hands` | `hands.sparkles` | `hands.sparkles.fill` | `hands.sparkles` |
| `clear` | `xmark` |  |  |
| `close` | `xmark` |  |  |
| `close_fullscreen` | `arrow.down.right.and.arrow.up.left` |  |  |
| `closed_caption` | `captions.bubble` | `captions.bubble.fill` | `captions.bubble` |
| `cloud` | `cloud` | `cloud.fill` | `cloud` |
| `cloud_circle` | `cloud.circle` | `cloud.circle.fill` | `cloud.circle` |
| `co_2` | `carbon.dioxide.cloud` | `carbon.dioxide.cloud.fill` | `carbon.dioxide.cloud` |
| `code` | `chevron.left.forwardslash.chevron.right` |  |  |
| `coffee` | `cup.and.saucer` | `cup.and.saucer.fill` | `cup.and.saucer` |
| `collections` | `photo.on.rectangle` |  |  |
| `color_lens` | `paintpalette` | `paintpalette.fill` | `paintpalette` |
| `colorize` | `eyedropper` |  |  |
| `comment` | `bubble.left` | `bubble.left.fill` | `bubble.left` |
| `compare_arrows` | `arrow.left.arrow.right` |  |  |
| `compost` | `leaf.arrow.triangle.circlepath` |  |  |
| `computer` | `desktopcomputer` |  |  |
| `confirmation_number` | `ticket` | `ticket.fill` | `ticket` |
| `contact_page` | `person.text.rectangle` | `person.text.rectangle.fill` | `person.text.rectangle` |
| `contact_support` | `questionmark.bubble` | `questionmark.bubble.fill` | `questionmark.bubble` |
| `contacts` | `person.crop.rectangle` | `person.crop.rectangle.fill` | `person.crop.rectangle` |
| `content_copy` | `doc.on.doc` | `doc.on.doc.fill` | `doc.on.doc` |
| `content_cut` | `scissors` |  |  |
| `content_paste` | `clipboard` | `clipboard.fill` | `clipboard` |
| `contrast` | `circle.lefthalf.filled` |  |  |
| `control_point` | `plus.circle` | `plus.circle.fill` | `plus.circle` |
| `copy_all` | `doc.on.doc` | `doc.on.doc.fill` | `doc.on.doc` |
| `copyright` | `c.circle` | `c.circle.fill` | `c.circle` |
| `coronavirus` | `microbe` | `microbe.fill` | `microbe` |
| `corporate_fare` | `building.2` | `building.2.fill` | `building.2` |
| `create` | `pencil` |  |  |
| `create_new_folder` | `folder.badge.plus` | `folder.fill.badge.plus` | `folder.badge.plus` |
| `credit_card` | `creditcard` | `creditcard.fill` | `creditcard` |
| `crop` | `crop` |  |  |
| `crop_free` | `viewfinder` |  |  |
| `crop_rotate` | `crop.rotate` |  |  |
| `currency_franc` | `francsign` |  |  |
| `currency_lira` | `turkishlirasign` |  |  |
| `currency_pound` | `sterlingsign` |  |  |
| `currency_ruble` | `rublesign` |  |  |
| `currency_rupee` | `indianrupeesign` |  |  |
| `currency_yen` | `yensign` |  |  |
| `currency_yuan` | `yensign` |  |  |
| `curtains` | `curtains.open` |  |  |
| `curtains_closed` | `curtains.closed` |  |  |
| `cyclone` | `hurricane` |  |  |
| `dangerous` | `xmark.octagon` | `xmark.octagon.fill` | `xmark.octagon` |
| `dark_mode` | `moon` | `moon.fill` | `moon` |
| `dashboard` | `square.grid.2x2` | `square.grid.2x2.fill` | `square.grid.2x2` |
| `data_object` | `curlybraces` |  |  |
| `dataset` | `tablecells` | `tablecells.fill` | `tablecells` |
| `date_range` | `calendar` |  |  |
| `dehaze` | `line.3.horizontal` |  |  |
| `delete` | `trash` | `trash.fill` | `trash` |
| `delete_outline` | `trash` |  | `trash` |
| `description` | `doc.text` | `doc.text.fill` | `doc.text` |
| `design_services` | `pencil.and.ruler` | `pencil.and.ruler.fill` | `pencil.and.ruler` |
| `desktop_mac` | `desktopcomputer` |  |  |
| `desktop_windows` | `desktopcomputer` |  |  |
| `device_thermostat` | `thermometer.medium` |  |  |
| `dialpad` | `circle.grid.3x3` | `circle.grid.3x3.fill` | `circle.grid.3x3` |
| `diamond` | `diamond` | `diamond.fill` | `diamond` |
| `dining` | `fork.knife` |  |  |
| `dinner_dining` | `fork.knife` |  |  |
| `directions` | `arrow.triangle.turn.up.right.diamond` | `arrow.triangle.turn.up.right.diamond.fill` | `arrow.triangle.turn.up.right.diamond` |
| `directions_bike` | `bicycle` |  |  |
| `directions_boat` | `ferry` | `ferry.fill` | `ferry` |
| `directions_boat_filled` | `ferry.fill` | `ferry.fill` |  |
| `directions_bus` | `bus` | `bus.fill` | `bus` |
| `directions_bus_filled` | `bus.fill` | `bus.fill` |  |
| `directions_car` | `car` | `car.fill` | `car` |
| `directions_car_filled` | `car.fill` | `car.fill` |  |
| `directions_railway` | `tram` | `tram.fill` | `tram` |
| `directions_railway_filled` | `tram.fill` | `tram.fill` |  |
| `directions_run` | `figure.run` |  |  |
| `directions_subway` | `tram` | `tram.fill` | `tram` |
| `directions_subway_filled` | `tram.fill` | `tram.fill` |  |
| `directions_transit` | `tram` | `tram.fill` | `tram` |
| `directions_transit_filled` | `tram.fill` | `tram.fill` |  |
| `directions_walk` | `figure.walk` |  |  |
| `disabled_by_default` | `xmark.square` | `xmark.square.fill` | `xmark.square` |
| `discount` | `tag` | `tag.fill` | `tag` |
| `dns` | `server.rack` |  |  |
| `do_disturb` | `minus.circle` | `minus.circle.fill` | `minus.circle` |
| `do_disturb_on` | `minus.circle` | `minus.circle.fill` | `minus.circle` |
| `do_not_disturb` | `minus.circle` | `minus.circle.fill` | `minus.circle` |
| `do_not_disturb_alt` | `nosign` |  |  |
| `do_not_disturb_on` | `minus.circle` | `minus.circle.fill` | `minus.circle` |
| `document_scanner` | `doc.viewfinder` | `doc.viewfinder.fill` | `doc.viewfinder` |
| `domain` | `building.2` | `building.2.fill` | `building.2` |
| `done` | `checkmark.circle` | `checkmark.circle.fill` | `checkmark.circle` |
| `done_outline` | `checkmark` |  |  |
| `door_front` | `door.left.hand.closed` |  |  |
| `door_sliding` | `door.sliding.left.hand.closed` |  |  |
| `double_arrow` | `chevron.right.2` |  |  |
| `downhill_skiing` | `figure.skiing.downhill` |  |  |
| `download` | `arrow.down.to.line` |  |  |
| `download_for_offline` | `arrow.down.circle` | `arrow.down.circle.fill` | `arrow.down.circle` |
| `downloading` | `arrow.down.circle.dotted` |  |  |
| `drafts` | `envelope.open` | `envelope.open.fill` | `envelope.open` |
| `drag_handle` | `equal` |  |  |
| `draw` | `pencil.and.outline` |  |  |
| `drive_eta` | `car` | `car.fill` | `car` |
| `drive_file_rename_outline` | `pencil` |  |  |
| `dry_cleaning` | `hanger` |  |  |
| `earbuds` | `earbuds` |  |  |
| `east` | `arrow.right` |  |  |
| `eco` | `leaf` | `leaf.fill` | `leaf` |
| `edit` | `pencil` |  |  |
| `edit_note` | `square.and.pencil` |  |  |
| `edit_off` | `pencil.slash` |  |  |
| `eject` | `eject` | `eject.fill` | `eject` |
| `electric_bolt` | `bolt` | `bolt.fill` | `bolt` |
| `electric_scooter` | `scooter` |  |  |
| `electrical_services` | `powerplug` | `powerplug.fill` | `powerplug` |
| `email` | `envelope` | `envelope.fill` | `envelope` |
| `emergency` | `cross` | `cross.fill` | `cross` |
| `emoji_emotions` | `face.smiling` | `face.smiling.fill` | `face.smiling` |
| `emoji_events` | `trophy` | `trophy.fill` | `trophy` |
| `emoji_flags` | `flag` | `flag.fill` | `flag` |
| `emoji_food_beverage` | `cup.and.saucer` | `cup.and.saucer.fill` | `cup.and.saucer` |
| `emoji_objects` | `lightbulb` | `lightbulb.fill` | `lightbulb` |
| `emoji_people` | `figure.wave` |  |  |
| `emoji_transportation` | `car` | `car.fill` | `car` |
| `equalizer` | `slider.vertical.3` |  |  |
| `error` | `exclamationmark.circle` | `exclamationmark.circle.fill` | `exclamationmark.circle` |
| `error_outline` | `exclamationmark.circle` |  | `exclamationmark.circle` |
| `euro` | `eurosign` |  |  |
| `euro_symbol` | `eurosign` |  |  |
| `ev_station` | `ev.charger` | `ev.charger.fill` | `ev.charger` |
| `event` | `calendar` |  |  |
| `event_available` | `calendar.badge.checkmark` |  |  |
| `event_busy` | `calendar.badge.minus` |  |  |
| `event_seat` | `chair` | `chair.fill` | `chair` |
| `exit_to_app` | `rectangle.portrait.and.arrow.right` | `rectangle.portrait.and.arrow.right.fill` | `rectangle.portrait.and.arrow.right` |
| `expand` | `arrow.up.and.down` |  |  |
| `expand_circle_down` | `chevron.down.circle` | `chevron.down.circle.fill` | `chevron.down.circle` |
| `expand_less` | `chevron.up` |  |  |
| `expand_more` | `chevron.down` |  |  |
| `exposure` | `plusminus` |  |  |
| `extension` | `puzzlepiece.extension` | `puzzlepiece.extension.fill` | `puzzlepiece.extension` |
| `family_restroom` | `figure.2.and.child.holdinghands` |  |  |
| `fast_forward` | `forward` | `forward.fill` | `forward` |
| `fast_rewind` | `backward` | `backward.fill` | `backward` |
| `fastfood` | `takeoutbag.and.cup.and.straw` | `takeoutbag.and.cup.and.straw.fill` | `takeoutbag.and.cup.and.straw` |
| `favorite` | `heart` | `heart.fill` | `heart` |
| `favorite_border` | `heart` |  | `heart` |
| `fax` | `faxmachine` | `faxmachine.fill` | `faxmachine` |
| `featured_play_list` | `list.bullet.rectangle` | `list.bullet.rectangle.fill` | `list.bullet.rectangle` |
| `feed` | `newspaper` | `newspaper.fill` | `newspaper` |
| `feedback` | `exclamationmark.bubble` | `exclamationmark.bubble.fill` | `exclamationmark.bubble` |
| `festival` | `tent` | `tent.fill` | `tent` |
| `fiber_manual_record` | `circle.fill` | `circle.fill` | `circle` |
| `file_copy` | `doc.on.doc` | `doc.on.doc.fill` | `doc.on.doc` |
| `file_download` | `arrow.down.to.line` |  |  |
| `file_upload` | `arrow.up.to.line` |  |  |
| `filter_alt` | `line.3.horizontal.decrease` |  |  |
| `filter_center_focus` | `viewfinder` |  |  |
| `filter_list` | `line.3.horizontal.decrease` |  |  |
| `filter_none` | `square.on.square` | `square.fill.on.square` | `square.on.square` |
| `find_in_page` | `doc.text.magnifyingglass` |  |  |
| `fireplace` | `fireplace` | `fireplace.fill` | `fireplace` |
| `first_page` | `backward.end` | `backward.end.fill` | `backward.end` |
| `fitness_center` | `dumbbell` | `dumbbell.fill` | `dumbbell` |
| `flag` | `flag` | `flag.fill` | `flag` |
| `flag_circle` | `flag.circle` | `flag.circle.fill` | `flag.circle` |
| `flash_auto` | `bolt.badge.a` | `bolt.badge.a.fill` | `bolt.badge.a` |
| `flash_off` | `bolt.slash` | `bolt.slash.fill` | `bolt.slash` |
| `flash_on` | `bolt` | `bolt.fill` | `bolt` |
| `flashlight_off` | `flashlight.off.fill` |  |  |
| `flashlight_on` | `flashlight.on.fill` |  |  |
| `flatware` | `fork.knife` |  |  |
| `flight` | `airplane` |  |  |
| `flight_land` | `airplane.arrival` |  |  |
| `flight_takeoff` | `airplane.departure` |  |  |
| `flip` | `arrow.left.and.right.righttriangle.left.righttriangle.right` | `arrow.left.and.right.righttriangle.left.righttriangle.right.fill` | `arrow.left.and.right.righttriangle.left.righttriangle.right` |
| `flip_camera_android` | `arrow.triangle.2.circlepath.camera` | `arrow.triangle.2.circlepath.camera.fill` | `arrow.triangle.2.circlepath.camera` |
| `flip_camera_ios` | `arrow.triangle.2.circlepath.camera` | `arrow.triangle.2.circlepath.camera.fill` | `arrow.triangle.2.circlepath.camera` |
| `flourescent` | `light.cylindrical.ceiling` | `light.cylindrical.ceiling.fill` | `light.cylindrical.ceiling` |
| `fluorescent` | `light.cylindrical.ceiling` | `light.cylindrical.ceiling.fill` | `light.cylindrical.ceiling` |
| `fmd_good` | `mappin.and.ellipse` |  |  |
| `folder` | `folder` | `folder.fill` | `folder` |
| `folder_delete` | `folder.badge.minus` | `folder.fill.badge.minus` | `folder.badge.minus` |
| `folder_shared` | `folder.badge.person.crop` | `folder.fill.badge.person.crop` | `folder.badge.person.crop` |
| `format_align_center` | `text.aligncenter` |  |  |
| `format_align_justify` | `text.justify` |  |  |
| `format_align_left` | `text.alignleft` |  |  |
| `format_align_right` | `text.alignright` |  |  |
| `format_bold` | `bold` |  |  |
| `format_indent_decrease` | `decrease.indent` |  |  |
| `format_indent_increase` | `increase.indent` |  |  |
| `format_italic` | `italic` |  |  |
| `format_list_bulleted` | `list.bullet` |  |  |
| `format_list_numbered` | `list.number` |  |  |
| `format_quote` | `quote.opening` |  |  |
| `format_size` | `textformat.size` |  |  |
| `format_strikethrough` | `strikethrough` |  |  |
| `format_underlined` | `underline` |  |  |
| `forum` | `bubble.left.and.bubble.right` | `bubble.left.and.bubble.right.fill` | `bubble.left.and.bubble.right` |
| `forward` | `arrowshape.turn.up.right` | `arrowshape.turn.up.right.fill` | `arrowshape.turn.up.right` |
| `forward_10` | `goforward.10` |  |  |
| `forward_30` | `goforward.30` |  |  |
| `forward_5` | `goforward.5` |  |  |
| `forward_to_inbox` | `envelope.arrow.triangle.branch` | `envelope.arrow.triangle.branch.fill` | `envelope.arrow.triangle.branch` |
| `front_hand` | `hand.raised` | `hand.raised.fill` | `hand.raised` |
| `fullscreen` | `arrow.up.left.and.arrow.down.right` |  |  |
| `fullscreen_exit` | `arrow.down.right.and.arrow.up.left` |  |  |
| `functions` | `function` |  |  |
| `gamepad` | `gamecontroller` | `gamecontroller.fill` | `gamecontroller` |
| `games` | `gamecontroller` | `gamecontroller.fill` | `gamecontroller` |
| `garage` | `door.garage.closed` |  |  |
| `get_app` | `arrow.down.to.line` |  |  |
| `gpp_bad` | `xmark.shield` | `xmark.shield.fill` | `xmark.shield` |
| `gpp_good` | `checkmark.shield` | `checkmark.shield.fill` | `checkmark.shield` |
| `gpp_maybe` | `exclamationmark.shield` | `exclamationmark.shield.fill` | `exclamationmark.shield` |
| `gps_fixed` | `scope` |  |  |
| `gps_not_fixed` | `location.circle` | `location.circle.fill` | `location.circle` |
| `gps_off` | `location.slash` | `location.slash.fill` | `location.slash` |
| `grade` | `star` | `star.fill` | `star` |
| `grading` | `checklist` |  |  |
| `graphic_eq` | `waveform` |  |  |
| `grid_3x_3` | `square.grid.3x3` | `square.grid.3x3.fill` | `square.grid.3x3` |
| `grid_on` | `square.grid.3x3` | `square.grid.3x3.fill` | `square.grid.3x3` |
| `grid_view` | `square.grid.2x2` | `square.grid.2x2.fill` | `square.grid.2x2` |
| `group` | `person.2` | `person.2.fill` | `person.2` |
| `group_off` | `person.2.slash` | `person.2.slash.fill` | `person.2.slash` |
| `groups` | `person.3` | `person.3.fill` | `person.3` |
| `handyman` | `wrench.and.screwdriver` | `wrench.and.screwdriver.fill` | `wrench.and.screwdriver` |
| `hardware` | `hammer` | `hammer.fill` | `hammer` |
| `headphones` | `headphones` |  |  |
| `headset` | `headphones` |  |  |
| `healing` | `bandage` | `bandage.fill` | `bandage` |
| `health_and_safety` | `cross.case` | `cross.case.fill` | `cross.case` |
| `hearing` | `ear` | `ear.fill` | `ear` |
| `height` | `arrow.up.and.down` |  |  |
| `help` | `questionmark.circle` | `questionmark.circle.fill` | `questionmark.circle` |
| `help_center` | `questionmark.square` | `questionmark.square.fill` | `questionmark.square` |
| `help_outline` | `questionmark.circle` |  | `questionmark.circle` |
| `hexagon` | `hexagon` | `hexagon.fill` | `hexagon` |
| `highlight` | `highlighter` |  |  |
| `highlight_off` | `xmark.circle` | `xmark.circle.fill` | `xmark.circle` |
| `hiking` | `figure.hiking` |  |  |
| `history` | `clock.arrow.circlepath` |  |  |
| `home` | `house` | `house.fill` | `house` |
| `horizontal_rule` | `minus` |  |  |
| `horizontal_split` | `rectangle.split.1x2` | `rectangle.split.1x2.fill` | `rectangle.split.1x2` |
| `hotel` | `bed.double` | `bed.double.fill` | `bed.double` |
| `house` | `house` | `house.fill` | `house` |
| `how_to_reg` | `person.crop.circle.badge.checkmark` | `person.crop.circle.fill.badge.checkmark` | `person.crop.circle.badge.checkmark` |
| `https` | `lock` | `lock.fill` | `lock` |
| `ice_skating` | `figure.skating` |  |  |
| `image` | `photo` | `photo.fill` | `photo` |
| `image_aspect_ratio` | `aspectratio` | `aspectratio.fill` | `aspectratio` |
| `import_contacts` | `book` | `book.fill` | `book` |
| `import_export` | `arrow.up.arrow.down` |  |  |
| `inbox` | `tray` | `tray.fill` | `tray` |
| `indeterminate_check_box` | `minus.square.fill` | `minus.square.fill` | `minus.square` |
| `info` | `info.circle` | `info.circle.fill` | `info.circle` |
| `input` | `arrow.right.to.line` |  |  |
| `insert_chart` | `chart.bar` | `chart.bar.fill` | `chart.bar` |
| `insert_chart_outlined` | `chart.bar` |  | `chart.bar` |
| `insert_comment` | `bubble.left` | `bubble.left.fill` | `bubble.left` |
| `insert_drive_file` | `doc` | `doc.fill` | `doc` |
| `insert_emoticon` | `face.smiling` | `face.smiling.fill` | `face.smiling` |
| `insert_invitation` | `calendar` |  |  |
| `insert_link` | `link` |  |  |
| `insert_photo` | `photo` | `photo.fill` | `photo` |
| `inventory` | `shippingbox` | `shippingbox.fill` | `shippingbox` |
| `invert_colors` | `drop.halffull` |  |  |
| `ios_share` | `square.and.arrow.up` | `square.and.arrow.up.fill` | `square.and.arrow.up` |
| `key` | `key` | `key.fill` | `key` |
| `key_off` | `key.slash` | `key.slash.fill` | `key.slash` |
| `keyboard` | `keyboard` | `keyboard.fill` | `keyboard` |
| `keyboard_alt` | `keyboard` | `keyboard.fill` | `keyboard` |
| `keyboard_arrow_down` | `chevron.down` |  |  |
| `keyboard_arrow_left` | `chevron.left` |  |  |
| `keyboard_arrow_right` | `chevron.right` |  |  |
| `keyboard_arrow_up` | `chevron.up` |  |  |
| `keyboard_backspace` | `arrow.left` |  |  |
| `keyboard_capslock` | `capslock` | `capslock.fill` | `capslock` |
| `keyboard_command_key` | `command` |  |  |
| `keyboard_control_key` | `control` |  |  |
| `keyboard_double_arrow_left` | `chevron.left.2` |  |  |
| `keyboard_double_arrow_right` | `chevron.right.2` |  |  |
| `keyboard_hide` | `keyboard.chevron.compact.down` | `keyboard.chevron.compact.down.fill` | `keyboard.chevron.compact.down` |
| `keyboard_option_key` | `option` |  |  |
| `keyboard_return` | `return` |  |  |
| `keyboard_voice` | `mic` | `mic.fill` | `mic` |
| `kitchen` | `refrigerator` | `refrigerator.fill` | `refrigerator` |
| `label` | `tag` | `tag.fill` | `tag` |
| `lan` | `network` |  |  |
| `landscape` | `mountain.2` | `mountain.2.fill` | `mountain.2` |
| `language` | `globe` |  |  |
| `laptop` | `laptopcomputer` |  |  |
| `laptop_mac` | `laptopcomputer` |  |  |
| `last_page` | `forward.end` | `forward.end.fill` | `forward.end` |
| `launch` | `arrow.up.forward.square` | `arrow.up.forward.square.fill` | `arrow.up.forward.square` |
| `layers` | `square.3.layers.3d` |  |  |
| `lens` | `circle.fill` | `circle.fill` | `circle` |
| `library_add` | `rectangle.stack.badge.plus` | `rectangle.stack.fill.badge.plus` | `rectangle.stack.badge.plus` |
| `library_books` | `books.vertical` | `books.vertical.fill` | `books.vertical` |
| `library_music` | `music.note.list` |  |  |
| `light` | `lamp.ceiling` | `lamp.ceiling.fill` | `lamp.ceiling` |
| `light_mode` | `sun.max` | `sun.max.fill` | `sun.max` |
| `lightbulb` | `lightbulb` | `lightbulb.fill` | `lightbulb` |
| `lightbulb_circle` | `lightbulb.circle` | `lightbulb.circle.fill` | `lightbulb.circle` |
| `link` | `link` |  |  |
| `liquor` | `wineglass` | `wineglass.fill` | `wineglass` |
| `list` | `list.bullet` |  |  |
| `list_alt` | `list.bullet.rectangle` | `list.bullet.rectangle.fill` | `list.bullet.rectangle` |
| `live_help` | `questionmark.bubble` | `questionmark.bubble.fill` | `questionmark.bubble` |
| `living` | `sofa` | `sofa.fill` | `sofa` |
| `local_activity` | `ticket` | `ticket.fill` | `ticket` |
| `local_airport` | `airplane` |  |  |
| `local_atm` | `dollarsign.circle` | `dollarsign.circle.fill` | `dollarsign.circle` |
| `local_bar` | `wineglass` | `wineglass.fill` | `wineglass` |
| `local_cafe` | `cup.and.saucer` | `cup.and.saucer.fill` | `cup.and.saucer` |
| `local_dining` | `fork.knife` |  |  |
| `local_fire_department` | `flame` | `flame.fill` | `flame` |
| `local_gas_station` | `fuelpump` | `fuelpump.fill` | `fuelpump` |
| `local_grocery_store` | `cart` | `cart.fill` | `cart` |
| `local_hospital` | `cross.case` | `cross.case.fill` | `cross.case` |
| `local_hotel` | `bed.double` | `bed.double.fill` | `bed.double` |
| `local_laundry_service` | `washer` | `washer.fill` | `washer` |
| `local_mall` | `bag` | `bag.fill` | `bag` |
| `local_movies` | `film` | `film.fill` | `film` |
| `local_offer` | `tag` | `tag.fill` | `tag` |
| `local_parking` | `parkingsign` |  |  |
| `local_phone` | `phone` | `phone.fill` | `phone` |
| `local_play` | `ticket` | `ticket.fill` | `ticket` |
| `local_police` | `shield` | `shield.fill` | `shield` |
| `local_printshop` | `printer` | `printer.fill` | `printer` |
| `local_see` | `camera` | `camera.fill` | `camera` |
| `local_shipping` | `truck.box` | `truck.box.fill` | `truck.box` |
| `location_city` | `building.2` | `building.2.fill` | `building.2` |
| `location_disabled` | `location.slash` | `location.slash.fill` | `location.slash` |
| `location_off` | `mappin.slash` |  |  |
| `location_on` | `mappin.and.ellipse` |  |  |
| `location_searching` | `location.circle` | `location.circle.fill` | `location.circle` |
| `lock` | `lock` | `lock.fill` | `lock` |
| `lock_open` | `lock.open` | `lock.open.fill` | `lock.open` |
| `login` | `rectangle.portrait.and.arrow.forward` | `rectangle.portrait.and.arrow.forward.fill` | `rectangle.portrait.and.arrow.forward` |
| `logout` | `rectangle.portrait.and.arrow.right` | `rectangle.portrait.and.arrow.right.fill` | `rectangle.portrait.and.arrow.right` |
| `looks_3` | `3.square` | `3.square.fill` | `3.square` |
| `looks_4` | `4.square` | `4.square.fill` | `4.square` |
| `looks_5` | `5.square` | `5.square.fill` | `5.square` |
| `looks_6` | `6.square` | `6.square.fill` | `6.square` |
| `looks_one` | `1.square` | `1.square.fill` | `1.square` |
| `looks_two` | `2.square` | `2.square.fill` | `2.square` |
| `loop` | `arrow.triangle.2.circlepath` |  |  |
| `loupe` | `plus.magnifyingglass` |  |  |
| `luggage` | `suitcase.rolling` | `suitcase.rolling.fill` | `suitcase.rolling` |
| `mail` | `envelope` | `envelope.fill` | `envelope` |
| `mail_outline` | `envelope` |  | `envelope` |
| `man` | `figure.stand` |  |  |
| `manage_search` | `text.magnifyingglass` |  |  |
| `map` | `map` | `map.fill` | `map` |
| `mark_as_unread` | `envelope.badge` | `envelope.badge.fill` | `envelope.badge` |
| `mark_email_unread` | `envelope.badge` | `envelope.badge.fill` | `envelope.badge` |
| `markunread` | `envelope` | `envelope.fill` | `envelope` |
| `masks` | `facemask` | `facemask.fill` | `facemask` |
| `medical_services` | `cross.case` | `cross.case.fill` | `cross.case` |
| `medication` | `pills` | `pills.fill` | `pills` |
| `meeting_room` | `door.left.hand.closed` |  |  |
| `memory` | `memorychip` | `memorychip.fill` | `memorychip` |
| `menu` | `line.3.horizontal` |  |  |
| `menu_book` | `book` | `book.fill` | `book` |
| `merge` | `arrow.merge` |  |  |
| `merge_type` | `arrow.merge` |  |  |
| `message` | `bubble.left` | `bubble.left.fill` | `bubble.left` |
| `mic` | `mic` | `mic.fill` | `mic` |
| `mic_none` | `mic` |  | `mic` |
| `mic_off` | `mic.slash` | `mic.slash.fill` | `mic.slash` |
| `microwave` | `microwave` | `microwave.fill` | `microwave` |
| `military_tech` | `medal` | `medal.fill` | `medal` |
| `miscellaneous_services` | `gearshape.2` | `gearshape.2.fill` | `gearshape.2` |
| `mode_comment` | `bubble.left` | `bubble.left.fill` | `bubble.left` |
| `mode_edit` | `pencil` |  |  |
| `mode_edit_outline` | `pencil` |  |  |
| `mode_night` | `moon` | `moon.fill` | `moon` |
| `monetization_on` | `dollarsign.circle` | `dollarsign.circle.fill` | `dollarsign.circle` |
| `money` | `banknote` | `banknote.fill` | `banknote` |
| `monitor` | `desktopcomputer` |  |  |
| `monitor_heart` | `waveform.path.ecg.rectangle` | `waveform.path.ecg.rectangle.fill` | `waveform.path.ecg.rectangle` |
| `monitor_weight` | `scalemass` | `scalemass.fill` | `scalemass` |
| `mood` | `face.smiling` | `face.smiling.fill` | `face.smiling` |
| `more_horiz` | `ellipsis` |  |  |
| `more_vert` | `ellipsis` |  |  |
| `mouse` | `computermouse` | `computermouse.fill` | `computermouse` |
| `move_to_inbox` | `tray.and.arrow.down` | `tray.and.arrow.down.fill` | `tray.and.arrow.down` |
| `music_note` | `music.note` |  |  |
| `my_location` | `scope` |  |  |
| `nature` | `tree` | `tree.fill` | `tree` |
| `navigate_before` | `chevron.left` |  |  |
| `navigate_next` | `chevron.right` |  |  |
| `navigation` | `location.north` | `location.north.fill` | `location.north` |
| `near_me` | `location` | `location.fill` | `location` |
| `near_me_disabled` | `location.slash` | `location.slash.fill` | `location.slash` |
| `network_cell` | `cellularbars` |  |  |
| `network_wifi` | `wifi` |  |  |
| `newspaper` | `newspaper` | `newspaper.fill` | `newspaper` |
| `next_plan` | `arrow.forward.circle` | `arrow.forward.circle.fill` | `arrow.forward.circle` |
| `nightlight` | `moon` | `moon.fill` | `moon` |
| `nightlight_round` | `moon` | `moon.fill` | `moon` |
| `no_accounts` | `person.slash` | `person.slash.fill` | `person.slash` |
| `no_encryption` | `lock.slash` | `lock.slash.fill` | `lock.slash` |
| `no_encryption_gmailerrorred` | `lock.slash` | `lock.slash.fill` | `lock.slash` |
| `no_flash` | `bolt.slash` | `bolt.slash.fill` | `bolt.slash` |
| `north` | `arrow.up` |  |  |
| `north_east` | `arrow.up.right` |  |  |
| `north_west` | `arrow.up.left` |  |  |
| `not_interested` | `nosign` |  |  |
| `note` | `note.text` |  |  |
| `note_add` | `doc.badge.plus` | `doc.fill.badge.plus` | `doc.badge.plus` |
| `notes` | `note.text` |  |  |
| `notifications` | `bell` | `bell.fill` | `bell` |
| `notifications_active` | `bell.and.waves.left.and.right` | `bell.and.waves.left.and.right.fill` | `bell.and.waves.left.and.right` |
| `notifications_none` | `bell` |  | `bell` |
| `notifications_off` | `bell.slash` | `bell.slash.fill` | `bell.slash` |
| `numbers` | `number` |  |  |
| `ondemand_video` | `play.rectangle` | `play.rectangle.fill` | `play.rectangle` |
| `opacity` | `drop.halffull` |  |  |
| `open_in_full` | `arrow.up.left.and.arrow.down.right` |  |  |
| `open_in_new` | `arrow.up.forward.square` | `arrow.up.forward.square.fill` | `arrow.up.forward.square` |
| `open_with` | `arrow.up.and.down.and.arrow.left.and.right` |  |  |
| `outbond` | `arrow.up.right.circle` | `arrow.up.right.circle.fill` | `arrow.up.right.circle` |
| `outbound` | `arrow.up.right.circle` | `arrow.up.right.circle.fill` | `arrow.up.right.circle` |
| `outbox` | `tray.and.arrow.up` | `tray.and.arrow.up.fill` | `tray.and.arrow.up` |
| `outlet` | `poweroutlet.type.b` | `poweroutlet.type.b.fill` | `poweroutlet.type.b` |
| `pageview` | `doc.text.magnifyingglass` |  |  |
| `paid` | `dollarsign.circle` | `dollarsign.circle.fill` | `dollarsign.circle` |
| `palette` | `paintpalette` | `paintpalette.fill` | `paintpalette` |
| `pan_tool` | `hand.raised` | `hand.raised.fill` | `hand.raised` |
| `pan_tool_alt` | `hand.point.up` | `hand.point.up.fill` | `hand.point.up` |
| `panorama` | `pano` | `pano.fill` | `pano` |
| `panorama_fish_eye` | `circle` | `circle.fill` | `circle` |
| `panorama_horizontal` | `pano` | `pano.fill` | `pano` |
| `panorama_horizontal_select` | `pano.fill` | `pano.fill` | `pano` |
| `park` | `tree` | `tree.fill` | `tree` |
| `pause` | `pause.fill` | `pause.fill` | `pause` |
| `pause_circle` | `pause.circle` | `pause.circle.fill` | `pause.circle` |
| `pause_circle_filled` | `pause.circle.fill` | `pause.circle.fill` |  |
| `pause_circle_outline` | `pause.circle` |  | `pause.circle` |
| `pause_presentation` | `pause.rectangle` | `pause.rectangle.fill` | `pause.rectangle` |
| `payment` | `creditcard` | `creditcard.fill` | `creditcard` |
| `payments` | `banknote` | `banknote.fill` | `banknote` |
| `pedal_bike` | `bicycle` |  |  |
| `pending` | `ellipsis.circle` | `ellipsis.circle.fill` | `ellipsis.circle` |
| `pentagon` | `pentagon` | `pentagon.fill` | `pentagon` |
| `people` | `person.2` | `person.2.fill` | `person.2` |
| `people_alt` | `person.2` | `person.2.fill` | `person.2` |
| `people_outline` | `person.2` |  | `person.2` |
| `percent` | `percent` |  |  |
| `perm_identity` | `person` | `person.fill` | `person` |
| `perm_phone_msg` | `phone.bubble` | `phone.bubble.fill` | `phone.bubble` |
| `person` | `person` | `person.fill` | `person` |
| `person_add` | `person.badge.plus` | `person.badge.plus.fill` | `person.badge.plus` |
| `person_add_alt` | `person.badge.plus` | `person.badge.plus.fill` | `person.badge.plus` |
| `person_add_alt_1` | `person.badge.plus` | `person.badge.plus.fill` | `person.badge.plus` |
| `person_off` | `person.slash` | `person.slash.fill` | `person.slash` |
| `person_outline` | `person` |  | `person` |
| `person_remove` | `person.badge.minus` | `person.badge.minus.fill` | `person.badge.minus` |
| `person_remove_alt_1` | `person.badge.minus` | `person.badge.minus.fill` | `person.badge.minus` |
| `personal_video` | `tv` | `tv.fill` | `tv` |
| `pest_control` | `ant` | `ant.fill` | `ant` |
| `pets` | `pawprint` | `pawprint.fill` | `pawprint` |
| `phone` | `phone` | `phone.fill` | `phone` |
| `phone_enabled` | `phone` | `phone.fill` | `phone` |
| `phone_forwarded` | `phone.arrow.right` | `phone.arrow.right.fill` | `phone.arrow.right` |
| `phone_in_talk` | `phone.and.waveform` | `phone.and.waveform.fill` | `phone.and.waveform` |
| `photo` | `photo` | `photo.fill` | `photo` |
| `photo_album` | `photo.on.rectangle` |  |  |
| `photo_camera` | `camera` | `camera.fill` | `camera` |
| `photo_library` | `photo.on.rectangle` |  |  |
| `piano` | `pianokeys` |  |  |
| `picture_in_picture` | `pip` | `pip.fill` | `pip` |
| `picture_in_picture_alt` | `pip` | `pip.fill` | `pip` |
| `pie_chart` | `chart.pie` | `chart.pie.fill` | `chart.pie` |
| `pie_chart_outline` | `chart.pie` |  | `chart.pie` |
| `pin` | `pin` | `pin.fill` | `pin` |
| `place` | `mappin.and.ellipse` |  |  |
| `play_arrow` | `play.fill` | `play.fill` | `play` |
| `play_circle` | `play.circle` | `play.circle.fill` | `play.circle` |
| `play_circle_filled` | `play.circle.fill` | `play.circle.fill` |  |
| `play_circle_outline` | `play.circle` |  | `play.circle` |
| `playlist_add` | `text.badge.plus` |  |  |
| `playlist_add_check` | `text.badge.checkmark` |  |  |
| `playlist_remove` | `text.badge.minus` |  |  |
| `plumbing` | `wrench.adjustable` | `wrench.adjustable.fill` | `wrench.adjustable` |
| `poll` | `chart.bar` | `chart.bar.fill` | `chart.bar` |
| `pool` | `figure.pool.swim` |  |  |
| `portrait` | `person.crop.square` | `person.crop.square.fill` | `person.crop.square` |
| `post_add` | `doc.badge.plus` | `doc.fill.badge.plus` | `doc.badge.plus` |
| `power` | `powerplug` | `powerplug.fill` | `powerplug` |
| `power_settings_new` | `power` |  |  |
| `preview` | `eye` | `eye.fill` | `eye` |
| `print` | `printer` | `printer.fill` | `printer` |
| `priority_high` | `exclamationmark` |  |  |
| `privacy_tip` | `exclamationmark.shield` | `exclamationmark.shield.fill` | `exclamationmark.shield` |
| `psychology` | `brain.head.profile` | `brain.head.profile.fill` | `brain.head.profile` |
| `public` | `globe` |  |  |
| `publish` | `arrow.up.to.line` |  |  |
| `push_pin` | `pin` | `pin.fill` | `pin` |
| `qr_code` | `qrcode` |  |  |
| `qr_code_2` | `qrcode` |  |  |
| `qr_code_scanner` | `qrcode.viewfinder` |  |  |
| `query_builder` | `clock` | `clock.fill` | `clock` |
| `question_answer` | `bubble.left.and.bubble.right` | `bubble.left.and.bubble.right.fill` | `bubble.left.and.bubble.right` |
| `question_mark` | `questionmark` |  |  |
| `queue_music` | `music.note.list` |  |  |
| `radio` | `radio` | `radio.fill` | `radio` |
| `radio_button_checked` | `largecircle.fill.circle` |  |  |
| `radio_button_unchecked` | `circle` |  | `circle` |
| `rate_review` | `square.and.pencil` |  |  |
| `read_more` | `text.line.last.and.arrowtriangle.forward` |  |  |
| `rectangle` | `rectangle` | `rectangle.fill` | `rectangle` |
| `recycling` | `arrow.3.trianglepath` |  |  |
| `redeem` | `giftcard` | `giftcard.fill` | `giftcard` |
| `redo` | `arrow.uturn.forward` |  |  |
| `refresh` | `arrow.clockwise` |  |  |
| `remove` | `minus` |  |  |
| `remove_circle` | `minus.circle.fill` | `minus.circle.fill` | `minus.circle` |
| `remove_circle_outline` | `minus.circle` |  | `minus.circle` |
| `remove_red_eye` | `eye` | `eye.fill` | `eye` |
| `reorder` | `line.3.horizontal` |  |  |
| `repeat` | `repeat` |  |  |
| `repeat_one` | `repeat.1` |  |  |
| `replay` | `arrow.counterclockwise` |  |  |
| `replay_10` | `gobackward.10` |  |  |
| `replay_30` | `gobackward.30` |  |  |
| `replay_5` | `gobackward.5` |  |  |
| `replay_circle_filled` | `arrow.counterclockwise.circle.fill` | `arrow.counterclockwise.circle.fill` |  |
| `reply` | `arrowshape.turn.up.left` | `arrowshape.turn.up.left.fill` | `arrowshape.turn.up.left` |
| `reply_all` | `arrowshape.turn.up.left.2` | `arrowshape.turn.up.left.2.fill` | `arrowshape.turn.up.left.2` |
| `report` | `exclamationmark.octagon` | `exclamationmark.octagon.fill` | `exclamationmark.octagon` |
| `report_gmailerrorred` | `exclamationmark.octagon` | `exclamationmark.octagon.fill` | `exclamationmark.octagon` |
| `report_problem` | `exclamationmark.triangle` | `exclamationmark.triangle.fill` | `exclamationmark.triangle` |
| `restart_alt` | `arrow.clockwise` |  |  |
| `restaurant` | `fork.knife` |  |  |
| `restaurant_menu` | `fork.knife` |  |  |
| `restore` | `clock.arrow.circlepath` |  |  |
| `reviews` | `text.bubble` | `text.bubble.fill` | `text.bubble` |
| `ring_volume` | `phone.down.waves.left.and.right` |  |  |
| `roller_shades` | `blinds.horizontal.open` |  |  |
| `roller_shades_closed` | `blinds.horizontal.closed` |  |  |
| `roller_skating` | `figure.rolling` |  |  |
| `room` | `mappin.and.ellipse` |  |  |
| `rotate_90_degrees_ccw` | `rotate.left` | `rotate.left.fill` | `rotate.left` |
| `rotate_90_degrees_cw` | `rotate.right` | `rotate.right.fill` | `rotate.right` |
| `rotate_left` | `rotate.left` | `rotate.left.fill` | `rotate.left` |
| `rotate_right` | `rotate.right` | `rotate.right.fill` | `rotate.right` |
| `route` | `point.topleft.down.curvedto.point.bottomright.up` | `point.topleft.down.curvedto.point.bottomright.up.fill` | `point.topleft.down.curvedto.point.bottomright.up` |
| `router` | `wifi.router` | `wifi.router.fill` | `wifi.router` |
| `rowing` | `figure.rower` |  |  |
| `rss_feed` | `dot.radiowaves.up.forward` |  |  |
| `run_circle` | `figure.run.circle` | `figure.run.circle.fill` | `figure.run.circle` |
| `sailing` | `sailboat` | `sailboat.fill` | `sailboat` |
| `save` | `square.and.arrow.down` | `square.and.arrow.down.fill` | `square.and.arrow.down` |
| `save_alt` | `arrow.down.to.line` |  |  |
| `scatter_plot` | `chart.dots.scatter` |  |  |
| `schedule` | `clock` | `clock.fill` | `clock` |
| `school` | `graduationcap` | `graduationcap.fill` | `graduationcap` |
| `science` | `testtube.2` |  |  |
| `screen_search_desktop` | `rectangle.and.text.magnifyingglass` |  |  |
| `sd` | `sdcard` | `sdcard.fill` | `sdcard` |
| `sd_card` | `sdcard` | `sdcard.fill` | `sdcard` |
| `sd_storage` | `sdcard` | `sdcard.fill` | `sdcard` |
| `search` | `magnifyingglass` |  |  |
| `security` | `shield` | `shield.fill` | `shield` |
| `select_all` | `square.dashed.inset.filled` |  |  |
| `self_improvement` | `figure.mind.and.body` |  |  |
| `sell` | `tag` | `tag.fill` | `tag` |
| `send` | `paperplane` | `paperplane.fill` | `paperplane` |
| `sensors` | `sensor` | `sensor.fill` | `sensor` |
| `sentiment_satisfied` | `face.smiling` | `face.smiling.fill` | `face.smiling` |
| `sentiment_satisfied_alt` | `face.smiling` | `face.smiling.fill` | `face.smiling` |
| `settings` | `gearshape` | `gearshape.fill` | `gearshape` |
| `settings_input_antenna` | `antenna.radiowaves.left.and.right` |  |  |
| `share` | `square.and.arrow.up` | `square.and.arrow.up.fill` | `square.and.arrow.up` |
| `shield` | `shield` | `shield.fill` | `shield` |
| `shopping_bag` | `bag` | `bag.fill` | `bag` |
| `shopping_basket` | `basket` | `basket.fill` | `basket` |
| `shopping_cart` | `cart` | `cart.fill` | `cart` |
| `short_text` | `text.alignleft` |  |  |
| `shortcut` | `arrow.turn.up.right` |  |  |
| `show_chart` | `chart.xyaxis.line` |  |  |
| `shower` | `shower` | `shower.fill` | `shower` |
| `shuffle` | `shuffle` |  |  |
| `signal_cellular_4_bar` | `cellularbars` |  |  |
| `signal_cellular_alt` | `cellularbars` |  |  |
| `signal_wifi_4_bar` | `wifi` |  |  |
| `signal_wifi_bad` | `wifi.exclamationmark` |  |  |
| `signal_wifi_connected_no_internet_4` | `wifi.exclamationmark` |  |  |
| `signal_wifi_off` | `wifi.slash` |  |  |
| `signal_wifi_statusbar_4_bar` | `wifi` |  |  |
| `signal_wifi_statusbar_connected_no_internet_4` | `wifi.exclamationmark` |  |  |
| `signpost` | `signpost.right` | `signpost.right.fill` | `signpost.right` |
| `sim_card` | `simcard` | `simcard.fill` | `simcard` |
| `skip_next` | `forward.end.fill` | `forward.end.fill` | `forward.end` |
| `skip_previous` | `backward.end.fill` | `backward.end.fill` | `backward.end` |
| `slideshow` | `play.rectangle` | `play.rectangle.fill` | `play.rectangle` |
| `slow_motion_video` | `slowmo` |  |  |
| `smart_display` | `play.rectangle` | `play.rectangle.fill` | `play.rectangle` |
| `smartphone` | `smartphone` |  |  |
| `sms` | `bubble.left` | `bubble.left.fill` | `bubble.left` |
| `snowboarding` | `figure.snowboarding` |  |  |
| `sort` | `arrow.up.arrow.down` |  |  |
| `south` | `arrow.down` |  |  |
| `south_america` | `globe.americas` | `globe.americas.fill` | `globe.americas` |
| `south_east` | `arrow.down.right` |  |  |
| `south_west` | `arrow.down.left` |  |  |
| `speaker_group` | `hifispeaker.2` | `hifispeaker.2.fill` | `hifispeaker.2` |
| `speaker_notes` | `text.bubble` | `text.bubble.fill` | `text.bubble` |
| `speed` | `speedometer` |  |  |
| `spellcheck` | `text.badge.checkmark` |  |  |
| `splitscreen` | `rectangle.split.1x2` | `rectangle.split.1x2.fill` | `rectangle.split.1x2` |
| `sports_baseball` | `baseball` | `baseball.fill` | `baseball` |
| `sports_basketball` | `basketball` | `basketball.fill` | `basketball` |
| `sports_cricket` | `cricket.ball` | `cricket.ball.fill` | `cricket.ball` |
| `sports_esports` | `gamecontroller` | `gamecontroller.fill` | `gamecontroller` |
| `sports_football` | `football` | `football.fill` | `football` |
| `sports_gymnastics` | `figure.gymnastics` |  |  |
| `sports_handball` | `figure.handball` |  |  |
| `sports_hockey` | `hockey.puck` | `hockey.puck.fill` | `hockey.puck` |
| `sports_martial_arts` | `figure.martial.arts` |  |  |
| `sports_rugby` | `figure.rugby` |  |  |
| `sports_score` | `flag.checkered` |  |  |
| `sports_soccer` | `soccerball` |  |  |
| `sports_tennis` | `tennisball` | `tennisball.fill` | `tennisball` |
| `sports_volleyball` | `volleyball` | `volleyball.fill` | `volleyball` |
| `square` | `square` | `square.fill` | `square` |
| `stairs` | `stairs` |  |  |
| `star` | `star` | `star.fill` | `star` |
| `star_border` | `star` |  | `star` |
| `star_half` | `star.leadinghalf.filled` |  |  |
| `star_outline` | `star` |  | `star` |
| `star_purple_500` | `star` | `star.fill` | `star` |
| `star_rate` | `star` | `star.fill` | `star` |
| `stars` | `star.circle` | `star.circle.fill` | `star.circle` |
| `sticky_note_2` | `note.text` |  |  |
| `stop` | `stop.fill` | `stop.fill` | `stop` |
| `stop_circle` | `stop.circle` | `stop.circle.fill` | `stop.circle` |
| `store` | `storefront` | `storefront.fill` | `storefront` |
| `store_mall_directory` | `storefront` | `storefront.fill` | `storefront` |
| `storefront` | `storefront` | `storefront.fill` | `storefront` |
| `storm` | `hurricane` |  |  |
| `straight` | `arrow.up` |  |  |
| `straighten` | `ruler` | `ruler.fill` | `ruler` |
| `stream` | `dot.radiowaves.left.and.right` |  |  |
| `strikethrough_s` | `strikethrough` |  |  |
| `stroller` | `stroller` | `stroller.fill` | `stroller` |
| `subdirectory_arrow_left` | `arrow.turn.down.left` |  |  |
| `subdirectory_arrow_right` | `arrow.turn.down.right` |  |  |
| `subject` | `text.alignleft` |  |  |
| `subscript` | `textformat.subscript` |  |  |
| `subscriptions` | `play.rectangle.on.rectangle` | `play.rectangle.on.rectangle.fill` | `play.rectangle.on.rectangle` |
| `subtitles` | `captions.bubble` | `captions.bubble.fill` | `captions.bubble` |
| `subway` | `tram` | `tram.fill` | `tram` |
| `summarize` | `doc.text` | `doc.text.fill` | `doc.text` |
| `superscript` | `textformat.superscript` |  |  |
| `support` | `lifepreserver` | `lifepreserver.fill` | `lifepreserver` |
| `surfing` | `figure.surfing` |  |  |
| `swap_horiz` | `arrow.left.arrow.right` |  |  |
| `swap_horizontal_circle` | `arrow.left.arrow.right.circle` | `arrow.left.arrow.right.circle.fill` | `arrow.left.arrow.right.circle` |
| `swap_vert` | `arrow.up.arrow.down` |  |  |
| `swap_vertical_circle` | `arrow.up.arrow.down.circle` | `arrow.up.arrow.down.circle.fill` | `arrow.up.arrow.down.circle` |
| `switch_camera` | `arrow.triangle.2.circlepath.camera` | `arrow.triangle.2.circlepath.camera.fill` | `arrow.triangle.2.circlepath.camera` |
| `sync` | `arrow.triangle.2.circlepath` |  |  |
| `sync_alt` | `arrow.left.arrow.right` |  |  |
| `sync_problem` | `exclamationmark.arrow.triangle.2.circlepath` |  |  |
| `table_restaurant` | `table.furniture` | `table.furniture.fill` | `table.furniture` |
| `tag` | `number` |  |  |
| `tag_faces` | `face.smiling` | `face.smiling.fill` | `face.smiling` |
| `task_alt` | `checkmark.circle` | `checkmark.circle.fill` | `checkmark.circle` |
| `terminal` | `terminal` | `terminal.fill` | `terminal` |
| `terrain` | `mountain.2` | `mountain.2.fill` | `mountain.2` |
| `text_decrease` | `textformat.size.smaller` |  |  |
| `text_fields` | `textformat` |  |  |
| `text_format` | `textformat` |  |  |
| `text_increase` | `textformat.size.larger` |  |  |
| `text_snippet` | `doc.text` | `doc.text.fill` | `doc.text` |
| `textsms` | `bubble.left` | `bubble.left.fill` | `bubble.left` |
| `theater_comedy` | `theatermasks` | `theatermasks.fill` | `theatermasks` |
| `theaters` | `film` | `film.fill` | `film` |
| `thermostat` | `thermometer.medium` |  |  |
| `thumb_down` | `hand.thumbsdown` | `hand.thumbsdown.fill` | `hand.thumbsdown` |
| `thumb_down_alt` | `hand.thumbsdown` | `hand.thumbsdown.fill` | `hand.thumbsdown` |
| `thumb_down_off_alt` | `hand.thumbsdown` |  | `hand.thumbsdown` |
| `thumb_up` | `hand.thumbsup` | `hand.thumbsup.fill` | `hand.thumbsup` |
| `thumb_up_alt` | `hand.thumbsup` | `hand.thumbsup.fill` | `hand.thumbsup` |
| `thumb_up_off_alt` | `hand.thumbsup` |  | `hand.thumbsup` |
| `thunderstorm` | `cloud.bolt.rain` | `cloud.bolt.rain.fill` | `cloud.bolt.rain` |
| `time_to_leave` | `car` | `car.fill` | `car` |
| `timeline` | `chart.xyaxis.line` |  |  |
| `timer` | `timer` |  |  |
| `title` | `textformat` |  |  |
| `toc` | `list.bullet` |  |  |
| `today` | `calendar` |  |  |
| `tornado` | `tornado` |  |  |
| `touch_app` | `hand.tap` | `hand.tap.fill` | `hand.tap` |
| `train` | `tram` | `tram.fill` | `tram` |
| `tram` | `tram` | `tram.fill` | `tram` |
| `translate` | `character.bubble` | `character.bubble.fill` | `character.bubble` |
| `trending_flat` | `arrow.right` |  |  |
| `tune` | `slider.horizontal.3` |  |  |
| `turn_left` | `arrow.turn.up.left` |  |  |
| `turn_right` | `arrow.turn.up.right` |  |  |
| `turned_in` | `bookmark` | `bookmark.fill` | `bookmark` |
| `turned_in_not` | `bookmark` |  | `bookmark` |
| `tv` | `tv` | `tv.fill` | `tv` |
| `tv_off` | `tv.slash` |  |  |
| `u_turn_left` | `arrow.uturn.left` |  |  |
| `u_turn_right` | `arrow.uturn.right` |  |  |
| `umbrella` | `umbrella` | `umbrella.fill` | `umbrella` |
| `unarchive` | `tray.and.arrow.up` | `tray.and.arrow.up.fill` | `tray.and.arrow.up` |
| `undo` | `arrow.uturn.backward` |  |  |
| `unfold_more` | `arrow.up.and.down` |  |  |
| `update` | `clock.arrow.circlepath` |  |  |
| `upgrade` | `arrow.up.to.line` |  |  |
| `upload` | `arrow.up.to.line` |  |  |
| `upload_file` | `doc.badge.arrow.up` | `doc.badge.arrow.up.fill` | `doc.badge.arrow.up` |
| `vaccines` | `syringe` | `syringe.fill` | `syringe` |
| `verified` | `checkmark.seal` | `checkmark.seal.fill` | `checkmark.seal` |
| `verified_user` | `checkmark.shield` | `checkmark.shield.fill` | `checkmark.shield` |
| `vertical_align_bottom` | `align.vertical.bottom` | `align.vertical.bottom.fill` | `align.vertical.bottom` |
| `vertical_align_center` | `align.vertical.center` | `align.vertical.center.fill` | `align.vertical.center` |
| `vertical_align_top` | `align.vertical.top` | `align.vertical.top.fill` | `align.vertical.top` |
| `vertical_shades` | `blinds.vertical.open` |  |  |
| `vertical_shades_closed` | `blinds.vertical.closed` |  |  |
| `vertical_split` | `rectangle.split.2x1` | `rectangle.split.2x1.fill` | `rectangle.split.2x1` |
| `video_chat` | `video.bubble.left` | `video.bubble.left.fill` | `video.bubble.left` |
| `videogame_asset` | `gamecontroller` | `gamecontroller.fill` | `gamecontroller` |
| `view_agenda` | `rectangle.split.1x2` | `rectangle.split.1x2.fill` | `rectangle.split.1x2` |
| `view_column` | `rectangle.split.3x1` | `rectangle.split.3x1.fill` | `rectangle.split.3x1` |
| `view_headline` | `line.3.horizontal` |  |  |
| `view_list` | `list.bullet` |  |  |
| `view_sidebar` | `sidebar.left` |  |  |
| `view_stream` | `rectangle.split.1x2` | `rectangle.split.1x2.fill` | `rectangle.split.1x2` |
| `visibility` | `eye` | `eye.fill` | `eye` |
| `visibility_off` | `eye.slash` | `eye.slash.fill` | `eye.slash` |
| `voice_chat` | `waveform.and.mic` |  |  |
| `voicemail` | `recordingtape` |  |  |
| `volume_down` | `speaker.wave.1` | `speaker.wave.1.fill` | `speaker.wave.1` |
| `volume_mute` | `speaker` | `speaker.fill` | `speaker` |
| `volume_off` | `speaker.slash` | `speaker.slash.fill` | `speaker.slash` |
| `volume_up` | `speaker.wave.3` | `speaker.wave.3.fill` | `speaker.wave.3` |
| `vpn_key` | `key` | `key.fill` | `key` |
| `vpn_key_off` | `key.slash` | `key.slash.fill` | `key.slash` |
| `wallet` | `wallet.pass` | `wallet.pass.fill` | `wallet.pass` |
| `warning` | `exclamationmark.triangle` | `exclamationmark.triangle.fill` | `exclamationmark.triangle` |
| `warning_amber` | `exclamationmark.triangle` | `exclamationmark.triangle.fill` | `exclamationmark.triangle` |
| `watch_later` | `clock` | `clock.fill` | `clock` |
| `water` | `water.waves` |  |  |
| `water_drop` | `drop` | `drop.fill` | `drop` |
| `waves` | `water.waves` |  |  |
| `waving_hand` | `hand.wave` | `hand.wave.fill` | `hand.wave` |
| `wb_cloudy` | `cloud` | `cloud.fill` | `cloud` |
| `wb_incandescent` | `lightbulb` | `lightbulb.fill` | `lightbulb` |
| `wb_sunny` | `sun.max` | `sun.max.fill` | `sun.max` |
| `wb_twilight` | `sun.horizon` | `sun.horizon.fill` | `sun.horizon` |
| `weekend` | `sofa` | `sofa.fill` | `sofa` |
| `west` | `arrow.left` |  |  |
| `whatshot` | `flame` | `flame.fill` | `flame` |
| `wifi` | `wifi` |  |  |
| `wifi_off` | `wifi.slash` |  |  |
| `wifi_tethering` | `dot.radiowaves.left.and.right` |  |  |
| `window` | `window.vertical.closed` |  |  |
| `wine_bar` | `wineglass` | `wineglass.fill` | `wineglass` |
| `work` | `briefcase` | `briefcase.fill` | `briefcase` |
| `work_outline` | `briefcase` |  | `briefcase` |
| `workspace_premium` | `rosette` |  |  |
| `wysiwyg` | `doc.richtext` | `doc.richtext.fill` | `doc.richtext` |
| `zoom_in` | `plus.magnifyingglass` |  |  |
| `zoom_in_map` | `arrow.up.left.and.arrow.down.right` |  |  |
| `zoom_out` | `minus.magnifyingglass` |  |  |
| `zoom_out_map` | `arrow.down.right.and.arrow.up.left` |  |  |
