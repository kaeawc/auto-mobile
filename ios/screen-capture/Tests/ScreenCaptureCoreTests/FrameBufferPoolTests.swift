import Foundation
import XCTest
@testable import ScreenCaptureCore

final class FrameBufferPoolTests: XCTestCase {

    func testCopiesBytesExactly() {
        let pool = FrameBufferPool()
        let source: [UInt8] = (0..<256).map { UInt8($0) }
        let data = source.withUnsafeBytes { buffer in
            pool.makeData(copyingFrom: buffer.baseAddress!, count: source.count)
        }
        XCTAssertEqual(Array(data), source)
    }

    func testZeroCountReturnsEmptyData() {
        let pool = FrameBufferPool()
        let source: [UInt8] = [1, 2, 3]
        let data = source.withUnsafeBytes { buffer in
            pool.makeData(copyingFrom: buffer.baseAddress!, count: 0)
        }
        XCTAssertTrue(data.isEmpty)
    }

    func testReleasedSlabIsRecycledForNextSameSizeFrame() {
        let pool = FrameBufferPool()
        let source = [UInt8](repeating: 0xAB, count: 4096)

        // Compare backing addresses (as bit patterns, never dereferenced) across a
        // release: the second allocation should reuse the first slab.
        let firstAddress: UInt = source.withUnsafeBytes { buffer in
            var data: Data? = pool.makeData(copyingFrom: buffer.baseAddress!, count: source.count)
            let address = data!.withUnsafeBytes { UInt(bitPattern: $0.baseAddress) }
            data = nil  // last reference released -> custom deallocator returns the slab
            return address
        }

        let secondAddress: UInt = source.withUnsafeBytes { buffer in
            let data = pool.makeData(copyingFrom: buffer.baseAddress!, count: source.count)
            return data.withUnsafeBytes { UInt(bitPattern: $0.baseAddress) }
        }

        XCTAssertEqual(
            firstAddress, secondAddress,
            "a released slab should be recycled for the next same-size frame"
        )
    }

    func testLargerFreeSlabSatisfiesSmallerRequest() {
        let pool = FrameBufferPool()
        let big = [UInt8](repeating: 0x11, count: 8192)
        let bigAddress: UInt = big.withUnsafeBytes { buffer in
            var data: Data? = pool.makeData(copyingFrom: buffer.baseAddress!, count: big.count)
            let address = data!.withUnsafeBytes { UInt(bitPattern: $0.baseAddress) }
            data = nil
            return address
        }

        // A smaller frame reuses the larger freed slab (capacity fits) rather than
        // allocating a new one; the returned Data still exposes only the smaller count.
        let small = [UInt8](repeating: 0x22, count: 1000)
        let (smallAddress, smallData): (UInt, Data) = small.withUnsafeBytes { buffer in
            let data = pool.makeData(copyingFrom: buffer.baseAddress!, count: small.count)
            return (data.withUnsafeBytes { UInt(bitPattern: $0.baseAddress) }, data)
        }

        XCTAssertEqual(bigAddress, smallAddress, "a larger free slab should satisfy a smaller request")
        XCTAssertEqual(smallData.count, small.count)
        XCTAssertEqual(Array(smallData), small)
    }
}
