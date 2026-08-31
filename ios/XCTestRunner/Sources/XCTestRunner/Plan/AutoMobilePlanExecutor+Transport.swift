import Foundation

extension AutoMobilePlanExecutor {
    public enum Transport: Sendable {
        case daemonUnixSocket(path: String)
        case streamableHttp(url: URL)
    }
}
