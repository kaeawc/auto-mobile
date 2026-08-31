extension AutoMobilePlanExecutor {
    public struct TestMetadata: Sendable {
        public let testClass: String
        public let testMethod: String
        public let appVersion: String?
        public let gitCommit: String?
        public let isCi: Bool?

        public init(
            testClass: String,
            testMethod: String,
            appVersion: String? = nil,
            gitCommit: String? = nil,
            isCi: Bool? = nil
        ) {
            self.testClass = testClass
            self.testMethod = testMethod
            self.appVersion = appVersion
            self.gitCommit = gitCommit
            self.isCi = isCi
        }
    }
}
