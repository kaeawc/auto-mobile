extension DaemonManager {
    /// The daemon's PID-file JSON shape. Kept nested (`DaemonManager.PidFileData`) as it is part of the
    /// public API surface. Frozen wire contract with the TypeScript daemon (`src/daemon/manager.ts`).
    public struct PidFileData: Decodable, Sendable {
        public let pid: Int
        public let port: Int?
        public let socketPath: String?
        public let startedAt: Int64?
        public let version: String?
        public let assetVersion: String?
        public let entryScript: String?
        public let buildId: String?
    }
}
