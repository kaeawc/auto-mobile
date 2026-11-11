package dev.jasonpearson.automobile.wearfixture

/**
 * What an incoming intent asks for: the tile and the complication open an item's detail screen, and
 * a notification action reports the reply text or which action was pressed.
 */
data class LaunchRequest(
  val itemId: String? = null,
  val notificationActionId: String? = null,
  val replyText: String? = null,
) {
  /** The back stack to show, or null to keep the current one. */
  fun backStack(): FixtureBackStack? =
    WearFixtureCatalog.item(itemId)?.let { FixtureBackStack().push(FixtureRoute.Detail(it.id)) }

  /** The status line to show, or null to keep the current one. */
  fun status(): String? =
    replyText?.let { "Notification reply: $it" }
      ?: WearFixtureCatalog.notificationActionStatus(notificationActionId)

  companion object {
    const val EXTRA_ITEM_ID = "dev.jasonpearson.automobile.wearfixture.ITEM_ID"
    const val EXTRA_NOTIFICATION_ACTION =
      "dev.jasonpearson.automobile.wearfixture.NOTIFICATION_ACTION"
  }
}
