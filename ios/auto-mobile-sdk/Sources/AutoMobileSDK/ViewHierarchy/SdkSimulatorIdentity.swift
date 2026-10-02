#if DEBUG && !os(watchOS)
    import Foundation

    struct SdkSimulatorIdentity: Sendable {
        let udid: String?

        init(environment: [String: String] = ProcessInfo.processInfo.environment) {
            udid = environment["SIMULATOR_UDID"]
        }
    }

    /// Cross-package contract: lowercase UTF-8, 32-bit FNV-1a, then linear probing.
    /// Keep identical to the other package; ios/sdk-port-contract.json pins the wire contract.
    enum SdkSimulatorPort {
        static let rangeStart: UInt16 = 40000
        static let rangeSize = 1000
        static let probeCount = 8

        static func simulatorPort(udid: String, attempt: Int = 0) -> UInt16 {
            precondition(attempt >= 0)
            var hash: UInt32 = 2_166_136_261
            for byte in udid.lowercased().utf8 {
                hash = (hash ^ UInt32(byte)) &* 16_777_619
            }
            let offset = (UInt64(hash) + UInt64(attempt)) % UInt64(rangeSize)
            return rangeStart + UInt16(offset)
        }
    }
#endif
