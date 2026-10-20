package dev.jasonpearson.automobile.discover.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import coil3.compose.AsyncImage
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentCard
import kotlin.math.roundToInt

data class GridImage(val id: String, val imageUrl: String, val description: String)

internal val ReorderableGridSpacing = 8.dp

@Composable
fun ReorderableGrid(images: List<GridImage>, onReorder: (Int, Int) -> Unit) {
  val dragState = remember { GridReorderDragState() }
  val gridState = rememberLazyGridState()
  val density = LocalDensity.current
  val columns = 3

  BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
    val contentHeight =
      with(density) {
        calculateGridHeightPx(
            constraints.maxWidth,
            images.size,
            columns,
            ReorderableGridSpacing.roundToPx(),
          )
          .toDp()
      }

    ReorderableImageCells(
      images,
      onReorder,
      dragState,
      gridState,
      Modifier.fillMaxWidth().height(contentHeight),
    )
  }
}

data class GridDragCallbacks(
  val onStart: () -> Unit,
  val onEnd: () -> Unit,
  val onMove: (Offset) -> Unit,
  val onCancel: () -> Unit = {},
)

@Composable
fun GridImageItem(
  image: GridImage,
  isDragged: Boolean,
  isDropTarget: Boolean,
  callbacks: GridDragCallbacks,
  modifier: Modifier = Modifier,
) {
  AutoMobileContentCard(
    modifier = gridImageModifier(image.id, isDragged, isDropTarget, callbacks, modifier),
    elevation = CardDefaults.cardElevation(defaultElevation = if (isDragged) 16.dp else 4.dp),
    colors =
      CardDefaults.cardColors(
        containerColor =
          when {
            isDragged -> MaterialTheme.colorScheme.primaryContainer
            isDropTarget -> MaterialTheme.colorScheme.secondaryContainer
            else -> MaterialTheme.colorScheme.surface
          },
      ),
  ) {
    GridImageContent(image, isDragged, isDropTarget)
  }
}

@Preview(showBackground = true)
@Composable
fun ReorderableGridPreview() {
  val sampleImages =
    listOf(
      GridImage("1", "https://picsum.photos/200/200?random=1", "Sample image 1"),
      GridImage("2", "https://picsum.photos/200/200?random=2", "Sample image 2"),
      GridImage("3", "https://picsum.photos/200/200?random=3", "Sample image 3"),
      GridImage("4", "https://picsum.photos/200/200?random=4", "Sample image 4"),
      GridImage("5", "https://picsum.photos/200/200?random=5", "Sample image 5"),
      GridImage("6", "https://picsum.photos/200/200?random=6", "Sample image 6"),
    )

  MaterialTheme {
    ReorderableGrid(
      images = sampleImages,
      onReorder = { fromIndex, toIndex ->
        // Preview doesn't handle reordering
      },
    )
  }
}

private class GridReorderDragState {
  var draggedItemId by mutableStateOf<String?>(null)
  var draggedOverIndex by mutableIntStateOf(-1)

  fun callbacksFor(
    image: GridImage,
    images: List<GridImage>,
    onReorder: (Int, Int) -> Unit,
    gridState: LazyGridState,
  ): GridDragCallbacks =
    GridDragCallbacks(
      onStart = {
        draggedItemId = image.id
        draggedOverIndex = -1
      },
      onEnd = {
        val draggedIndex = images.indexOfFirst { it.id == draggedItemId }
        if (
          draggedIndex != -1 &&
            draggedOverIndex in images.indices &&
            draggedIndex != draggedOverIndex
        ) {
          onReorder(draggedIndex, draggedOverIndex)
        }
        draggedItemId = null
        draggedOverIndex = -1
      },
      onMove = { offset ->
        move(images, gridState, offset)
      },
      onCancel = {
        draggedItemId = null
        draggedOverIndex = -1
      },
    )

  private fun move(images: List<GridImage>, gridState: LazyGridState, offset: Offset) {
    val activeId = draggedItemId
    if (activeId != null) {
      val cells =
        gridState.layoutInfo.visibleItemsInfo.map { item ->
          GridDropCell(
            item.index,
            Rect(
              item.offset.x.toFloat(),
              item.offset.y.toFloat(),
              (item.offset.x + item.size.width).toFloat(),
              (item.offset.y + item.size.height).toFloat(),
            ),
          )
        }
      // Include the source cell: returning to it must clear a previous drop target.
      draggedOverIndex = calculateGridDropTarget(images.map { it.id }, activeId, cells, offset)
    }
  }
}

