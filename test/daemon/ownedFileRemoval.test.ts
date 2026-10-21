import { describe, expect, test } from "bun:test";
import {
  OwnedRecordRestoreError,
  removeOwnedFileSync,
  type OwnedFileRemovalFiles,
} from "../../src/daemon/ownedFileRemoval";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

const path = "/owner.pid";
const retainedPath = `${path}.reap-${process.pid}-id-1`;

function harness() {
  const contents = new Map([[path, "successor"]]);
  const calls: string[] = [];
  const faults = { link: "", copy: "" };
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const publishExclusive = (from: string, to: string) => {
    if (contents.has(to)) {
      throw fail("EEXIST");
    }
    const raw = contents.get(from);
    if (raw === undefined) {
      throw fail("ENOENT");
    }
    contents.set(to, raw);
  };
  const files: OwnedFileRemovalFiles = {
    rename: (from, to) => {
      const raw = contents.get(from);
      if (raw === undefined) {
        throw fail("ENOENT");
      }
      contents.set(to, raw);
      contents.delete(from);
    },
    link: (from, to) => {
      calls.push("link");
      if (faults.link) {
        throw fail(faults.link);
      }
      publishExclusive(from, to);
    },
    copyExclusive: (from, to) => {
      calls.push("copy");
      if (faults.copy) {
        throw fail(faults.copy);
      }
      publishExclusive(from, to);
    },
    remove: (target) => {
      contents.delete(target);
    },
  };
  const remove = (owns = false, newest = false) =>
    removeOwnedFileSync(
      path,
      (claimed) => {
        expect(claimed).toBe(retainedPath);
        if (newest) {
          contents.set(path, "newest");
        }
        return owns;
      },
      files,
      new CountingIdGenerator(),
    );
  return { contents, calls, faults, remove };
}

describe("removeOwnedFileSync", () => {
  test("owned record is removed", () => {
    const h = harness();
    expect(h.remove(true)).toBe(true);
    expect(h.contents.size).toBe(0);
    expect(h.calls).toEqual([]);
  });

  test("absent record is already removed", () => {
    const h = harness();
    h.contents.clear();
    expect(h.remove()).toBe(true);
    expect(h.contents.size).toBe(0);
    expect(h.calls).toEqual([]);
  });

  test("not owned: link restores the successor", () => {
    const h = harness();
    expect(h.remove()).toBe(false);
    expect([...h.contents]).toEqual([[path, "successor"]]);
    expect(h.calls).toEqual(["link"]);
  });

  test("not owned: link EEXIST preserves the newest publication", () => {
    const h = harness();
    expect(h.remove(false, true)).toBe(false);
    expect([...h.contents]).toEqual([[path, "newest"]]);
    expect(h.calls).toEqual(["link"]);
  });

  test.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"])(
    "not owned: link %s restores via exclusive copy",
    (code) => {
      const h = harness();
      h.faults.link = code;
      expect(h.remove()).toBe(false);
      expect([...h.contents]).toEqual([[path, "successor"]]);
      expect(h.calls).toEqual(["link", "copy"]);
    },
  );

  test("EPERM then copy EEXIST preserves the newest publication", () => {
    const h = harness();
    h.faults.link = "EPERM";
    expect(h.remove(false, true)).toBe(false);
    expect([...h.contents]).toEqual([[path, "newest"]]);
    expect(h.calls).toEqual(["link", "copy"]);
  });

  test.each([
    { name: "EPERM then copy EIO", link: "EPERM", copy: "EIO", calls: ["link", "copy"] },
    { name: "link EIO without copy", link: "EIO", copy: "", calls: ["link"] },
  ])("$name throws a typed error and retains the successor", (scenario) => {
    const h = harness();
    Object.assign(h.faults, scenario);
    let failure: unknown;
    try {
      h.remove();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OwnedRecordRestoreError);
    if (!(failure instanceof OwnedRecordRestoreError)) {
      throw new Error("Expected OwnedRecordRestoreError");
    }
    expect(failure.path).toBe(path);
    expect(failure.retainedPath).toBe(retainedPath);
    expect(failure.cause).toEqual(expect.objectContaining({ code: "EIO" }));
    expect(failure.message).toContain(retainedPath);
    expect(failure.message).toContain("EIO");
    expect([...h.contents]).toEqual([[retainedPath, "successor"]]);
    expect(h.calls).toEqual([...scenario.calls]);
  });
});
