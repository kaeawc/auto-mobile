import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nodeTerminalReleaseJournalFileSystem } from "../../src/daemon/terminalReleaseJournal";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { runTerminalReleaseJournalDirectoryContract } from "./TerminalReleaseJournalDirectoryContract";

runTerminalReleaseJournalDirectoryContract("FakeTerminalReleaseJournalFileSystem", async () => ({
  files: new FakeTerminalReleaseJournalFileSystem(),
  root: "/fake-journal",
  join: (...segments) => path.posix.join(...segments),
}));

// The real side runs over a private mkdtemp directory removed afterwards (#11868).
runTerminalReleaseJournalDirectoryContract("nodeTerminalReleaseJournalFileSystem", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "am-release-journal-contract-"));
  return {
    files: nodeTerminalReleaseJournalFileSystem,
    root,
    join: (...segments) => path.join(...segments),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
});
