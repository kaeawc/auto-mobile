package dev.jasonpearson.automobile.desktop.core.daemon

internal class McpHttpInputOperations(private val transport: McpHttpTransport) :
  AutoMobileInputOperations {
  private val json = transport.json
  private val resources = McpHttpResources(transport)
  private val transportName = "MCP HTTP"

  override fun inputTap(input: TapInput): InputActionResult =
    with(input) {
      unsupportedInputAction(transportName, "input/tap")
    }

  override fun inputSwipe(input: SwipeInput): InputActionResult =
    with(input) {
      unsupportedInputAction(transportName, "input/swipe")
    }

  override fun inputPressButton(
    button: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult = unsupportedInputAction(transportName, "input/pressButton")

  override fun inputTypeText(input: TextInput): InputActionResult =
    with(input) {
      unsupportedInputAction(transportName, "input/typeText")
    }

  override fun inputKey(
    key: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult = unsupportedInputAction(transportName, "input/key")
}
