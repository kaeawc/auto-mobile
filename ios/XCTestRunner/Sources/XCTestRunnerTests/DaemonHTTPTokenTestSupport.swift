import Darwin
import Foundation
import os
@testable import XCTestRunner

final class FakeDaemonHTTPTokenProvider: DaemonHTTPTokenProviding, Sendable {
    private struct State {
        var tokens: [String?]
        var reads = 0
    }

    private let state: OSAllocatedUnfairLock<State>

    init(_ tokens: [String?] = [nil]) {
        state = OSAllocatedUnfairLock(initialState: State(tokens: tokens))
    }

    var reads: Int { state.withLock { $0.reads } }

    func readToken() -> String? {
        state.withLock {
            $0.reads += 1
            if $0.tokens.count > 1 { return $0.tokens.removeFirst() }
            return $0.tokens.isEmpty ? nil : $0.tokens[0]
        }
    }
}

final class FakeDaemonHTTPPortDiscovery: DaemonHTTPPortDiscovering, Sendable {
    private let port: Int?
    private let count = OSAllocatedUnfairLock(initialState: 0)

    init(_ port: Int? = 3161) { self.port = port }

    var reads: Int { count.withLock { $0 } }

    func discoveredPort() -> Int? {
        count.withLock { $0 += 1 }
        return port
    }
}

final class FakeDaemonTokenFileAccess: DaemonTokenFileAccessing, Sendable {
    struct Calls {
        var paths: [String] = []
        var flags: [Int32] = []
        var inspected: [Int32] = []
        var read: [Int32] = []
        var closed: [Int32] = []
    }

    let pathMetadata: stat?
    let openedMetadata: stat?
    let descriptor: Int32
    let data: Data?
    private let state = OSAllocatedUnfairLock(initialState: Calls())
    var calls: Calls { state.withLock { $0 } }

    init(
        pathMetadata: stat? = FakeDaemonTokenFileAccess.regular(),
        openedMetadata: stat? = FakeDaemonTokenFileAccess.regular(),
        descriptor: Int32 = 42,
        data: Data? = Data(" file-token\n".utf8)
    ) {
        self.pathMetadata = pathMetadata
        self.openedMetadata = openedMetadata
        self.descriptor = descriptor
        self.data = data
    }

    static func regular(mode: mode_t = 0o600, uid: uid_t = 501, type: mode_t = mode_t(S_IFREG)) -> stat {
        var value = stat()
        value.st_mode = type | mode
        value.st_uid = uid
        return value
    }

    func metadata(path: String) -> stat? {
        state.withLock { $0.paths.append(path) }
        return pathMetadata
    }

    func open(path _: String, flags: Int32) -> Int32 {
        state.withLock { $0.flags.append(flags) }
        return descriptor
    }

    func metadata(descriptor: Int32) -> stat? {
        state.withLock { $0.inspected.append(descriptor) }
        return openedMetadata
    }

    func read(descriptor: Int32) -> Data? {
        state.withLock { $0.read.append(descriptor) }
        return data
    }

    func close(descriptor: Int32) {
        state.withLock { $0.closed.append(descriptor) }
    }
}

final class TokenDiscoveryLogger: AutoMobileLogger, Sendable {
    private let state = OSAllocatedUnfairLock<[String]>(initialState: [])
    var messages: [String] { state.withLock { $0 } }
    func info(_ message: String) { state.withLock { $0.append(message) } }
    func warn(_ message: String) { info(message) }
    func error(_ message: String) { info(message) }
}
