import { createMemoryStore } from "../src/lib/memory-store.js";
import { runStoreContract } from "./store-contract.js";

runStoreContract("memory", () => createMemoryStore());
