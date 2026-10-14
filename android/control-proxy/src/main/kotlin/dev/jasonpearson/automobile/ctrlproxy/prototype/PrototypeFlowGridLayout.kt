package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.ParentDataModifier
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeGridColumns
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import kotlin.math.floor

/** Inputs share a unit (pixels during layout, dp in callers' tests). */
internal fun prototypeGridColumnCount(
  columns: PrototypeGridColumns,
  available: Double,
  gap: Double,
): Int =
  when (columns) {
    is PrototypeGridColumns.Fixed -> columns.count.coerceAtLeast(1)
    is PrototypeGridColumns.Adaptive ->
      floor((available + gap) / (columns.minWidth + gap)).toInt().coerceAtLeast(1)
  }

internal data class PrototypeGridCell(val row: Int, val column: Int, val span: Int)

/** Row-major packing: a child that cannot fit the current row starts the next row. */
internal fun prototypeGridCells(columns: Int, spans: List<Int>): List<PrototypeGridCell> {
  require(columns > 0)
  var row = 0
  var column = 0
  return spans.map { requested ->
    val span = requested.coerceIn(1, columns)
    if (span > columns - column) {
      row++
      column = 0
    }
    PrototypeGridCell(row, column, span).also {
      column += span
      if (column == columns) {
        row++
        column = 0
      }
    }
  }
}

private data class PrototypeGridSpan(val span: Int) : ParentDataModifier {
  override fun Density.modifyParentData(parentData: Any?): Any = span
}

internal fun Modifier.prototypeGridSpan(span: Int): Modifier = then(PrototypeGridSpan(span))

/**
 * Intentionally leaves the visual maxLines cap unset: FlowRow's cap removes overflow children from
 * the hierarchy. Until we have a clipping layout, every line remains drawn and selectable.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PrototypeFlowLayout(
  modifier: Modifier,
  style: PrototypeStyle,
  content: @Composable () -> Unit,
) {
  FlowRow(
    modifier = modifier,
    horizontalArrangement = Arrangement.spacedBy((style.spacing ?: 0.0).toFloat().dp),
    verticalArrangement = Arrangement.spacedBy((style.runSpacing ?: 0.0).toFloat().dp),
  ) {
    content()
  }
}

/** Eager, non-scrolling grid. Each child is measured and placed exactly once. */
@Composable
internal fun PrototypeGridLayout(
  modifier: Modifier,
  columns: PrototypeGridColumns,
  style: PrototypeStyle,
  content: @Composable () -> Unit,
) {
  Layout(content = content, modifier = modifier) { measurables, constraints ->
    val gap = (style.spacing ?: 0.0) * density
    val rowGap = (style.runSpacing ?: style.spacing ?: 0.0) * density
    val pixelColumns =
      when (columns) {
        is PrototypeGridColumns.Fixed -> columns
        is PrototypeGridColumns.Adaptive ->
          PrototypeGridColumns.Adaptive(columns.minWidth * density)
      }
    // With no available width (e.g. a horizontal scroll parent), adaptive uses one column and
    // fixed grids derive equal slots from the measured natural widths, without intrinsic queries.
    val count =
      if (constraints.hasBoundedWidth)
        prototypeGridColumnCount(pixelColumns, constraints.maxWidth.toDouble(), gap)
      else (columns as? PrototypeGridColumns.Fixed)?.count?.coerceAtLeast(1) ?: 1
    val cells = prototypeGridCells(count, measurables.map { (it.parentData as? Int) ?: 1 })
    val boundedCellWidth =
      if (constraints.hasBoundedWidth)
        ((constraints.maxWidth.toDouble() - gap * (count - 1)) / count).coerceAtLeast(0.0)
      else 0.0
    val placeables = measurables.mapIndexed { index, measurable ->
      val width = (boundedCellWidth * cells[index].span + gap * (cells[index].span - 1)).toInt()
      val childConstraints =
        if (constraints.hasBoundedWidth)
          Constraints(
            minWidth = width.coerceIn(0, constraints.maxWidth),
            maxWidth = width.coerceIn(0, constraints.maxWidth),
          )
        else Constraints()
      measurable.measure(childConstraints)
    }
    val cellWidth =
      if (constraints.hasBoundedWidth) boundedCellWidth
      else
        placeables.indices.maxOfOrNull { index ->
          ((placeables[index].width - gap * (cells[index].span - 1)) / cells[index].span)
            .coerceAtLeast(0.0)
        } ?: 0.0
    val rowHeights = IntArray(cells.lastOrNull()?.row?.plus(1) ?: 0)
    placeables.forEachIndexed { index, child ->
      rowHeights[cells[index].row] = maxOf(rowHeights[cells[index].row], child.height)
    }
    val rowOffsets = DoubleArray(rowHeights.size)
    for (row in 1 until rowHeights.size) {
      rowOffsets[row] = rowOffsets[row - 1] + rowHeights[row - 1] + rowGap
    }
    val width =
      if (constraints.hasBoundedWidth) constraints.maxWidth
      else constraints.constrainWidth((cellWidth * count + gap * (count - 1)).toInt())
    val height =
      constraints.constrainHeight(
        if (rowHeights.isEmpty()) 0 else (rowOffsets.last() + rowHeights.last()).toInt(),
      )
    layout(width, height) {
      placeables.forEachIndexed { index, child ->
        val cell = cells[index]
        child.placeRelative((cell.column * (cellWidth + gap)).toInt(), rowOffsets[cell.row].toInt())
      }
    }
  }
}
