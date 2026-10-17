#if DEBUG && !os(watchOS)
    import Foundation

    struct SdkSimulatorIdentity: Sendable {
        let udid: String?

        init(environment: [String: String] = ProcessInfo.processInfo.environment) {
            udid = environment["SIMULATOR_UDID"]
        }
    }
#endif
