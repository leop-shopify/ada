import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "ada-test-"));
process.env.HOME = tempHome;
mkdirSync(join(tempHome, ".pi", "agent", "ada"), { recursive: true });
mkdirSync(join(tempHome, ".pi", "agent", "ada", "artifacts"), { recursive: true });
mkdirSync(join(tempHome, ".pi", "agent", "ada", "locks"), { recursive: true });
mkdirSync(join(tempHome, ".pi", "agent", "artifacts"), { recursive: true });
