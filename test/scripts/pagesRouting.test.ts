import { describe, expect, test } from "bun:test";
import { resolvePagesRequest } from "../../scripts/docs/pagesRouting";

const files = new Set(["index.html", "tools/index.html", "assets/a.css", "404.html"]);
const exists = (path: string) => files.has(path);

describe("resolvePagesRequest", () => {
  test("serves files and directory indexes under the base path", () => {
    expect(resolvePagesRequest("/auto-mobile/", "/auto-mobile/", exists)).toEqual({
      kind: "file",
      sitePath: "index.html",
      status: 200,
    });
    expect(resolvePagesRequest("/auto-mobile/", "/auto-mobile/tools/", exists).status).toBe(200);
    expect(resolvePagesRequest("/auto-mobile/", "/auto-mobile/assets/a.css", exists)).toMatchObject(
      { sitePath: "assets/a.css" },
    );
  });

  test("answers a missing page under the base path with 404.html and status 404", () => {
    expect(
      resolvePagesRequest("/auto-mobile/", "/auto-mobile/using/ux-exploration/", exists),
    ).toEqual({ kind: "not-found-page", sitePath: "404.html", status: 404 });
  });

  test("does not serve anything at the domain root, so root-absolute assets 404", () => {
    expect(resolvePagesRequest("/auto-mobile/", "/assets/a.css", exists)).toEqual({
      kind: "not-found-bare",
      status: 404,
    });
  });

  test("rejects path traversal", () => {
    expect(resolvePagesRequest("/auto-mobile/", "/auto-mobile/../etc/passwd", exists).status).toBe(
      404,
    );
  });
});
