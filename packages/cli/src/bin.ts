/** Executable entry: kept separate from `main.ts` so tests can import `main` without running it. */
import { main } from "./main.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
