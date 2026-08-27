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
    assertEquals(StructuralRole.Progress, structuralRole("android.widget.ProgressBar"))
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

  /**
   * The class names the live iOS runner actually reports are the UIKit names emitted by
   * `ElementLocator.mapElementType` (e.g. `XCUIApplication`, `UILabel`, `UITableView`), not the
   * `XCUIElementType*` forms tested above. These must map to the same roles or a live Android↔iOS
   * diff keys on mismatched roots and reads as two disjoint trees (issue #4872).
   */
  @Test
  fun `ios UIKit class names emitted by the runner map to their roles`() {
    assertEquals(StructuralRole.Container, structuralRole("XCUIApplication"))
    assertEquals(StructuralRole.Container, structuralRole("UIWindow"))
    assertEquals(StructuralRole.Container, structuralRole("UIView"))
    assertEquals(StructuralRole.Text, structuralRole("UILabel"))
    assertEquals(StructuralRole.TextField, structuralRole("UITextField"))
    assertEquals(StructuralRole.TextField, structuralRole("UISecureTextField"))
    assertEquals(StructuralRole.TextField, structuralRole("UITextView"))
    assertEquals(StructuralRole.TextField, structuralRole("UISearchBar"))
    assertEquals(StructuralRole.Button, structuralRole("UIButton"))
    assertEquals(StructuralRole.Image, structuralRole("UIImageView"))
    assertEquals(StructuralRole.List, structuralRole("UITableView"))
    assertEquals(StructuralRole.List, structuralRole("UICollectionView"))
    assertEquals(StructuralRole.ListItem, structuralRole("UITableViewCell"))
    assertEquals(StructuralRole.Switch, structuralRole("UISwitch"))
    assertEquals(StructuralRole.Toolbar, structuralRole("UIToolbar"))
    assertEquals(StructuralRole.Toolbar, structuralRole("UINavigationBar"))
    assertEquals(StructuralRole.Toolbar, structuralRole("UITabBar"))
    assertEquals(StructuralRole.ScrollView, structuralRole("UIScrollView"))
    assertEquals(StructuralRole.Progress, structuralRole("UIProgressView"))
    assertEquals(StructuralRole.Progress, structuralRole("UIActivityIndicatorView"))
    assertEquals(StructuralRole.WebView, structuralRole("WKWebView"))
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

  /** The same widget families align on the UIKit names the runner actually emits. */
  @Test
  fun `android and ios UIKit classes for the same widget share a role`() {
    assertEquals(structuralRole("android.widget.FrameLayout"), structuralRole("XCUIApplication"))
    assertEquals(structuralRole("android.widget.Button"), structuralRole("UIButton"))
    assertEquals(structuralRole("android.widget.TextView"), structuralRole("UILabel"))
    assertEquals(structuralRole("android.widget.EditText"), structuralRole("UITextField"))
    assertEquals(
      structuralRole("androidx.recyclerview.widget.RecyclerView"),
      structuralRole("UITableView"),
    )
    assertEquals(structuralRole("android.widget.ImageView"), structuralRole("UIImageView"))
  }

  @Test
  fun `toggles and checkboxes win over the button substring`() {
    // ToggleButton / CompoundButton contain "Button" but must not classify as Button.
    assertEquals(StructuralRole.Switch, structuralRole("android.widget.ToggleButton"))
    assertEquals(StructuralRole.Checkbox, structuralRole("android.widget.CheckBox"))
  }

  /**
   * The live Android compare root is a class-less synthetic wrapper: both extraction paths wrap the
   * capture in a class-less node and `HierarchyParser` defaults that to `android.view.View`. It
   * must map to [StructuralRole.Container] like the iOS `XCUIApplication`/`UIView` root, or every
   * descendant key (which includes the root segment) would be disjoint across a live Android↔iOS
   * pair (issue #4872 review).
   */
  @Test
  fun `the class-less android root maps to Container like the ios root`() {
    assertEquals(StructuralRole.Container, structuralRole("android.view.View"))
    assertEquals(StructuralRole.Container, structuralRole("View"))
    assertEquals(structuralRole("android.view.View"), structuralRole("XCUIApplication"))
    assertEquals(structuralRole("android.view.View"), structuralRole("UIView"))
  }

  /**
   * A radio button contains the `Button` substring but is a single-choice checkable control. It
   * folds into [StructuralRole.Checkbox] so it pairs with the iOS runner's radio, which arrives as
   * a checkable generic node that `structuralRoleOf` promotes to Checkbox (issue #4872 review).
   */
  @Test
  fun `radio buttons win over the button substring and fold into Checkbox`() {
    assertEquals(StructuralRole.Checkbox, structuralRole("android.widget.RadioButton"))
    assertEquals(
      StructuralRole.Checkbox,
      structuralRole("androidx.appcompat.widget.AppCompatRadioButton"),
    )
    assertEquals(
      structuralRole("android.widget.RadioButton"),
      structuralRole("android.widget.CheckBox"),
    )
  }

  /**
   * Custom Android View subclasses (and iOS structural views like `UIStackView`) fold into
   * [StructuralRole.Container] via the `*View` suffix catch-all, mirroring the iOS runner's custom
   * `.other -> UIView -> Container`, so a bespoke container subtree is not disjoint (issue #4872
   * review).
   */
  @Test
  fun `custom View subclasses map to Container`() {
    assertEquals(StructuralRole.Container, structuralRole("com.example.ProfileView"))
    assertEquals(StructuralRole.Container, structuralRole("UIStackView"))
    assertEquals(structuralRole("com.example.ProfileView"), structuralRole("UIView"))
    // The specific *View families are still matched first, not swallowed by the catch-all.
    assertEquals(StructuralRole.Text, structuralRole("com.example.BannerTextView"))
    assertEquals(StructuralRole.Image, structuralRole("com.example.AvatarImageView"))
  }

  @Test
  fun `unknown classes fall back to Other`() {
    assertEquals(StructuralRole.Other, structuralRole("com.example.CustomThing"))
    assertEquals(StructuralRole.Other, structuralRole(""))
  }
}
