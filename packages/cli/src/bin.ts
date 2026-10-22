/** Executable entry: kept separate from `main.ts` so tests can import `main` without running it. */
import { main } from "./main.js";

process.exitCode = main(process.argv.slice(2));