@Composable
private fun ReorderableImageCells(
  images: List<GridImage>,
  onReorder: (Int, Int) -> Unit,
  dragState: GridReorderDragState,
  gridState: LazyGridState,
  modifier: Modifier,
) {
  LazyVerticalGrid(
    columns = GridCells.Fixed(3),
    state = gridState,
    userScrollEnabled = false,
    contentPadding = PaddingValues(ReorderableGridSpacing),
    horizontalArrangement = Arrangement.spacedBy(ReorderableGridSpacing),
    verticalArrangement = Arrangement.spacedBy(ReorderableGridSpacing),
    modifier = modifier,
  ) {
    itemsIndexed(images, key = { _, image -> image.id }) { index, image ->
      val isBeingDragged = dragState.draggedItemId == image.id
      val isDropTarget = dragState.draggedOverIndex == index && !isBeingDragged

      GridImageItem(
        image = image,
        isDragged = isBeingDragged,
        isDropTarget = isDropTarget,
        callbacks = dragState.callbacksFor(image, images, onReorder, gridState),
        modifier = Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null),
      )
    }
  }
}

@Composable
private fun GridImageContent(image: GridImage, isDragged: Boolean, isDropTarget: Boolean) {
  Box(modifier = Modifier.fillMaxSize()) {
    AsyncImage(
      model = image.imageUrl,
      contentDescription = image.description,
      modifier = Modifier.fillMaxSize(),
      contentScale = ContentScale.Crop,
    )

    if (isDragged) {
      Box(
        modifier =
          Modifier.fillMaxSize().background(MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)),
      )
    }

    if (isDropTarget && !isDragged) {
      Box(
        modifier =
          Modifier.fillMaxSize().background(MaterialTheme.colorScheme.secondary.copy(alpha = 0.3f)),
      )
    }

    Icon(
      imageVector = Icons.Filled.Star,
      contentDescription = "Drag handle",
      modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).size(16.dp),
      tint = Color.White,
    )
  }
}

private class GridItemDragState {
  var offset by mutableStateOf(Offset.Zero)
}

@Composable
private fun gridImageModifier(
  imageId: String,
  isDragged: Boolean,
  isDropTarget: Boolean,
  callbacks: GridDragCallbacks,
  modifier: Modifier,
): Modifier {
  val drag = remember { GridItemDragState() }
  val scale = remember { Animatable(1f) }

  LaunchedEffect(isDragged) { scale.animateTo(if (isDragged) 1.15f else 1f) }

  LaunchedEffect(isDropTarget, isDragged) {
    if (!isDragged) {
      drag.offset = Offset.Zero
    }
  }

  return modifier
    .aspectRatio(1f)
    .offset {
      if (isDragged) IntOffset(drag.offset.x.roundToInt(), drag.offset.y.roundToInt())
      else IntOffset.Zero
    }
    .scale(scale.value)
    .zIndex(if (isDragged) 1f else 0f)
    .shadow(if (isDragged) 16.dp else 4.dp, RoundedCornerShape(8.dp))
    .gridDragGesture(imageId, drag, callbacks)
}

@Composable
private fun Modifier.gridDragGesture(
  imageId: String,
  drag: GridItemDragState,
  callbacks: GridDragCallbacks,
): Modifier {
  val currentOnDragStart by rememberUpdatedState(callbacks.onStart)
  val currentOnDragEnd by rememberUpdatedState(callbacks.onEnd)
  val currentOnDragMove by rememberUpdatedState(callbacks.onMove)
  val currentOnDragCancel by rememberUpdatedState(callbacks.onCancel)

  return pointerInput(imageId) {
    detectDragGestures(
      onDragStart = { _ ->
        // Start drag immediately on touch
        currentOnDragStart()
        drag.offset = Offset.Zero
      },
      onDragEnd = {
        currentOnDragEnd()
        drag.offset = Offset.Zero
      },
      onDragCancel = {
        currentOnDragCancel()
        drag.offset = Offset.Zero
      },
    ) { _, dragAmount ->
      drag.offset += dragAmount
      currentOnDragMove(drag.offset)
    }
  }
}
