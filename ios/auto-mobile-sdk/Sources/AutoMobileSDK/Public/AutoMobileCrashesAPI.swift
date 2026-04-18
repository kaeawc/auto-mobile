import Foundation

/// Fine-grained DI surface for the SDK's crash-reporting subsystem.
public protocol AutoMobileCrashesAPI: AnyObject, Sendable {
    func enableSignalHandlers()
    func setCurrentScreenProvider(_ provider: (@Sendable () -> String?)?)
}

/// Default implementation of `AutoMobileCrashesAPI` backed by `AutoMobileCrashes.shared`.
public final class DefaultAutoMobileCrashesAPI: AutoMobileCrashesAPI, @unchecked Sendable {
    private let crashes = AutoMobileCrashes.shared

    public init() {}

    public func enableSignalHandlers() {
        crashes.enableSignalHandlers()
    }

    public func setCurrentScreenProvider(_ provider: (@Sendable () -> String?)?) {
        crashes.currentScreenProvider = provider
    }
}
