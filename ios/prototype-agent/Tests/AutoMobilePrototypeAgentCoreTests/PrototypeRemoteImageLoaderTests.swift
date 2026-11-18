@testable import AutoMobilePrototypeAgentCore
import CoreGraphics
import ImageIO
import XCTest

private actor ImageClient: PrototypeHttpClient {
    let bytes: Data
    var calls = 0
    let onPerform: @Sendable () -> Void
    init(_ bytes: Data, onPerform: @escaping @Sendable () -> Void = {}) {
        self.bytes = bytes
        self.onPerform = onPerform
    }

    func perform(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        calls += 1
        onPerform()
        XCTAssertEqual(request.maxResponseBytes, PrototypeRemoteImages.maxDownloadBytes)
        XCTAssertEqual(request.timeoutMs, 30000)
        XCTAssertEqual(request.headers, [:])
        return PrototypeHttpResponse(status: 200, headers: [:], body: bytes, durationMs: 0)
    }
}

final class PrototypeRemoteImageLoaderTests: XCTestCase {
    static let png = Data([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21,
        196,
        137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 96, 96, 248, 15, 0, 1, 4, 1, 0, 95, 229, 195, 75, 0, 0,
        0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ])

    func testExifOrientationIsAppliedAndLargeImagesAreDownsampled() throws {
        let landscape = try Self.jpeg(width: 40, height: 20, orientation: 6)
        let rotated = try PrototypeRemoteImage(bytes: landscape)
        XCTAssertEqual(rotated.image.width, 20)
        XCTAssertEqual(rotated.image.height, 40)
        let large = try PrototypeRemoteImage(bytes: Self.jpeg(width: 4096, height: 2048, orientation: 1))
        XCTAssertLessThanOrEqual(max(large.image.width, large.image.height), PrototypeRemoteImages.maxDecodedEdge)
    }

    private static func jpeg(width: Int, height: Int, orientation: Int) throws -> Data {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    func testDecodedMemoryCacheAvoidsTransport() async throws {
        let client = ImageClient(Self.png)
        let loader = PrototypeRemoteImageLoader(
            client: client,
            memory: PrototypeRemoteImageMemory(),
            resolver: FakeHostResolver(),
            directory: nil
        )
        let first = try await loader.load("https://public.example/photo")
        let second = try await loader.load("https://public.example/photo")
        XCTAssertTrue(first === second)
        XCTAssertEqual(first.image.width, 1)
        let calls = await client.calls
        XCTAssertEqual(calls, 1)
    }

    func testNonImagesAndOversizedImagesFailWithoutCaching() async throws {
        for bytes in [
            Data("not an image".utf8),
            Data(repeating: 0, count: PrototypeRemoteImages.maxDownloadBytes + 1),
        ] {
            let client = ImageClient(bytes)
            let loader = PrototypeRemoteImageLoader(
                client: client,
                memory: PrototypeRemoteImageMemory(),
                resolver: FakeHostResolver(),
                directory: nil
            )
            do {
                _ = try await loader.load("https://public.example/photo")
                XCTFail("Invalid bytes decoded")
            } catch {}
        }
        XCTAssertThrowsError(try PrototypeRemoteImage(bytes: Self.png.prefix(12)))
    }

    func testDiskHitAvoidsTransportAcrossLoaders() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = ImageClient(Self.png)
        let first = PrototypeRemoteImageLoader(
            client: client,
            memory: PrototypeRemoteImageMemory(),
            resolver: FakeHostResolver(),
            directory: directory
        )
        _ = try await first.load("https://public.example/photo")
        let second = PrototypeRemoteImageLoader(
            client: client,
            memory: PrototypeRemoteImageMemory(),
            resolver: FakeHostResolver(),
            directory: directory
        )
        _ = try await second.load("https://public.example/photo")
        let calls = await client.calls
        XCTAssertEqual(calls, 1)
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(names, [PrototypeBundle.sha256(Data("https://public.example/photo".utf8))])
    }

    func testDisabledGatePreventsTransportAndCacheDelivery() async throws {
        let gate = PrototypeLibraryNetworkGate(enabled: true)
        let client = ImageClient(Self.png)
        let loader = PrototypeRemoteImageLoader(
            client: client,
            memory: PrototypeRemoteImageMemory(),
            resolver: FakeHostResolver(),
            gate: gate,
            directory: nil
        )
        _ = try await loader.load("https://public.example/photo")
        gate.setEnabled(false)
        do {
            _ = try await loader.load("https://public.example/photo")
            XCTFail("Disabled gate delivered cached image")
        } catch {}
        let calls = await client.calls
        XCTAssertEqual(calls, 1)
    }

    func testRevocationDuringTransportDiscardsDelivery() async throws {
        let gate = PrototypeLibraryNetworkGate(enabled: true)
        let client = ImageClient(Self.png, onPerform: { gate.setEnabled(false) })
        let loader = PrototypeRemoteImageLoader(
            client: client, memory: PrototypeRemoteImageMemory(), resolver: FakeHostResolver(), gate: gate,
            directory: nil
        )
        do {
            _ = try await loader.load("https://public.example/photo")
            XCTFail("Obsolete response delivered")
        } catch {}
        let calls = await client.calls
        XCTAssertEqual(calls, 1)
    }

    func testConsentIsRecheckedAtRendererDelivery() async throws {
        let gate = PrototypeLibraryNetworkGate(enabled: true)
        let loader = PrototypeRemoteImageLoader(
            client: ImageClient(Self.png), memory: PrototypeRemoteImageMemory(), resolver: FakeHostResolver(),
            gate: gate, directory: nil
        )
        let delivery = PrototypeDeliveryCheck()
        _ = try await loader.load("https://public.example/photo", delivery: delivery)
        XCTAssertNil(delivery.obsoleteFailure())
        gate.setEnabled(false)
        gate.setEnabled(true)
        XCTAssertNotNil(delivery.obsoleteFailure())
    }

    func testDiskLRUEvictsByInjectedClock() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var disk = PrototypeRemoteImageDiskCache(directory: directory, now: { Date(timeIntervalSince1970: 1) })
        disk.maxBytes = 4
        disk.write(Data([1, 2]), url: "a")
        disk.now = { Date(timeIntervalSince1970: 2) }
        disk.write(Data([3, 4]), url: "b")
        disk.now = { Date(timeIntervalSince1970: 3) }
        XCTAssertNotNil(disk.read("a"))
        disk.now = { Date(timeIntervalSince1970: 4) }
        disk.write(Data([5, 6]), url: "c")
        XCTAssertNil(disk.read("b"))
        XCTAssertNotNil(disk.read("a"))
        XCTAssertNotNil(disk.read("c"))
    }
}
