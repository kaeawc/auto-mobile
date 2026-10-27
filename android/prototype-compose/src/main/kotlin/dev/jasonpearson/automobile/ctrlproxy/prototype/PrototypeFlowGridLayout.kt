package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.ParentDataModifier
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
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

internal data class PrototypeFlowOffset(val x: Double, val y: Double)

internal data class PrototypeFlowPlacement(
  val children: List<PrototypeFlowOffset>,
  val width: Double,
  val height: Double,
)

/** Mirrors Swift's eager flow maths: the cap changes height, never child placement. */
internal fun prototypeFlowPlacement(
  sizes: List<Pair<Double, Double>>,
  available: Double?,
  spacing: Double,
  runSpacing: Double,
  maxLines: Int?,
): PrototypeFlowPlacement {
  val limit = available?.takeIf { it.isFinite() }?.coerceAtLeast(0.0) ?: Double.POSITIVE_INFINITY
  val gap = spacing.coerceAtLeast(0.0)
  val rowGap = runSpacing.coerceAtLeast(0.0)
  var line = 0
  var used = 0.0
  var occupied = false
  val lines = sizes.map { (width, _) ->
    if (occupied && used + gap + width > limit) {
      line++
      used = 0.0
      occupied = false
    }
    used += (if (occupied) gap else 0.0) + width
    occupied = true
    line
  }
  val heights = DoubleArray(lines.lastOrNull()?.plus(1) ?: 0)
  sizes.forEachIndexed { index, size ->
    heights[lines[index]] = maxOf(heights[lines[index]], size.second)
  }
  val offsets = DoubleArray(heights.size)
  for (row in 1 until heights.size) {
    offsets[row] = offsets[row - 1] + heights[row - 1] + rowGap
  }
  val cursors = DoubleArray(heights.size)
  val children = sizes.mapIndexed { index, size ->
    val row = lines[index]
    PrototypeFlowOffset(cursors[row], offsets[row]).also { cursors[row] += size.first + gap }
  }
  val visible = minOf(heights.size, (maxLines ?: heights.size).coerceAtLeast(1))
  return PrototypeFlowPlacement(
    children,
    children.indices.maxOfOrNull { children[it].x + sizes[it].first } ?: 0.0,
    if (visible == 0) 0.0 else offsets[visible - 1] + heights[visible - 1],
  )
}

/** Eager flow: measure and place every child, then clip overflow to the capped height. */
@Composable
internal fun PrototypeFlowLayout(
  modifier: Modifier,
  style: PrototypeStyle,
  maxLines: Int?,
  content: @Composable () -> Unit,
) {
  Layout(content = content, modifier = modifier.clipToBounds()) { measurables, constraints ->
    val childConstraints = Constraints(maxWidth = constraints.maxWidth)
    val placeables = measurables.map { it.measure(childConstraints) }
    val placement =
      prototypeFlowPlacement(
        placeables.map { it.width.toDouble() to it.height.toDouble() },
        if (constraints.hasBoundedWidth) constraints.maxWidth.toDouble() else null,
        (style.spacing ?: 0.0) * density,
        (style.runSpacing ?: 0.0) * density,
        maxLines,
      )
    layout(
      constraints.constrainWidth(placement.width.toInt()),
      constraints.constrainHeight(placement.height.toInt()),
    ) {
      placeables.forEachIndexed { index, child ->
        val offset = placement.children[index]
        child.placeRelative(offset.x.toInt(), offset.y.toInt())
      }
    }
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
