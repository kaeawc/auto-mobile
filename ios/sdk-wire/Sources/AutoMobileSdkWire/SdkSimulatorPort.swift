/// Cross-package contract: lowercase UTF-8, 32-bit FNV-1a, then linear probing. The SDK binds the
/// port and the runner dials it, so both use this one implementation; `ios/sdk-port-contract.json`
/// pins the values.
public enum SdkSimulatorPort {
    public static let rangeStart: UInt16 = 40000
    public static let rangeSize = 1000
    public static let probeCount = 8

    public static func simulatorPort(udid: String, attempt: Int = 0) -> UInt16 {
        precondition(attempt >= 0)
        var hash: UInt32 = 2_166_136_261
        for byte in udid.lowercased().utf8 {
            hash = (hash ^ UInt32(byte)) &* 16_777_619
        }
        let offset = (UInt64(hash) + UInt64(attempt)) % UInt64(rangeSize)
        return rangeStart + UInt16(offset)
    }
}
