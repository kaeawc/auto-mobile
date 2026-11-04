package dev.jasonpearson.automobile.wearfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FixtureStateTest {
  private val initial = FixtureState()

  @Test
  fun `home actions open the picker, the dismiss screen and the dialog`() {
    assertEquals(
      FixtureRoute.Picker,
      initial.onHomeAction(WearFixtureCatalog.ACTION_PICKER)?.backStack?.current,
    )
    assertEquals(
      FixtureRoute.Dismiss,
      initial.onHomeAction(WearFixtureCatalog.ACTION_DISMISS)?.backStack?.current,
    )
    assertTrue(initial.onHomeAction(WearFixtureCatalog.ACTION_CONFIRM)!!.showConfirm)
  }

  @Test
  fun `notification actions are left to the notification runner`() {
    assertNull(initial.onHomeAction(WearFixtureCatalog.ACTION_NOTIFY))
    assertNull(initial.onHomeAction(WearFixtureCatalog.ACTION_ONGOING_START))
    assertNull(initial.onHomeAction(WearFixtureCatalog.ACTION_ONGOING_STOP))
  }

  @Test
  fun `item then back returns home with the status untouched`() {
    val detail = initial.openItem("item_12")
    assertEquals(FixtureRoute.Detail("item_12"), detail.backStack.current)
    assertEquals(initial, detail.back())
  }

  @Test
  fun `picker changes, dismissal and dialog results set the status line`() {
    assertEquals("Picked Level 4", initial.pickerChanged(4).status)
    assertEquals(4, initial.pickerChanged(4).pickerIndex)

    val dismissed =
      initial.onHomeAction(WearFixtureCatalog.ACTION_DISMISS)!!.dismissScreenDismissed()
    assertEquals(FixtureRoute.Home, dismissed.backStack.current)
    assertEquals("Dismissed", dismissed.status)

    val dialog = initial.onHomeAction(WearFixtureCatalog.ACTION_CONFIRM)!!
    assertEquals("Confirmed", dialog.confirmResult(true).status)
    assertEquals("Cancelled", dialog.confirmResult(false).status)
    assertFalse(dialog.confirmResult(true).showConfirm)
  }

  @Test
  fun `a launch for an item replaces the stack and closes the dialog`() {
    val launched =
      initial
        .onHomeAction(WearFixtureCatalog.ACTION_CONFIRM)!!
        .launched(LaunchRequest(itemId = "item_07"))
    assertEquals(listOf("home", "detail/item_07"), launched.backStack.toRoutes())
    assertFalse(launched.showConfirm)
  }

  @Test
  fun `a launch for a notification action keeps the screen and sets the status`() {
    val picker = initial.onHomeAction(WearFixtureCatalog.ACTION_PICKER)!!
    val launched = picker.launched(LaunchRequest(notificationActionId = "reply"))
    assertEquals(FixtureRoute.Picker, launched.backStack.current)
    assertEquals("Notification action: Reply", launched.status)
  }

  @Test
  fun `saved state round-trips and malformed saved state restores the initial state`() {
    val state = initial.openItem("item_02").pickerChanged(9).copy(showConfirm = true)
    assertEquals(state, FixtureState.fromSaved(state.toSaved()))
    assertEquals(initial, FixtureState.fromSaved(emptyList()))
    assertEquals(
      FixtureState(status = "x"),
      FixtureState.fromSaved(listOf("not a list", "x", 99, "no")),
    )
  }
}
