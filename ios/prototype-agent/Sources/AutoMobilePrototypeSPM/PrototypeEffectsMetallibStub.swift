/// The root `AutoMobilePrototype` SwiftPM target compiles every directory under `Sources`, but
/// SwiftPM cannot build `Shaders/PrototypeEffects.metal`. This empty stand-in satisfies the generated
/// type the agent sources reference, so shader-backed effects are simply not drawn in a library
/// consumer (#15130). The agent and viewer build scripts scan only `AutoMobilePrototypeAgentCore` and
/// `AutoMobilePrototypeAgent` and compile the generated `PrototypeEffectsMetallib.swift` instead, so
/// this file never collides with it.
enum PrototypeEffectsMetallib {
    static let base64 = ""
}
