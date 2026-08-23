import { describe, expect, test } from "bun:test";
import {
  evaluateClientHandshake,
  extractClientHandshake,
  hasClientHandshake,
  type DaemonSelfIdentity,
} from "../../src/daemon/daemonHandshake";
import type { BuildIdentity } from "../../src/daemon/buildIdentity";

const daemonBuild: BuildIdentity = { entryScript: "/repo/dist/index.js", buildId: "abc123def456" };

function daemon(version: string, build: BuildIdentity = daemonBuild): DaemonSelfIdentity {
  return { version, build };
}

describe("extractClientHandshake", () => {
  test("pulls handshake fields off a request payload", () => {
    const handshake = extractClientHandshake({
      clientVersion: " 0.0.40 ",
      clientBuildId: "abc123def456",
      clientEntryScript: "/repo/dist/index.js",
    });
    expect(handshake.clientVersion).toBe("0.0.40");
    expect(handshake.clientBuildId).toBe("abc123def456");
    expect(handshake.clientEntryScript).toBe("/repo/dist/index.js");
  });

  test("ignores non-string fields", () => {
    const handshake = extractClientHandshake({
      clientVersion: 42 as unknown as string,
      clientBuildId: null as unknown as string,
    });
    expect(handshake.clientVersion).toBeUndefined();
    expect(handshake.clientBuildId).toBeUndefined();
  });

  test("returns empty handshake for a legacy request", () => {
    const handshake = extractClientHandshake({ id: "1", method: "tools/call" });
    expect(hasClientHandshake(handshake)).toBe(false);
  });
});

describe("evaluateClientHandshake", () => {
  test("accepts a legacy client that sends no handshake fields", () => {
    const result = evaluateClientHandshake(daemon("0.0.40"), {});
    expect(result.ok).toBe(true);
  });

  test("accepts a matching release version even when the daemon carries a git stamp", () => {
    // The Kotlin/Swift client declares the plain release version; the source-checkout
    // daemon carries a +g<sha> dev stamp. Only the release portion must match.
    const result = evaluateClientHandshake(daemon("0.0.40+gabcdef123"), {
      clientVersion: "0.0.40",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a client whose release version differs from the daemon", () => {
    const result = evaluateClientHandshake(daemon("0.0.41"), { clientVersion: "0.0.40" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("version");
      expect(result.message).toContain("0.0.41");
      expect(result.message).toContain("0.0.40");
    }
  });

  test("rejects an older client against a newer daemon (the #2732 skew, symmetric)", () => {
    const result = evaluateClientHandshake(daemon("0.0.40"), { clientVersion: "0.0.39" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("version");
    }
  });

  test("rejects a git-stamped client version differing from the daemon even without a build id", () => {
    // Declaring `+g<sha>` means the client knows its exact commit; a different stamp is a different
    // commit, so it is held to the full version regardless of whether a build id was sent.
    const result = evaluateClientHandshake(daemon("0.0.40+gaaa"), { clientVersion: "0.0.40+gbbb" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("version");
    }
  });

  test("accepts a git-stamped client version identical to the daemon", () => {
    const result = evaluateClientHandshake(daemon("0.0.40+gaaa"), { clientVersion: "0.0.40+gaaa" });
    expect(result.ok).toBe(true);
  });

  test("rejects a same-release client whose build id differs (build gate, TS client)", () => {
    const result = evaluateClientHandshake(daemon("0.0.40+gaaa"), {
      clientVersion: "0.0.40+gaaa",
      clientBuildId: "differentbuild99",
      clientEntryScript: "/other/dist/index.js",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("build");
    }
  });

  test("rejects a TS client whose build id matches but full dev-stamped version differs", () => {
    // Same entry-script hash (build id matches) but a different git stamp: the entry hash is
    // blind to changes in imported files, so the full version is the only skew signal. This is
    // the CLI direct-DaemonClient path #2732 that a release-only compare would let through.
    const result = evaluateClientHandshake(
      daemon("0.0.40+gaaa", { entryScript: daemonBuild.entryScript, buildId: "sharedbuildid01" }),
      {
        clientVersion: "0.0.40+gbbb",
        clientBuildId: "sharedbuildid01",
        clientEntryScript: daemonBuild.entryScript,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("version");
    }
  });

  test("accepts a TS client whose build id and full version both match", () => {
    const result = evaluateClientHandshake(
      daemon("0.0.40+gaaa", { entryScript: daemonBuild.entryScript, buildId: "sharedbuildid01" }),
      {
        clientVersion: "0.0.40+gaaa",
        clientBuildId: "sharedbuildid01",
        clientEntryScript: daemonBuild.entryScript,
      },
    );
    expect(result.ok).toBe(true);
  });

  test("still accepts a version-only client on release match despite differing git stamps", () => {
    // Kotlin/Swift declare a plain release and no build id -> release-portion compare only.
    const result = evaluateClientHandshake(daemon("0.0.40+gaaa"), { clientVersion: "0.0.40" });
    expect(result.ok).toBe(true);
  });

  test("accepts an Android local-override client: plain release + matching build id vs git-stamped daemon", () => {
    // The local-override JUnit runner declares its checkout's plain release AND the entry-script
    // build id, but cannot compute the daemon's git stamp. A matching build id proves it is the
    // same local build, so the plain-vs-stamped version difference must not reject it.
    const build: BuildIdentity = {
      entryScript: "/local/dist/src/index.js",
      buildId: "localbuildid1234",
    };
    const result = evaluateClientHandshake(daemon("0.0.40+glocalsha", build), {
      clientVersion: "0.0.40",
      clientBuildId: build.buildId,
      clientEntryScript: build.entryScript,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects an Android local-override client whose build id differs (real skew)", () => {
    const result = evaluateClientHandshake(
      daemon("0.0.40+glocalsha", {
        entryScript: "/local/dist/src/index.js",
        buildId: "localbuildid1234",
      }),
      {
        clientVersion: "0.0.40",
        clientBuildId: "differentlocal99",
        clientEntryScript: "/other/dist/src/index.js",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("build");
    }
  });

  test("accepts a same-release client whose build id matches", () => {
    const result = evaluateClientHandshake(daemon("0.0.40"), {
      clientVersion: "0.0.40",
      clientBuildId: daemonBuild.buildId,
      clientEntryScript: daemonBuild.entryScript,
    });
    expect(result.ok).toBe(true);
  });

  test("does not apply the build gate to a version-only client (Kotlin/Swift)", () => {
    // No clientBuildId -> build gate is skipped (buildIdentitiesMatch treats unknown as match).
    const result = evaluateClientHandshake(daemon("0.0.40"), { clientVersion: "0.0.40" });
    expect(result.ok).toBe(true);
  });

  test("accepts a build-id-only client whose id matches the daemon", () => {
    const result = evaluateClientHandshake(daemon("0.0.40"), {
      clientBuildId: daemonBuild.buildId,
      clientEntryScript: daemonBuild.entryScript,
    });
    expect(result.ok).toBe(true);
  });
});
