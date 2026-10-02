@testable import AutoMobileSDK
import Foundation
import os
import XCTest

final class UserDefaultsStoreResolverTests: XCTestCase {
    func testConcurrentResolutionUsesSendableSuiteValidator() {
        let calls = OSAllocatedUnfairLock(initialState: 0)
        let resolver = UserDefaultsStoreResolver(bundleIdentifier: "com.example.app", suiteIsValid: { name in
            calls.withLock { $0 += 1 }
            return name.hasPrefix("group.")
        })
        let successes = OSAllocatedUnfairLock(initialState: 0)

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            let name = "group.storage.\(index)"
            if resolver.resolve(name) == ResolvedStore(suiteName: name),
               resolver.resolve("standard") == ResolvedStore(suiteName: nil),
               resolver.resolve("invalid") == nil
            {
                successes.withLock { $0 += 1 }
            }
        }

        XCTAssertEqual(calls.withLock { $0 }, 64)
        XCTAssertEqual(successes.withLock { $0 }, 32)
    }

    func testEmptyAndStandardInAnyCaseResolveToStandard() {
        let resolver = UserDefaultsStoreResolver(bundleIdentifier: nil, suiteIsValid: { _ in
            XCTFail("Standard aliases must not open a suite")
            return true
        })
        for name in ["", "Standard", "standard", "STANDARD", "sTaNdArD"] {
            XCTAssertEqual(resolver.resolve(name), ResolvedStore(suiteName: nil))
            XCTAssertEqual(resolver.resolve(name)?.label, "standard")
        }
    }

    func testBundleIdentifierInAnyCaseResolvesToStandard() {
        let bundle = "dev.jasonpearson.automobile.Playground"
        let resolver = UserDefaultsStoreResolver(bundleIdentifier: bundle, suiteIsValid: { _ in
            XCTFail("Bundle aliases must not open a suite")
            return true
        })
        for name in [bundle, bundle.lowercased(), bundle.uppercased()] {
            XCTAssertEqual(resolver.resolve(name), ResolvedStore(suiteName: nil))
        }
    }

    func testNilBundleIdentifierDoesNotMatchAnything() {
        let resolver = UserDefaultsStoreResolver(bundleIdentifier: nil, suiteIsValid: { _ in true })
        XCTAssertEqual(resolver.resolve("com.example.app"), ResolvedStore(suiteName: "com.example.app"))
    }

    func testOtherNamesResolveToTheNamedSuite() {
        let resolver = UserDefaultsStoreResolver(bundleIdentifier: "com.example.app", suiteIsValid: { _ in true })
        for name in ["group.com.example.shared", "duoStore"] {
            XCTAssertEqual(resolver.resolve(name), ResolvedStore(suiteName: name))
            XCTAssertEqual(resolver.resolve(name)?.label, name)
        }
    }

    func testWhitespacePaddedNamesAreRejectedBeforeOpeningASuite() {
        let resolver = UserDefaultsStoreResolver(bundleIdentifier: "com.example.app", suiteIsValid: { _ in
            XCTFail("Whitespace must be rejected before opening a suite")
            return true
        })
        for name in [" standard ", "standard\n", " ", "foo ", " foo"] {
            XCTAssertNil(resolver.resolve(name))
        }
        XCTAssertEqual(resolver.resolve(""), ResolvedStore(suiteName: nil))
        XCTAssertEqual(resolver.resolve("Standard"), ResolvedStore(suiteName: nil))
    }

    func testInvalidSuiteResolvesToNil() {
        let resolver = UserDefaultsStoreResolver(bundleIdentifier: nil, suiteIsValid: { _ in false })
        XCTAssertNil(resolver.resolve("NSGlobalDomain"))
    }

    func testDefaultSuiteValidityRejectsGlobalDomainAndAcceptsFreshSuite() {
        let name = "auto-mobile-test-\(UUID().uuidString)"
        defer { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        XCTAssertFalse(UserDefaultsStoreResolver.defaultSuiteIsValid("NSGlobalDomain"))
        XCTAssertTrue(UserDefaultsStoreResolver.defaultSuiteIsValid(name))
    }
}
