package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import dev.jasonpearson.automobile.desktop.domain.UIElementInfo
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class LayoutInspectorDashboardUiTest {

  private val sampleElement =
      UIElementInfo(
          id = "btn_login",
          className = "android.widget.Button",
          resourceId = "com.app:id/btn_login",
          text = "Sign In",
          contentDescription = "Login button",
          bounds = ElementBounds(100, 200, 400, 280),
          isClickable = true,
          isEnabled = true,
          isFocused = false,
          isSelected = false,
          isScrollable = false,
          isCheckable = false,
          isChecked = false,
          depth = 2,
          children = emptyList(),
      )

  private val sampleElementNoText =
      UIElementInfo(
          id = "img_avatar",
          className = "android.widget.ImageView",
          resourceId = "com.app:id/avatar",
          text = null,
          contentDescription = "User avatar",
          bounds = ElementBounds(50, 50, 150, 150),
          isClickable = true,
          isEnabled = true,
          isFocused = false,
          isSelected = true,
          isScrollable = false,
          isCheckable = false,
          isChecked = false,
          depth = 1,
          children = emptyList(),
      )

  // -- PropertyInspectorPanel tests --

  @Test
  fun `shows no element selected when null`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = null)
      }
    }
    onNodeWithText("No element selected").assertIsDisplayed()
    onNodeWithText("Click on the screen or tree to select").assertIsDisplayed()
  }

  @Test
  fun `shows element class name`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElement)
      }
    }
    onNodeWithText("Button").assertIsDisplayed()
    onNodeWithText("android.widget.Button").assertIsDisplayed()
  }

  @Test
  fun `shows element resource id`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElement)
      }
    }
    onNodeWithText("com.app:id/btn_login").assertIsDisplayed()
  }

  @Test
  fun `shows element content description`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElement)
      }
    }
    onNodeWithText("Login button").assertIsDisplayed()
  }

  @Test
  fun `shows element bounds`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElement)
      }
    }
    onNodeWithText("100, 200").assertIsDisplayed()
    onNodeWithText("300 x 80").assertIsDisplayed()
  }

  @Test
  fun `shows identity section header`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElement)
      }
    }
    onNodeWithText("Identity").assertIsDisplayed()
  }

  @Test
  fun `shows bounds section header`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElement)
      }
    }
    onNodeWithText("Bounds").assertIsDisplayed()
  }

  @Test
  fun `shows state section header`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElement)
      }
    }
    onNodeWithText("State").assertIsDisplayed()
  }

  @Test
  fun `shows text content when present`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElement)
      }
    }
    onNodeWithText("Content").assertIsDisplayed()
    onNodeWithText("Sign In").assertIsDisplayed()
  }

  @Test
  fun `hides content section when text is null`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElementNoText)
      }
    }
    // Content section header should not appear
    onNodeWithText("Content").assertDoesNotExist()
  }

  @Test
  fun `shows clickable state`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PropertyInspectorPanel(element = sampleElement)
      }
    }
    onNodeWithText("Clickable").assertIsDisplayed()
    onNodeWithText("Enabled").assertIsDisplayed()
  }

  // -- BreadcrumbBar tests --

  @Test
  fun `breadcrumb bar shows nothing when no selection`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        BreadcrumbBar(
            selectedElementId = null,
            parentMap = emptyMap(),
            elementMap = emptyMap(),
            onElementSelected = {},
        )
      }
    }
    // BreadcrumbBar returns early when selectedElementId is null, so nothing to assert
    // Just verify it doesn't crash
  }

  @Test
  fun `breadcrumb bar shows path for selected element`() = runComposeUiTest {
    val root =
        UIElementInfo(
            id = "root",
            className = "android.widget.FrameLayout",
            resourceId = null,
            text = null,
            contentDescription = null,
            bounds = ElementBounds(0, 0, 1080, 2340),
            isClickable = false,
            isEnabled = true,
            isFocused = false,
            isSelected = false,
            isScrollable = false,
            isCheckable = false,
            isChecked = false,
            depth = 0,
            children = emptyList(),
        )
    val child =
        UIElementInfo(
            id = "child1",
            className = "android.widget.Button",
            resourceId = "com.app:id/btn",
            text = "Click",
            contentDescription = null,
            bounds = ElementBounds(10, 10, 200, 60),
            isClickable = true,
            isEnabled = true,
            isFocused = false,
            isSelected = false,
            isScrollable = false,
            isCheckable = false,
            isChecked = false,
            depth = 1,
            children = emptyList(),
        )

    val parentMap = mapOf("child1" to "root")
    val elementMap = mapOf("root" to root, "child1" to child)

    setContent {
      MaterialTheme {
        BreadcrumbBar(
            selectedElementId = "child1",
            parentMap = parentMap,
            elementMap = elementMap,
            onElementSelected = {},
        )
      }
    }
    onNodeWithText("FrameLayout").assertIsDisplayed()
    onNodeWithText("Button#btn").assertIsDisplayed()
  }
}
