extension AutoMobilePlanExecutor {
    public struct CleanupOptions: Sendable {
        public let appId: String
        public let clearAppData: Bool

        public init(appId: String, clearAppData: Bool = false) {
            self.appId = appId
            self.clearAppData = clearAppData
        }
    }
}
