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
 * `*View`/`*Layout` classes) and the iOS vocabulary. On iOS the class the runner reports is the
 * UIKit class name that `ElementLocator.mapElementType` emits (`XCUIApplication`, `UIWindow`,
 * `UIButton`, `UILabel`, `UITextField`, `UITableView`, `UITableViewCell`, `WKWebView`, `UIView`,
 * …), which `CtrlProxyHierarchy.convertNode` forwards unchanged — so the UIKit names are the ones
 * that must match on live trees. The XCUITest-native `XCUIElementType*` names are also recognised
 * defensively (they are what a raw XCUITest snapshot uses). Matching is by substring so
 * vendor-prefixed or `Compat`/`Material` variants (e.g. `SwitchCompat`, `MaterialButton`,
 * `AppCompatImageView`) fall into the right role without an exhaustive table.
 *
 * Order matters: more specific families are tested before broader ones. In particular toggles and
 * checkboxes are matched before [Button] because Android's `ToggleButton`/`CompoundButton` contain
 * the substring `Button`; a list cell is matched before [List] because `UITableViewCell` contains
 * `TableView`; and iOS's editable `UITextView` is matched before static [Text] because it contains
 * `TextView` (Android's static label). Unrecognised classes map to [Other].
 */
fun structuralRole(className: String): StructuralRole =
  when {
    // Editable text entry. Android EditText; iOS UITextField/UISecureTextField/UISearchBar and the
    // editable UITextView (matched explicitly here — before the static Text branch — so it is not
    // mistaken for Android's static TextView); plus the XCUITest-native equivalents.
    className.contains("EditText") ||
      className.contains("TextField") ||
      className.contains("SearchField") ||
      className.contains("SearchBar") ||
      className.contains("UITextView") ||
      className.contains("XCUIElementTypeTextView") -> StructuralRole.TextField
    // Checkboxes and toggles/switches — before Button, since ToggleButton/CompoundButton contain
    // the "Button" substring.
    className.contains("CheckBox") || className.contains("XCUIElementTypeCheckBox") ->
      StructuralRole.Checkbox
    // "Switch" also matches iOS UISwitch and XCUIElementTypeSwitch.
    className.contains("Switch") ||
      className.contains("ToggleButton") ||
      className.contains("XCUIElementTypeToggle") -> StructuralRole.Switch
    // Buttons: Android Button/ImageButton/MaterialButton, iOS UIButton / XCUIElementTypeButton.
    className.contains("Button") || className.contains("XCUIElementTypeButton") ->
      StructuralRole.Button
    // Static text labels: Android TextView, iOS UILabel / XCUIElementTypeStaticText.
    className.contains("TextView") ||
      className.contains("UILabel") ||
      className.contains("XCUIElementTypeStaticText") -> StructuralRole.Text
    // Images: Android ImageView, iOS UIImageView / XCUIElementTypeImage.
    className.contains("ImageView") || className.contains("XCUIElementTypeImage") ->
      StructuralRole.Image
    // A single row/cell within a list — before List, since UITableViewCell contains "TableView".
    // Catches iOS UITableViewCell/UICollectionViewCell and XCUIElementTypeCell.
    className.contains("Cell") -> StructuralRole.ListItem
    // List / collection containers: Android RecyclerView/ListView/GridView, iOS UITableView/
    // UICollectionView, and the XCUITest-native XCUIElementTypeTable.
    className.contains("RecyclerView") ||
      className.contains("ListView") ||
      className.contains("GridView") ||
      className.contains("TableView") ||
      className.contains("CollectionView") ||
      className.contains("XCUIElementTypeTable") -> StructuralRole.List
    // Top/bottom chrome: toolbars, action/nav bars, tab bars. Android Toolbar/ActionBar; iOS
    // UIToolbar/UINavigationBar/UITabBar and the XCUITest-native equivalents (all covered by the
    // "Toolbar"/"NavigationBar"/"TabBar" substrings).
    className.contains("Toolbar") ||
      className.contains("ActionBar") ||
      className.contains("NavigationBar") ||
      className.contains("TabBar") -> StructuralRole.Toolbar
    // Scroll containers: Android ScrollView/NestedScrollView, iOS UIScrollView, XCUITest
    // ScrollView.
    className.contains("ScrollView") || className.contains("XCUIElementTypeScrollView") ->
      StructuralRole.ScrollView
    // Web content: Android WebView, iOS WKWebView / XCUIElementTypeWebView.
    className.contains("WebView") || className.contains("XCUIElementTypeWebView") ->
      StructuralRole.WebView
    // Generic containers: Android layouts/view groups/Compose host; iOS structural wrappers. The
    // runner emits XCUIApplication + UIWindow for the mandatory root and window and UIView for any
    // non-semantic wrapper, so these must land in the same role as Android's FrameLayout/ViewGroup
    // or the two roots would never pair. The XCUIElementType* names are the XCUITest-native forms.
    className.contains("Layout") ||
      className.contains("ViewGroup") ||
      className.contains("ComposeView") ||
      className.contains("XCUIApplication") ||
      className.contains("UIWindow") ||
      className.contains("UIView") ||
      className.contains("XCUIElementTypeApplication") ||
      className.contains("XCUIElementTypeWindow") ||
      className.contains("XCUIElementTypeGroup") ||
      className.contains("XCUIElementTypeOther") ||
      className == MULTI_WINDOW_ROOT_CLASS_NAME -> StructuralRole.Container
    else -> StructuralRole.Other
  }
