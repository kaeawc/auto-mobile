package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import okhttp3.OkHttpClient

/** The live overlay and saved viewer share one transport and one app-wide image cache/limiter. */
internal object PrototypeDeviceNetwork {
  val device =
    RetrofitPrototypeHttpClient(
      OkHttpClient(),
    )
  private var images: PrototypeRemoteImageLoader? = null

  @Synchronized
  fun images(context: Context): PrototypeRemoteImageLoader =
    images
      ?: CachedPrototypeRemoteImageLoader(
          device,
          FilePrototypeRemoteImageStore(context.cacheDir.resolve("prototype-remote-images")),
          BitmapPrototypeImageDecoder(),
        )
        .also { images = it }
}
