package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context

/** Device preferences are read afresh after a service configuration change. */
@InternalAutoMobilePrototypeApi
interface PrototypeDeviceLocale {
  val locales: List<String>
}

@InternalAutoMobilePrototypeApi
object NoPrototypeDeviceLocale : PrototypeDeviceLocale {
  override val locales: List<String> = emptyList()
}

@InternalAutoMobilePrototypeApi
class AndroidPrototypeDeviceLocale(private val context: Context) : PrototypeDeviceLocale {
  override val locales: List<String>
    get() {
      val list = context.resources.configuration.locales
      return (0 until list.size()).map { list[it].toLanguageTag() }
    }
}
