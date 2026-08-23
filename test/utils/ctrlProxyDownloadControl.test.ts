import { describe, expect, test } from "bun:test";
import { parseDaemonArgs } from "../../src/daemon/manager";
import { shouldSkipCtrlProxyDownload } from "../../src/utils/ctrlProxyDownloadControl";

describe("ctrlProxyDownloadControl", function () {
  test("uses the CtrlProxy skip flag for both platforms", function () {
    expect(shouldSkipCtrlProxyDownload(["--skip-ctrl-proxy-download"], {})).toBe(true);
  });

  test("keeps the legacy accessibility flag as a CLI alias", function () {
    expect(shouldSkipCtrlProxyDownload(["--skip-accessibility-download"], {})).toBe(true);
  });

  test("uses AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD as the shared env var", function () {
    expect(shouldSkipCtrlProxyDownload([], { AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD: "1" })).toBe(
      true,
    );
    expect(shouldSkipCtrlProxyDownload([], { AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD: "true" })).toBe(
      true,
    );
    expect(shouldSkipCtrlProxyDownload([], { AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD: "false" })).toBe(
      false,
    );
  });

  test("daemon arg parsing honors the shared env var", function () {
    const options = parseDaemonArgs([], { AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD: "true" });

    expect(options.skipCtrlProxyDownload).toBe(true);
  });
});
