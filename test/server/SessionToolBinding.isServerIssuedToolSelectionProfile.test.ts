import { describe, expect, test } from "bun:test";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";

/**
 * #6148 round 3 — `isServerIssuedToolSelectionProfile` must distinguish a
 * profile this instance itself minted and bound (via
 * `createAndBindToolSelectionProfile`) from the unauthenticated
 * `initialToolSelectionProfileUuid` constructor fallback, which is threaded
 * verbatim from a caller-controlled transport header with no issuance check.
 */
describe("SessionToolBinding.isServerIssuedToolSelectionProfile (#6148)", () => {
  test("recognizes a profile it minted and bound for this mcpSessionId", () => {
    const binding = new SessionToolBinding();
    const minted = binding.createAndBindToolSelectionProfile("conn-1");

    expect(binding.isServerIssuedToolSelectionProfile("conn-1", minted)).toBe(true);
  });

  test("rejects the unauthenticated constructor-supplied fallback profile", () => {
    // Simulates the DAEMON_TOOL_SELECTION_PROFILE_HEADER threading path: a
    // caller-supplied value with no local mint/bind behind it.
    const binding = new SessionToolBinding(undefined, "caller-supplied-header-value");

    expect(
      binding.isServerIssuedToolSelectionProfile("conn-1", "caller-supplied-header-value"),
    ).toBe(false);
    // connectionToolSelectionProfileUuid still returns it as the resolved
    // identity (it's a legitimate bookkeeping key for tool-selection reads) —
    // only the narrower issuance check must say no.
    expect(binding.connectionToolSelectionProfileUuid("conn-1")).toBe(
      "caller-supplied-header-value",
    );
  });

  test("rejects a fabricated uuid that was never minted for this connection", () => {
    const binding = new SessionToolBinding();
    binding.createAndBindToolSelectionProfile("conn-1");

    expect(binding.isServerIssuedToolSelectionProfile("conn-1", "fabricated-uuid")).toBe(false);
  });

  test("does not honor a mint bound to a DIFFERENT mcpSessionId", () => {
    const binding = new SessionToolBinding();
    const minted = binding.createAndBindToolSelectionProfile("conn-1");

    expect(binding.isServerIssuedToolSelectionProfile("conn-2", minted)).toBe(false);
  });

  test("stdio direct mode (no mcpSessionId) recognizes its own minted profile", () => {
    const binding = new SessionToolBinding();
    const minted = binding.createAndBindToolSelectionProfile(undefined);

    expect(binding.isServerIssuedToolSelectionProfile(undefined, minted)).toBe(true);
    expect(binding.isServerIssuedToolSelectionProfile(undefined, "fabricated-uuid")).toBe(false);
  });
});
