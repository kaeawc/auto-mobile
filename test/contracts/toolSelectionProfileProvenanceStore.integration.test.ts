import { ToolSelectionProfileProvenanceRepository } from "../../src/db/toolSelectionProfileProvenanceRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeToolSelectionProfileProvenanceStore } from "../fakes/FakeToolSelectionProfileProvenanceStore";
import { runToolSelectionProfileProvenanceStoreContract } from "./ToolSelectionProfileProvenanceStoreContract";

// The real repository runs over createTestDatabase() (in-memory SQLite), never the
// file-backed database (#11868).
runToolSelectionProfileProvenanceStoreContract(
  "FakeToolSelectionProfileProvenanceStore",
  async () => ({ store: new FakeToolSelectionProfileProvenanceStore() }),
);
runToolSelectionProfileProvenanceStoreContract(
  "ToolSelectionProfileProvenanceRepository",
  async () => {
    const db = await createTestDatabase();
    return {
      store: new ToolSelectionProfileProvenanceRepository({ db }),
      dispose: () => db.destroy(),
    };
  },
);
