package dev.jasonpearson.automobile.desktop.core.timeline

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun TimelineToolbar(
    state: TimelineState,
    spanCount: Int,
    onFitAll: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val colors = SharedTheme.globalColors
    val timeFormat = remember { SimpleDateFormat("HH:mm:ss", Locale.US) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(24.dp)
            .background(colors.panelBackground)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Timeline", fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
        Spacer(Modifier.width(8.dp))
        Text("$spanCount events", fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.4f))
        Spacer(Modifier.weight(1f))
        Text(
            "${timeFormat.format(Date(state.visibleStartMs))} — ${timeFormat.format(Date(state.visibleEndMs))}",
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
        )
        Spacer(Modifier.width(8.dp))
        ToolbarButton(label = "-", onClick = { state.zoomOut() })
        Spacer(Modifier.width(2.dp))
        ToolbarButton(label = "+", onClick = { state.zoomIn() })
        Spacer(Modifier.width(2.dp))
        ToolbarButton(label = "Fit", onClick = onFitAll)
    }
}

@Composable
private fun ToolbarButton(
    label: String,
    onClick: () -> Unit,
) {
    val colors = SharedTheme.globalColors
    val interactionSource = remember { MutableInteractionSource() }
    val isHovered by interactionSource.collectIsHoveredAsState()

    val bgColor by animateColorAsState(
        targetValue = colors.text.normal.copy(alpha = if (isHovered) 0.10f else 0.05f),
        animationSpec = tween(durationMillis = 100),
        label = "toolbarBtnBg",
    )

    Text(
        text = label,
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
        modifier = Modifier
            .background(bgColor)
            .hoverable(interactionSource)
            .pointerHoverIcon(PointerIcon.Hand)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
