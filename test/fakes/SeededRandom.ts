/**
 * The deterministic {@link Random} lives in `src/utils` because the mock backend replays seeded
 * runs in production; tests keep importing it from here.
 */
export { SeededRandom } from "../../src/utils/SeededRandom";
