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
}
