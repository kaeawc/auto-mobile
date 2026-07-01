package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Breadcrumb navigation bar showing the path from root to the selected element.
 *
 * Example: root > RecyclerView > LinearLayout > TextView
 *
 * Each segment is clickable and triggers [onElementSelected] with the corresponding ID. Uses the
 * pre-computed [parentMap] from [LayoutInspectorState] for O(depth) path lookup.
 */
@Composable
fun BreadcrumbBar(
    selectedElementId: String?,
    parentMap: Map<String, String>,
    elementMap: Map<String, UIElementInfo>,
    onElementSelected: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors

  if (selectedElementId == null) return

  // Build path from root to selected element — O(depth) via parentMap
  val path =
      remember(selectedElementId, parentMap) {
        getPathFromParentMap(parentMap, selectedElementId)
      }

  val scrollState = rememberScrollState()

  Row(
      modifier =
          modifier
              .fillMaxWidth()
              .background(colors.panelBackground)
              .horizontalScroll(scrollState)
              .padding(horizontal = 8.dp, vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    path.forEachIndexed { index, elementId ->
      val element = elementMap[elementId]
      val label = element?.let { getSimpleBreadcrumbLabel(it) } ?: elementId
      val isLast = index == path.lastIndex

      BreadcrumbSegment(
          label = label,
          isSelected = isLast,
          textColor = colors.text.normal,
          onClick = { onElementSelected(elementId) },
      )

      if (!isLast) {
        Text(
            text = " > ",
            fontSize = 9.sp,
            color = colors.text.normal.copy(alpha = 0.3f),
        )
      }
    }
  }
}

@Composable
private fun BreadcrumbSegment(
    label: String,
    isSelected: Boolean,
    textColor: Color,
    onClick: () -> Unit,
) {
  Box(
      modifier =
          Modifier.background(
                  if (isSelected) Color(0xFF2196F3).copy(alpha = 0.15f) else Color.Transparent,
                  RoundedCornerShape(3.dp),
              )
              .clickable(onClick = onClick)
              .pointerHoverIcon(PointerIcon.Hand)
              .padding(horizontal = 4.dp, vertical = 2.dp),
  ) {
    Text(
        text = label,
        fontSize = 10.sp,
        fontFamily = FontFamily.Monospace,
        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
        color = if (isSelected) Color(0xFF2196F3) else textColor.copy(alpha = 0.6f),
        maxLines = 1,
        softWrap = false,
    )
  }
}

private fun getSimpleBreadcrumbLabel(element: UIElementInfo): String {
  val simpleName = element.className.substringAfterLast(".")
  val resId = element.resourceId?.substringAfterLast("/")
  return if (!resId.isNullOrEmpty()) "$simpleName#$resId" else simpleName
}
