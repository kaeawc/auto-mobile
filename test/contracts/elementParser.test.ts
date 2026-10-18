import { DefaultElementParser } from "../../src/features/utility/ElementParser";
import { FakeElementParser } from "../fakes/FakeElementParser";
import { runElementParserContract } from "./ElementParserContract";

runElementParserContract("DefaultElementParser", () => new DefaultElementParser());
runElementParserContract("FakeElementParser", () => new FakeElementParser());
