package dev.jasonpearson.automobile.wearfixture.tile

import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture

/** Serves [FixtureTile]; the layout is fixed, so every request gets the same tile. */
class FixtureTileService : TileService() {
  override fun onTileRequest(
    requestParams: RequestBuilders.TileRequest,
  ): ListenableFuture<TileBuilders.Tile> = immediate(FixtureTile.tile(packageName))

  override fun onTileResourcesRequest(
    requestParams: RequestBuilders.ResourcesRequest,
  ): ListenableFuture<ResourceBuilders.Resources> = immediate(FixtureTile.resources())

  private fun <T : Any> immediate(value: T): ListenableFuture<T> =
    CallbackToFutureAdapter.getFuture { completer ->
      completer.set(value)
      "FixtureTileService"
    }
}
