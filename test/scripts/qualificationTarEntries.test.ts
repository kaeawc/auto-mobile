import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { readTarGzEntries } from "../../scripts/qualification/tarEntries";

function tarEntry(path: string, data: Uint8Array, type = "0", prefix = ""): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const bytes = (text: string) => new TextEncoder().encode(text);
const archive = (...entries: Uint8Array[]) =>
  gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

function paxPath(path: string): Uint8Array {
  const record = `path=${path}\n`;
  let length = Buffer.byteLength(record) + 2;
  while (length !== Buffer.byteLength(record) + String(length).length + 1) {
    length = Buffer.byteLength(record) + String(length).length + 1;
  }
  return bytes(`${length} ${record}`);
}

describe("npm gzip tar entries", () => {
  test("reads regular files with package prefix and NUL type flag", () => {
    const entries = readTarGzEntries(
      archive(
        tarEntry("package/a.txt", bytes("a")),
        tarEntry("b.txt", bytes("b"), "\0", "package"),
      ),
    );
    expect(entries.map(({ path }) => path)).toEqual(["package/a.txt", "package/b.txt"]);
    expect(entries.map(({ data }) => new TextDecoder().decode(data))).toEqual(["a", "b"]);
  });
  test("skips directories and other entry types", () => {
    expect(
      readTarGzEntries(
        archive(tarEntry("package/", bytes(""), "5"), tarEntry("package/link", bytes(""), "2")),
      ),
    ).toEqual([]);
  });
  test("honours a PAX long UTF-8 path for the following entry only", () => {
    const path = `package/${"long/".repeat(25)}é.txt`;
    const entries = readTarGzEntries(
      archive(
        tarEntry("PaxHeader", paxPath(path), "x"),
        tarEntry("short", bytes("pax")),
        tarEntry("package/next", bytes("next")),
      ),
    );
    expect(entries.map(({ path }) => path)).toEqual([path, "package/next"]);
  });
  test("honours a GNU L long name for the following entry only", () => {
    const path = `package/${"long/".repeat(25)}file.txt`;
    const entries = readTarGzEntries(
      archive(
        tarEntry("././@LongLink", bytes(`${path}\0`), "L"),
        tarEntry("short", bytes("gnu")),
        tarEntry("package/next", bytes("next")),
      ),
    );
    expect(entries.map(({ path }) => path)).toEqual([path, "package/next"]);
  });
  test("throws with context for truncated headers, payloads, end markers and gzip", () => {
    const entry = tarEntry("package/a", bytes("a"));
    for (const data of [
      entry.subarray(0, 100),
      entry.subarray(0, 513),
      entry,
      Buffer.concat([entry, Buffer.alloc(512)]),
    ]) {
      expect(() => readTarGzEntries(gzipSync(data))).toThrow(
        "Unable to read gzip tar archive: Truncated",
      );
    }
    expect(() => readTarGzEntries(bytes("invalid gzip"))).toThrow(
      "Unable to read gzip tar archive",
    );
  });
  test("rejects corrupt checksums and malformed PAX records", () => {
    const entry = tarEntry("package/a", bytes("a"));
    entry[0] = 0;
    expect(() => readTarGzEntries(archive(entry))).toThrow("checksum");
    expect(() =>
      readTarGzEntries(archive(tarEntry("PaxHeader", bytes("999 path=no\n"), "x"))),
    ).toThrow("Corrupt PAX record");
  });
});
