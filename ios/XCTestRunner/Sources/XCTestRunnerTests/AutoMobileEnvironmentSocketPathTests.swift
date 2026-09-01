import XCTest
@testable import XCTestRunner

final class AutoMobileEnvironmentSocketPathTests: XCTestCase {
    /// Read back the NUL-terminated C string currently stored in `sun_path`.
    private func readSunPath(_ addr: sockaddr_un) -> String {
        var addr = addr
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        return withUnsafePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: CChar.self, capacity: capacity) { ptr in
                String(cString: ptr)
            }
        }
    }

    private var sunPathCapacity: Int {
        let addr = sockaddr_un()
        return MemoryLayout.size(ofValue: addr.sun_path)
    }

    func testSetSocketPathCopiesShortPath() {
        var addr = sockaddr_un()
        let path = "/tmp/auto-mobile/daemon.sock"
        XCTAssertTrue(DaemonManager.setSocketPath(path, into: &addr))
        XCTAssertEqual(readSunPath(addr), path)
    }

    /// The longest path that still fits is `capacity - 1` bytes (room for NUL).
    func testSetSocketPathAcceptsMaximumLengthPath() {
        var addr = sockaddr_un()
        let path = String(repeating: "a", count: sunPathCapacity - 1)
        XCTAssertTrue(DaemonManager.setSocketPath(path, into: &addr))
        XCTAssertEqual(readSunPath(addr), path)
    }

    /// A path exactly `capacity` bytes (no room for NUL) must be rejected — the
    /// pre-fix `strcpy` would have overflowed the stack `sockaddr_un` (issue #3625).
    func testSetSocketPathRejectsPathWithoutRoomForNul() {
        var addr = sockaddr_un()
        let path = String(repeating: "b", count: sunPathCapacity)
        XCTAssertFalse(DaemonManager.setSocketPath(path, into: &addr))
    }

    func testSetSocketPathRejectsOverlongPath() {
        var addr = sockaddr_un()
        let path = String(repeating: "c", count: sunPathCapacity + 200)
        XCTAssertFalse(DaemonManager.setSocketPath(path, into: &addr))
    }

    // MARK: - SO_RCVTIMEO timeout computation (issue: sub-second truncation)

    /// A sub-second timeout must survive as microseconds. Pre-fix `Int(0.5)` gave `tv_sec == 0`
    /// with a hardcoded `tv_usec == 0`, i.e. `{0, 0}` — which Darwin reads as "no timeout".
    func testReceiveTimeoutPreservesSubSecondValue() {
        let tv = DaemonManager.receiveTimeout(forSeconds: 0.5)
        XCTAssertEqual(tv.tv_sec, 0)
        XCTAssertEqual(tv.tv_usec, 500_000)
    }

    /// The fractional part must be carried alongside whole seconds, not dropped.
    func testReceiveTimeoutCarriesFractionAlongsideWholeSeconds() {
        let tv = DaemonManager.receiveTimeout(forSeconds: 1.25)
        XCTAssertEqual(tv.tv_sec, 1)
        XCTAssertEqual(tv.tv_usec, 250_000)
    }

    /// The common integral path is unchanged.
    func testReceiveTimeoutWholeSecondsHasNoMicroseconds() {
        let tv = DaemonManager.receiveTimeout(forSeconds: 30)
        XCTAssertEqual(tv.tv_sec, 30)
        XCTAssertEqual(tv.tv_usec, 0)
    }

    /// A zero or tiny timeout must clamp to a non-zero `timeval` so `SO_RCVTIMEO` is never
    /// disabled (which would let `read` block forever waiting on an unresponsive daemon).
    func testReceiveTimeoutClampsToNonZero() {
        for seconds in [0.0, 0.0005] {
            let tv = DaemonManager.receiveTimeout(forSeconds: seconds)
            XCTAssertFalse(tv.tv_sec == 0 && tv.tv_usec == 0, "timeout \(seconds) must not disable SO_RCVTIMEO")
        }
    }
}
