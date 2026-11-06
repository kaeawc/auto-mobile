package dev.jasonpearson.automobile.wearfixture

/**
 * Everything the fixture UI shows besides the list itself. Each transition is a pure function, so
 * navigation and status-line behavior are tested without Compose.
 */
data class FixtureState(
  val backStack: FixtureBackStack = FixtureBackStack(),
  val status: String = WearFixtureCatalog.STATUS_READY,
  val pickerIndex: Int = 0,
  val showConfirm: Boolean = false,
) {
  /** The state after a home action, or null when the action is a notification action. */
  fun onHomeAction(actionId: String): FixtureState? =
    when (actionId) {
      WearFixtureCatalog.ACTION_PICKER -> push(FixtureRoute.Picker)
      WearFixtureCatalog.ACTION_DISMISS -> push(FixtureRoute.Dismiss)
      WearFixtureCatalog.ACTION_CONFIRM -> copy(showConfirm = true)
      else -> null
    }

  fun openItem(itemId: String): FixtureState = push(FixtureRoute.Detail(itemId))

  fun back(): FixtureState = copy(backStack = backStack.pop())

  fun pickerChanged(index: Int): FixtureState =
    copy(
      pickerIndex = index,
      status = WearFixtureCatalog.pickerStatus(WearFixtureCatalog.pickerValues[index]),
    )

  fun dismissScreenDismissed(): FixtureState =
    copy(backStack = backStack.pop(), status = WearFixtureCatalog.STATUS_DISMISSED)

  fun confirmResult(confirmed: Boolean): FixtureState =
    copy(
      showConfirm = false,
      status =
        if (confirmed) WearFixtureCatalog.STATUS_CONFIRMED else WearFixtureCatalog.STATUS_CANCELLED,
    )

  fun withStatus(value: String): FixtureState = copy(status = value)

  fun launched(request: LaunchRequest): FixtureState =
    copy(
      backStack = request.backStack() ?: backStack,
      status = request.status() ?: status,
      showConfirm = showConfirm && request.backStack() == null,
    )

  /** Bundle-safe values for saved instance state. */
  fun toSaved(): List<Any> =
    listOf(ArrayList(backStack.toRoutes()), status, pickerIndex, showConfirm)

  private fun push(route: FixtureRoute): FixtureState = copy(backStack = backStack.push(route))

  companion object {
    private const val SAVED_SIZE = 4

    /** Restores [toSaved] output; anything malformed restores the initial state. */
    fun fromSaved(saved: List<Any?>): FixtureState {
      if (saved.size != SAVED_SIZE) return FixtureState()
      val routes = (saved[0] as? List<*>)?.filterIsInstance<String>().orEmpty()
      val index = (saved[2] as? Int)?.takeIf { it in WearFixtureCatalog.pickerValues.indices } ?: 0
      return FixtureState(
        backStack = FixtureBackStack.fromRoutes(routes),
        status = saved[1] as? String ?: WearFixtureCatalog.STATUS_READY,
        pickerIndex = index,
        showConfirm = saved[3] as? Boolean ?: false,
      )
    }
  }
}
