package dev.jasonpearson.automobile.ctrlproxy.prototype

internal class FakePrototypeScreenShapeSource : PrototypeScreenShapeSource {
  val shapes = mutableMapOf<Int, Boolean>()
  val reads = mutableListOf<Int>()

  override fun screenRound(displayId: Int): Boolean? {
    reads += displayId
    return shapes[displayId]
  }
}
