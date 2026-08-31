extension DaemonManager {
    /// The decoded result of a `daemon/refreshDevices` request. Kept nested
    /// (`DaemonManager.RefreshDevicesResult`) as it is part of the public API surface.
    public struct RefreshDevicesResult: Sendable {
        public let success: Bool
        public let addedDevices: Int
        public let totalDevices: Int
        public let availableDevices: Int
    }
}
