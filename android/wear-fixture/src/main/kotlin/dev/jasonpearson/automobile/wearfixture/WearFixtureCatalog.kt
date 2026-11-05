package dev.jasonpearson.automobile.wearfixture

/** One list element with a stable id, title and detail text. */
data class FixtureItem(val id: String, val title: String, val detail: String)

/** A home-screen entry that opens one of the fixture's other surfaces. */
data class FixtureAction(val id: String, val label: String)

/**
 * Every piece of text and every id the fixture shows. Checks match on these exact strings, so
 * changing one is a contract change for the Wear smoke run.
 */
object WearFixtureCatalog {
  const val APP_TITLE = "AutoMobile Wear"
  const val ITEM_COUNT = 30

  /** The item the tile and the complication open. */
  const val FEATURED_ITEM_ID = "item_07"

  const val STATUS_READY = "Ready"
  const val STATUS_CONFIRMED = "Confirmed"
  const val STATUS_CANCELLED = "Cancelled"
  const val STATUS_DISMISSED = "Dismissed"
  const val STATUS_ALERT_POSTED = "Notification posted"
  const val STATUS_ONGOING_STARTED = "Ongoing activity started"
  const val STATUS_ONGOING_STOPPED = "Ongoing activity stopped"
  const val STATUS_PERMISSION_DENIED = "Notification permission denied"

  const val DISMISS_TEXT = "Swipe right to dismiss"
  const val CONFIRM_TITLE = "Confirm fixture action?"
  const val CONFIRM_LABEL = "Confirm"
  const val CANCEL_LABEL = "Cancel"
  const val PICKER_HINT = "Turn the crown"

  const val ACTION_PICKER = "action_picker"
  const val ACTION_DISMISS = "action_dismiss"
  const val ACTION_CONFIRM = "action_confirm"
  const val ACTION_NOTIFY = "action_notify"
  const val ACTION_ONGOING_START = "action_ongoing_start"
  const val ACTION_ONGOING_STOP = "action_ongoing_stop"

  /** Entries above the list, so each is reachable without scrolling far. */
  val actions: List<FixtureAction> =
    listOf(
      FixtureAction(ACTION_PICKER, "Rotary picker"),
      FixtureAction(ACTION_DISMISS, "Swipe to dismiss"),
      FixtureAction(ACTION_CONFIRM, "Confirmation"),
      FixtureAction(ACTION_NOTIFY, "Post notification"),
      FixtureAction(ACTION_ONGOING_START, "Start ongoing"),
      FixtureAction(ACTION_ONGOING_STOP, "Stop ongoing"),
    )

  /** Longer than any round or square Wear screen, so the list must scroll. */
  val items: List<FixtureItem> =
    (1..ITEM_COUNT).map { index ->
      val number = index.toString().padStart(2, '0')
      FixtureItem("item_$number", "Item $number", "Detail for Item $number")
    }

  fun item(id: String?): FixtureItem? = items.firstOrNull { it.id == id }

  /** Picker values; the picker clamps at both ends instead of wrapping. */
  val pickerValues: List<String> = (0..11).map { "Level $it" }

  fun pickerStatus(value: String): String = "Picked $value"

  // Notification surface.
  const val CHANNEL_ID = "fixture_alerts"
  const val CHANNEL_NAME = "Fixture alerts"
  const val ALERT_NOTIFICATION_ID = 1601
  const val ONGOING_NOTIFICATION_ID = 1602
  const val ALERT_TITLE = "Fixture alert"
  const val ALERT_TEXT = "Two actions follow"
  const val ONGOING_TITLE = "Fixture run"
  const val ONGOING_STATUS = "Fixture run in progress"

  /** Notification action ids and labels, in the order the notification shows them. */
  val notificationActions: List<FixtureAction> =
    listOf(FixtureAction("reply", "Reply"), FixtureAction("archive", "Archive"))

  fun notificationActionStatus(actionId: String?): String? =
    notificationActions
      .firstOrNull { it.id == actionId }
      ?.let { "Notification action: ${it.label}" }

  // Tile and complication surfaces.
  const val TILE_TITLE = "AutoMobile Tile"
  const val TILE_CLICKABLE_ID = "tile_open_item"
  const val COMPLICATION_TITLE = "Item"
  const val COMPLICATION_SHORT_TEXT = "07"
  const val COMPLICATION_DESCRIPTION = "Fixture complication"
  const val RANGED_VALUE = 7f
  const val RANGED_MIN = 0f
  const val RANGED_MAX = 10f
  const val RANGED_TEXT = "7/10"

  fun tileLabel(item: FixtureItem): String = "Open ${item.title}"
}
