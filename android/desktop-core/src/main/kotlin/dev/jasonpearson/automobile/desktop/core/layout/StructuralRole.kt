package dev.jasonpearson.automobile.desktop.core.layout

/**
 * A cross-platform, structural role for a UI node, abstracting away the platform-specific
 * `className`. The role captures *what kind of thing* a node is (a button, a text label, a
 * scrollable list, …) so an Android and an iOS rendering of the same screen can be diffed by role
 * instead of by raw class (issue #4872).
 *
 * The set is deliberately coarse — it covers the widget families a two-device compare cares about
 * and folds everything unrecognised into [Other]. Grow it when a real screen needs a finer role,
 * not ahead of need.
 */
enum class StructuralRole {
  Container,
  Text,
  TextField,
  Button,
  Image,
  List,
  ListItem,
  Checkbox,
  Switch,
  Toolbar,
  ScrollView,
  WebView,
  Other,
}

/**
 * Map a platform-specific view `className` to its cross-platform [StructuralRole].
 *
 * Recognises both Android class names (`android.widget.*`, `androidx.*`, Compose, custom
 * `*View`/`*Layout` classes) and iOS XCUITest element types (`XCUIElementType*`). Matching is by
 * substring so vendor-prefixed or `Compat`/`Material` variants (e.g. `SwitchCompat`,
 * `MaterialButton`, `AppCompatImageView`) fall into the right role without an exhaustive table.
 *
 * Order matters: more specific families are tested before broader ones. In particular toggles and
 * checkboxes are matched before [Button] because Android's `ToggleButton`/`CompoundButton` contain
 * the substring `Button`, and editable text is matched before static [Text] because iOS's
 * `XCUIElementTypeTextView` (an editable field) contains `TextView` (Android's static label).
 * Unrecognised classes map to [Other].
 */
fun structuralRole(className: String): StructuralRole =
  when {
    // Editable text entry. iOS TextView is an editable multiline field, so it belongs here rather
    // than with the static Text below (Android's TextView, matched later, is a static label).
    className.contains("EditText") ||
      className.contains("XCUIElementTypeTextField") ||
      className.contains("XCUIElementTypeSecureTextField") ||
      className.contains("XCUIElementTypeSearchField") ||
      className.contains("XCUIElementTypeTextView") -> StructuralRole.TextField
    // Checkboxes and toggles/switches — before Button, since ToggleButton/CompoundButton contain
    // the "Button" substring.
    className.contains("CheckBox") || className.contains("XCUIElementTypeCheckBox") ->
      StructuralRole.Checkbox
    className.contains("Switch") ||
      className.contains("ToggleButton") ||
      className.contains("XCUIElementTypeSwitch") ||
      className.contains("XCUIElementTypeToggle") -> StructuralRole.Switch
    // Buttons: Android Button/ImageButton/MaterialButton, iOS Button.
    className.contains("Button") || className.contains("XCUIElementTypeButton") ->
      StructuralRole.Button
    // Static text labels.
    className.contains("TextView") || className.contains("XCUIElementTypeStaticText") ->
      StructuralRole.Text
    // Images.
    className.contains("ImageView") || className.contains("XCUIElementTypeImage") ->
      StructuralRole.Image
    // List / collection containers.
    className.contains("RecyclerView") ||
      className.contains("ListView") ||
      className.contains("GridView") ||
      className.contains("XCUIElementTypeTable") ||
      className.contains("XCUIElementTypeCollectionView") -> StructuralRole.List
    // A single row/cell within a list.
    className.contains("XCUIElementTypeCell") -> StructuralRole.ListItem
    // Top/bottom chrome: toolbars, action/nav bars, tab bars.
    className.contains("Toolbar") ||
      className.contains("ActionBar") ||
      className.contains("XCUIElementTypeNavigationBar") ||
      className.contains("XCUIElementTypeToolbar") ||
      className.contains("XCUIElementTypeTabBar") -> StructuralRole.Toolbar
    // Scroll containers (Android ScrollView/HorizontalScrollView/NestedScrollView, iOS ScrollView).
    className.contains("ScrollView") || className.contains("XCUIElementTypeScrollView") ->
      StructuralRole.ScrollView
    // Web content.
    className.contains("WebView") || className.contains("XCUIElementTypeWebView") ->
      StructuralRole.WebView
    // Generic containers: layouts, view groups, Compose host, and iOS structural wrappers.
    className.contains("Layout") ||
      className.contains("ViewGroup") ||
      className.contains("ComposeView") ||
      className.contains("XCUIElementTypeApplication") ||
      className.contains("XCUIElementTypeWindow") ||
      className.contains("XCUIElementTypeGroup") ||
      className.contains("XCUIElementTypeOther") ||
      className == MULTI_WINDOW_ROOT_CLASS_NAME -> StructuralRole.Container
    else -> StructuralRole.Other
  }
