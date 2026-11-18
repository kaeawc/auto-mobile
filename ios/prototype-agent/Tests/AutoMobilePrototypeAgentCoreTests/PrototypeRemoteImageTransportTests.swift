@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRemoteImageTransportTests: XCTestCase {
    private func loader() -> PrototypeRemoteImageLoader {
        let client = PrototypeURLSessionClient(
            protocolClasses: [StubProtocol.self], remoteImageDevelopment: false,
            resolver: FakeHostResolver(), metrics: FakeConnectionMetrics.allowed
        )
        return PrototypeRemoteImageLoader(
            client: client,
            memory: PrototypeRemoteImageMemory(),
            resolver: FakeHostResolver(),
            directory: nil
        )
    }

    func testURLSessionHappyPathAndNoAmbientHeaders() async throws {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: [PrototypeRemoteImageLoaderTests.png]) }
        let image = try await loader().load("https://public.example/image")
        XCTAssertEqual(image.image.height, 1)
        let request = try XCTUnwrap(StubProtocol.requests.first)
        for header in ["Cookie", "Referer", "Authorization"] {
            XCTAssertNil(request.value(forHTTPHeaderField: header))
        }
        let configuration = PrototypeURLSessionClient.configuration()
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertNil(configuration.urlCache)
        XCTAssertNil(configuration.urlCredentialStorage)
        XCTAssertEqual(configuration.timeoutIntervalForResource, 30)
    }

    func testDevelopmentLoopbackLoadsThroughTheSameTransport() async throws {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: [PrototypeRemoteImageLoaderTests.png]) }
        let url = try XCTUnwrap(URL(string: "http://localhost:8080/image"))
        let resolver = FakeHostResolver(["127.0.0.1"])
        let client = PrototypeURLSessionClient(
            protocolClasses: [StubProtocol.self], remoteImageDevelopment: true, resolver: resolver,
            metrics: FakeConnectionMetrics(values: [.init(remoteAddress: "127.0.0.1", url: url)])
        )
        let loader = PrototypeRemoteImageLoader(
            client: client, memory: PrototypeRemoteImageMemory(), development: true, resolver: resolver, directory: nil
        )
        let image = try await loader.load(url.absoluteString)
        XCTAssertEqual(image.image.width, 1)
    }

    func testStreamCrossingEightMiBCancelsBeforeDecode() async throws {
        let chunk = Data(repeating: 0, count: PrototypeRemoteImages.maxDownloadBytes)
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: [chunk, Data([1])]) }
        do {
            _ = try await loader().load("https://public.example/image")
            XCTFail("Oversized stream accepted")
        } catch let failure as PrototypeHttpFailure {
            XCTAssertEqual(failure.error.code, .tooLarge)
        }
    }

    func testPrivateConnectedAddressDiscardsImageBytes() async throws {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: [PrototypeRemoteImageLoaderTests.png]) }
        let client = PrototypeURLSessionClient(
            protocolClasses: [StubProtocol.self], remoteImageDevelopment: false,
            resolver: FakeHostResolver(), metrics: FakeConnectionMetrics(values: [
                .init(remoteAddress: "192.168.1.1", url: URL(string: "https://public.example/image")),
            ])
        )
        let loader = PrototypeRemoteImageLoader(
            client: client,
            memory: PrototypeRemoteImageMemory(),
            resolver: FakeHostResolver(),
            directory: nil
        )
        do {
            _ = try await loader.load("https://public.example/image")
            XCTFail("Private connection delivered pixels")
        } catch let failure as PrototypeHttpFailure {
            XCTAssertEqual(failure.error.code, .blockedDestination)
        }
    }
}
