@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeChannelPureTests: XCTestCase {
    private struct BackoffVectors: Decodable {
        struct Case: Decodable {
            struct Reconnect: Decodable {
                let maxAttempts: Int?
                let initialDelayMs: Int?
                let maxDelayMs: Int?
            }

            struct Expected: Decodable {
                let attempt: Int
                let delayMs: Int?
            }

            let name: String
            let reconnect: Reconnect
            let randoms: [Double]
            let expected: [Expected]
        }

        let cases: [Case]
    }

    private struct CoalesceVectors: Decodable {
        struct Case: Decodable {
            let name: String
            let frames: [[JSONValue]]
            let expected: [[JSONValue]]
        }

        let cases: [Case]
    }

    private var backoffVectors: BackoffVectors!
    private var coalesceVectors: CoalesceVectors!

    override func setUpWithError() throws {
        try super.setUpWithError()
        backoffVectors = try JSONDecoder().decode(
            BackoffVectors.self,
            from: Data(contentsOf: PrototypeSpecFixtures.directory.appendingPathComponent("realtime/backoff.json"))
        )
        coalesceVectors = try JSONDecoder().decode(
            CoalesceVectors.self,
            from: Data(contentsOf: PrototypeSpecFixtures.directory.appendingPathComponent("realtime/coalesce.json"))
        )
    }

    func testSharedBackoffVectors() {
        XCTAssertFalse(backoffVectors.cases.isEmpty)
        for vector in backoffVectors.cases {
            var consumed = 0
            for expected in vector.expected {
                let actual = PrototypeChannelBackoff.delayMs(
                    attempt: expected.attempt,
                    maxAttempts: vector.reconnect.maxAttempts,
                    initialDelayMs: vector.reconnect.initialDelayMs,
                    maxDelayMs: vector.reconnect.maxDelayMs
                ) {
                    defer { consumed += 1 }
                    return vector.randoms[consumed % vector.randoms.count]
                }
                XCTAssertEqual(actual, expected.delayMs, "\(vector.name): attempt \(expected.attempt)")
            }
            XCTAssertEqual(consumed, vector.expected.filter { $0.delayMs != nil }.count, vector.name)
        }
    }

    func testSharedCoalesceVectors() {
        XCTAssertFalse(coalesceVectors.cases.isEmpty)
        for vector in coalesceVectors.cases {
            XCTAssertEqual(PrototypeChannelCoalescer.coalesce(vector.frames), vector.expected, vector.name)
        }
    }

    func testMalformedWritesBreakCoalescingRuns() {
        let write: [JSONValue] = [.object(["type": .string("setData"), "path": .string("/data/a")])]
        for malformed: JSONValue in [
            .null,
            .object(["type": .string("setData"), "path": .number(1)]),
            .object(["type": .string("setState")]),
        ] {
            let frames = [write, [malformed], [malformed], write]
            XCTAssertEqual(PrototypeChannelCoalescer.coalesce(frames), frames)
        }
        XCTAssertEqual(PrototypeChannelCoalescer.coalesce([]), [])
    }

    func testTargetsUseExactUnicodeIdentity() {
        let frames: [[JSONValue]] = ["\u{E9}", "e\u{301}"].map {
            [.object(["type": .string("setState"), "key": .string($0)])]
        }
        XCTAssertEqual(PrototypeChannelCoalescer.coalesce(frames).count, 2)
    }
}
