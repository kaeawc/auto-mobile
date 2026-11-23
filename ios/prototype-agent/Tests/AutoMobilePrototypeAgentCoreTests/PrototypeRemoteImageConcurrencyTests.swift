@testable import AutoMobilePrototypeAgentCore
import XCTest

private actor HeldImageClient: PrototypeHttpClient {
    private var pending: [CheckedContinuation<Void, Never>] = []
    private(set) var count = 0
    private var started: CheckedContinuation<Void, Never>?

    func waitForSix() async {
        if count < 6 { await withCheckedContinuation { started = $0 } }
    }

    func release() {
        let calls = pending
        pending = []
        for call in calls {
            call.resume()
        }
    }

    func perform(_: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        count += 1
        if count == 6 { started?.resume(); started = nil }
        if count <= 6 { await withCheckedContinuation { pending.append($0) } }
        return PrototypeHttpResponse(
            status: 200,
            headers: [:],
            body: PrototypeRemoteImageLoaderTests.png,
            durationMs: 0
        )
    }
}

final class PrototypeRemoteImageConcurrencyTests: XCTestCase {
    func testSixLoadsAcrossConfigurationsQueueTheSeventh() async throws {
        let client = HeldImageClient()
        let queued = FakePinnedSignal()
        let slots = PrototypeRemoteImageSlots(onQueued: { queued.release() })
        let loaders = (0 ..< 7).map { _ in
            PrototypeRemoteImageLoader(
                client: client,
                slots: slots,
                memory: PrototypeRemoteImageMemory(),
                resolver: FakeHostResolver(),
                directory: nil
            )
        }
        let first = (0 ..< 6).map { index in
            Task { try await loaders[index].load("https://public.example/\(index)") }
        }
        await client.waitForSix()
        let seventh = Task { try await loaders[6].load("https://public.example/6") }
        await queued.wait()
        let count = await client.count
        XCTAssertEqual(queued.releaseCount, 1)
        XCTAssertEqual(count, 6)
        await client.release()
        for task in first {
            _ = try await task.value
        }
        _ = try await seventh.value
        let final = await client.count
        XCTAssertEqual(final, 7)
    }
}
