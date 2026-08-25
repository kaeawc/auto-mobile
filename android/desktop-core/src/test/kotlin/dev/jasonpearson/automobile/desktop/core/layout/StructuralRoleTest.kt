package dev.jasonpearson.automobile.desktop.core.layout

import org.junit.Assert.assertEquals
import org.junit.Test

/** Pure, fast tests for the cross-platform class-name → [StructuralRole] mapping (issue #4872). */
class StructuralRoleTest {

  @Test
  fun `android widgets map to their roles`() {
    assertEquals(StructuralRole.Container, structuralRole("android.widget.FrameLayout"))
    assertEquals(StructuralRole.Container, structuralRole("android.view.ViewGroup"))
    assertEquals(
      StructuralRole.Container,
      structuralRole("androidx.compose.ui.platform.ComposeView"),
    )
    assertEquals(StructuralRole.Text, structuralRole("android.widget.TextView"))
    assertEquals(StructuralRole.TextField, structuralRole("android.widget.EditText"))
    assertEquals(StructuralRole.Button, structuralRole("android.widget.Button"))
    assertEquals(StructuralRole.Button, structuralRole("androidx.appcompat.widget.AppCompatButton"))
    assertEquals(StructuralRole.Button, structuralRole("android.widget.ImageButton"))
    assertEquals(StructuralRole.Image, structuralRole("android.widget.ImageView"))
    assertEquals(StructuralRole.List, structuralRole("androidx.recyclerview.widget.RecyclerView"))
    assertEquals(StructuralRole.List, structuralRole("android.widget.ListView"))
    assertEquals(StructuralRole.Checkbox, structuralRole("android.widget.CheckBox"))
    assertEquals(StructuralRole.Switch, structuralRole("androidx.appcompat.widget.SwitchCompat"))
    assertEquals(StructuralRole.Switch, structuralRole("android.widget.ToggleButton"))
    assertEquals(StructuralRole.Toolbar, structuralRole("androidx.appcompat.widget.Toolbar"))
    assertEquals(StructuralRole.ScrollView, structuralRole("android.widget.NestedScrollView"))
    assertEquals(StructuralRole.WebView, structuralRole("android.webkit.WebView"))
  }

  @Test
  fun `ios element types map to their roles`() {
    assertEquals(StructuralRole.Container, structuralRole("XCUIElementTypeApplication"))
    assertEquals(StructuralRole.Container, structuralRole("XCUIElementTypeWindow"))
    assertEquals(StructuralRole.Container, structuralRole("XCUIElementTypeOther"))
    assertEquals(StructuralRole.Container, structuralRole("XCUIElementTypeGroup"))
    assertEquals(StructuralRole.Text, structuralRole("XCUIElementTypeStaticText"))
    assertEquals(StructuralRole.TextField, structuralRole("XCUIElementTypeTextField"))
    assertEquals(StructuralRole.TextField, structuralRole("XCUIElementTypeSecureTextField"))
    assertEquals(StructuralRole.TextField, structuralRole("XCUIElementTypeSearchField"))
    assertEquals(StructuralRole.TextField, structuralRole("XCUIElementTypeTextView"))
    assertEquals(StructuralRole.Button, structuralRole("XCUIElementTypeButton"))
    assertEquals(StructuralRole.Image, structuralRole("XCUIElementTypeImage"))
    assertEquals(StructuralRole.List, structuralRole("XCUIElementTypeTable"))
    assertEquals(StructuralRole.List, structuralRole("XCUIElementTypeCollectionView"))
    assertEquals(StructuralRole.ListItem, structuralRole("XCUIElementTypeCell"))
    assertEquals(StructuralRole.Switch, structuralRole("XCUIElementTypeSwitch"))
    assertEquals(StructuralRole.Toolbar, structuralRole("XCUIElementTypeNavigationBar"))
    assertEquals(StructuralRole.Toolbar, structuralRole("XCUIElementTypeTabBar"))
    assertEquals(StructuralRole.ScrollView, structuralRole("XCUIElementTypeScrollView"))
  }

  @Test
  fun `android and ios classes for the same widget share a role`() {
    assertEquals(structuralRole("android.widget.Button"), structuralRole("XCUIElementTypeButton"))
    assertEquals(
      structuralRole("android.widget.TextView"),
      structuralRole("XCUIElementTypeStaticText"),
    )
    assertEquals(
      structuralRole("androidx.recyclerview.widget.RecyclerView"),
      structuralRole("XCUIElementTypeTable"),
    )
    assertEquals(
      structuralRole("android.widget.EditText"),
      structuralRole("XCUIElementTypeTextField"),
    )
  }

  @Test
  fun `toggles and checkboxes win over the button substring`() {
    // ToggleButton / CompoundButton contain "Button" but must not classify as Button.
    assertEquals(StructuralRole.Switch, structuralRole("android.widget.ToggleButton"))
    assertEquals(StructuralRole.Checkbox, structuralRole("android.widget.CheckBox"))
  }

  @Test
  fun `unknown classes fall back to Other`() {
    assertEquals(StructuralRole.Other, structuralRole("com.example.CustomThing"))
    assertEquals(StructuralRole.Other, structuralRole(""))
  }
}
