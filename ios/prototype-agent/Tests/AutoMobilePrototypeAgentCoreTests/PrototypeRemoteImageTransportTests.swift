@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRemoteImageTransportTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        // Compile the shared contract patterns outside individual transport test timing.
        _ = PrototypeContractValidator.matches("blankText", "")
    }

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

    func testPinnedImageChecksConnectionBeforeSendingAnyBytes() async throws {
        let connection = FakePinnedConnection(address: "192.168.1.1")
        let connector = FakePinnedConnector([connection])
        let client = PrototypePinnedHttpClient(
            resolver: FakeHostResolver(), connector: connector, deadlines: FakePinnedDeadline(), nowMs: { 0 }
        )
        let loader = PrototypeRemoteImageLoader(
            client: client, memory: PrototypeRemoteImageMemory(), directory: nil
        )
        do {
            _ = try await loader.load("https://public.example/pinned-image")
            XCTFail("Private connection delivered image")
        } catch {
            XCTAssertEqual((error as? PrototypeHttpFailure)?.error.code, .blockedDestination)
        }
        XCTAssertEqual(connector.dials.count, 1)
        XCTAssertTrue(connection.sent.isEmpty)
        XCTAssertEqual(connection.receiveCount, 0)
        XCTAssertTrue(connection.cancelled)
    }

    func testPinnedImageRedirectRetainsPublicOnlyPolicy() async throws {
        for location in ["https://10.0.0.1/image", "https://public.example:3000/image"] {
            let redirect =
                FakePinnedConnection("HTTP/1.1 302 Found\r\nLocation: \(location)\r\nContent-Length: 0\r\n\r\n")
            let connector = FakePinnedConnector([redirect])
            let resolver = FakeHostResolver()
            let client = PrototypePinnedHttpClient(
                resolver: resolver, connector: connector, deadlines: FakePinnedDeadline(), nowMs: { 0 }
            )
            let loader = PrototypeRemoteImageLoader(
                client: client, memory: PrototypeRemoteImageMemory(), directory: nil
            )
            do {
                _ = try await loader.load("https://public.example/redirect-image")
                XCTFail("Unsafe image redirect accepted")
            } catch {
                XCTAssertEqual((error as? PrototypeHttpFailure)?.error.code, .blockedDestination)
            }
            XCTAssertEqual(connector.dials.count, 1)
            XCTAssertEqual(resolver.requestedHosts, ["public.example"])
        }
    }

    func testPinnedImageLoopbackFollowsCompileTimeDevelopmentSetting() async throws {
        let png = PrototypeRemoteImageLoaderTests.png
        var response = Data("HTTP/1.1 200 OK\r\nContent-Length: \(png.count)\r\n\r\n".utf8)
        response.append(png)
        let connection = FakePinnedConnection(response: response, address: "127.0.0.1")
        let connector = FakePinnedConnector([connection])
        let client = PrototypePinnedHttpClient(
            resolver: FakeHostResolver(["127.0.0.1"]), connector: connector,
            deadlines: FakePinnedDeadline(), allowsCleartext: true, nowMs: { 0 }
        )
        let loader = PrototypeRemoteImageLoader(
            client: client, memory: PrototypeRemoteImageMemory(),
            development: PrototypeRemoteImages.developmentLoopback, directory: nil
        )
        #if DEBUG || PROTOVIEWER_ALLOW_CLEARTEXT
            let image = try await loader.load("http://localhost:8080/image")
            XCTAssertEqual(image.image.width, 1)
            XCTAssertEqual(connector.dials.map(\.address), ["127.0.0.1"])
        #else
            do {
                _ = try await loader.load("http://localhost:8080/image")
                XCTFail("Release image loopback accepted")
            } catch {
                XCTAssertEqual((error as? PrototypeRequestError)?.code, .blockedDestination)
            }
            XCTAssertTrue(connector.dials.isEmpty)
        #endif
    }

    #if !DEBUG && !PROTOVIEWER_ALLOW_CLEARTEXT && canImport(Network)
        @MainActor
        func testReleaseConfigurationsRefuseImageLoopbackEvenWithCleartextEnabled() async throws {
            let library = PrototypeLibraryNetwork.configuration(
                gate: PrototypeLibraryNetworkGate(enabled: true), allowsCleartext: true
            ) { _, _ in
                XCTFail("Release image loopback reached pinned factory")
                return .pinned(allowsCleartext: true)
            }
            for configuration in [PrototypeNetworkConfiguration.pinned(allowsCleartext: true), library] {
                do {
                    _ = try await configuration.remoteImages.load("http://localhost:8080/image")
                    XCTFail("Release configuration accepted image loopback")
                } catch {
                    XCTAssertEqual((error as? PrototypeRequestError)?.code, .blockedDestination)
                }
            }
        }
    #endif

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
