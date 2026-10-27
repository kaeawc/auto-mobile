package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun ElementProperties(element: UIElementInfo) {
  IdentityProperties(element)
  BoundsProperties(element)
  StateProperties(element)
  SdkProperties(element)
  TextProperties(element)
  HierarchyProperties(element)
}

@Composable
private fun IdentityProperties(element: UIElementInfo) {
  val colors = SharedTheme.globalColors
  // Identity section
  PropertySection(title = "Identity") {
    PropertyRow("Class", getSimpleClassName(element.className))
    PropertyRow("Full Class", element.className, isSecondary = true)
    element.resourceId?.let { PropertyRow("Resource ID", it) }
    element.contentDescription?.let { PropertyRow("Content Desc", it) }
    PropertyRow("Element ID", element.id, isSecondary = true)
    Spacer(Modifier.height(4.dp))
    CopySelectorButton(element)
  }

  Spacer(Modifier.height(16.dp))
}

@Composable
private fun BoundsProperties(element: UIElementInfo) {
  val colors = SharedTheme.globalColors
  // Bounds section
  PropertySection(title = "Bounds") {
    PropertyRow("Position", "${element.bounds.left}, ${element.bounds.top}")
    PropertyRow("Size", "${element.bounds.width} x ${element.bounds.height}")
    PropertyRow("Right", "${element.bounds.right}", isSecondary = true)
    PropertyRow("Bottom", "${element.bounds.bottom}", isSecondary = true)
    PropertyRow(
      "Center",
      "${element.bounds.centerX}, ${element.bounds.centerY}",
      isSecondary = true,
    )
  }

  Spacer(Modifier.height(16.dp))
}

@Composable
private fun StateProperties(element: UIElementInfo) {
  val colors = SharedTheme.globalColors
  // State section
  PropertySection(title = "State") {
    StateCheckbox("Clickable", element.isClickable)
    StateCheckbox("Enabled", element.isEnabled)
    StateCheckbox("Focused", element.isFocused)
    StateCheckbox("Selected", element.isSelected)
    StateCheckbox("Scrollable", element.isScrollable)
    StateCheckbox("Checkable", element.isCheckable)
    if (element.isCheckable) {
      StateCheckbox("Checked", element.isChecked)
    }
  }
}

@Composable
private fun SdkProperties(element: UIElementInfo) {
  val colors = SharedTheme.globalColors
  // SDK extras section (if present)
  if (element.extras.isNotEmpty()) {
    Spacer(Modifier.height(16.dp))
    PropertySection(title = "SDK Properties") {
      for ((key, value) in element.extras.toSortedMap()) {
        val label = key.removePrefix("sdk.")
        PropertyRow(label, value)
      }
    }
  }
}

@Composable
private fun TextProperties(element: UIElementInfo) {
  val colors = SharedTheme.globalColors
  // Text content section (if present)
  if (!element.text.isNullOrEmpty()) {
    Spacer(Modifier.height(16.dp))
    PropertySection(title = "Content") {
      Column {
        Text(
          "Text",
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
        )
        Box(
          modifier =
            Modifier.fillMaxWidth()
              .padding(top = 4.dp)
              .background(
                colors.text.normal.copy(alpha = 0.05f),
                RoundedCornerShape(4.dp),
              )
              .padding(8.dp),
        ) {
          Text(
            requireNotNull(element.text) { "Text property requires element text" },
            fontSize = 11.sp,
            color = colors.text.normal,
          )
        }
      }
    }
  }
}

@Composable
private fun HierarchyProperties(element: UIElementInfo) {
  val colors = SharedTheme.globalColors
  // Hierarchy info
  Spacer(Modifier.height(16.dp))
  PropertySection(title = "Hierarchy") {
    PropertyRow("Depth", "${element.depth}")
    PropertyRow("Children", "${element.children.size}")
  }
}

private fun getSimpleClassName(fullName: String): String {
  return fullName.substringAfterLast(".")
}
