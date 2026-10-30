@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeMediaPoolTests: XCTestCase {
    private struct PoolCase: Decodable {
        struct Item: Decodable {
            let id: String
            let visibleFraction: Double
        }

        struct Input: Decodable {
            let mode: String
            let items: [Item]
            let settledIndex: Int?
            let visibleThreshold: Double
            let foreground: Bool
            let held: [String]
        }

        struct Expected: Decodable {
            let play: String?
            let preload: [String]
            let release: [String]
        }

        let name: String
        let input: Input
        let expected: Expected
    }

    private func cases() throws -> [PoolCase] {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode([PoolCase].self, from: Data(
            contentsOf: repository.appendingPathComponent("test/fixtures/prototype-media-pool/allocation.json")
        ))
    }

    func testSharedFixturesAllocateTheSamePlayersOnEveryPlatform() throws {
        let cases = try cases()
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            let input = testCase.input
            let mode = try XCTUnwrap(PrototypeMediaPool.Mode(rawValue: input.mode), testCase.name)
            let result = PrototypeMediaPool.allocate(PrototypeMediaPool.Input(
                mode: mode,
                items: input.items.map { PrototypeMediaPool.Item(id: $0.id, visibleFraction: $0.visibleFraction) },
                settledIndex: input.settledIndex,
                visibleThreshold: input.visibleThreshold,
                foreground: input.foreground,
                held: input.held
            ))
            let expected = testCase.expected
            XCTAssertEqual(
                result,
                PrototypeMediaPool.Allocation(
                    play: expected.play, preload: expected.preload, release: expected.release
                ),
                testCase.name
            )
        }
    }

    func testThePoolSizeComesFromTheContract() {
        XCTAssertEqual(PrototypeMediaPool.maxActiveDecoders, 3)
        XCTAssertEqual(
            PrototypeMediaPool.maxActiveDecoders,
            PrototypeContractValidator.limit("MAX_PROTOTYPE_ACTIVE_DECODERS")
        )
    }

    func testSwipingFiftyPagesNeverHoldsMoreThanThePoolAndAlwaysPlaysOnePage() {
        let pages = (0 ..< 50).map { "p\($0)" }
        var held: [String] = []
        for page in pages.indices {
            let result = PrototypeMediaPool.allocate(PrototypeMediaPool.Input(
                mode: .pager,
                items: pages.indices.map {
                    PrototypeMediaPool.Item(id: pages[$0], visibleFraction: $0 == page ? 1 : 0)
                },
                settledIndex: page,
                held: held
            ))
            held.removeAll { result.release.contains($0) }
            let holding = (result.play.map { [$0] } ?? []) + result.preload
            for id in holding where !held.contains(id) {
                held.append(id)
            }
            XCTAssertEqual(result.play, pages[page])
            XCTAssertLessThanOrEqual(held.count, PrototypeMediaPool.maxActiveDecoders, "page \(page) holds \(held)")
        }
    }
}
