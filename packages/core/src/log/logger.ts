/**
 * The engine's log: a small rotating file in the project's state folder, readable by the user
 * through "Show log" and never containing a real value from PRIVATE.md (REQ-17.0.4, REQ-17.3).
 */
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { createRedactor, type PlaceholderMap } from "./redact.js";

export type LogLevel = "info" | "warn" | "error";

/** Writes redacted log lines. */
export interface Logger {
  info(message: string): Promise<void>;
  warn(message: string): Promise<void>;
  error(message: string): Promise<void>;
}

/** Options for `createFileLogger`. */
export interface FileLoggerOptions {
  /** Folder that holds the log files. */
  readonly dir: string;
  /** Returns the current PRIVATE.md mapping, read at each write since PRIVATE.md can change. */
  readonly mapping: () => PlaceholderMap | null;
  /** Size at which the current file is rotated. */
  readonly maxBytes?: number;
  /** How many rotated files to keep besides the current one. */
  readonly keep?: number;
  readonly now?: () => Date;
}

/** Name of the current log file. */
export const LOG_FILE = "project-docs.log";

/** Creates a logger that appends to `<dir>/project-docs.log`, rotating it as it grows. */
export function createFileLogger(options: FileLoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const keep = options.keep ?? 3;
  const now = options.now ?? (() => new Date());
  const file = path.join(options.dir, LOG_FILE);
  // Writes are chained so lines from concurrent calls never interleave or race a rotation.
  let queue: Promise<void> = Promise.resolve();

  async function rotateIfNeeded(): Promise<void> {
    const size = (await stat(file).catch(() => null))?.size ?? 0;
    if (size < maxBytes) return;
    await rm(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => undefined);
    }
    await rename(file, `${file}.1`);
  }

  function write(level: LogLevel, message: string): Promise<void> {
    const redact = createRedactor(options.mapping());
    // One line per entry: a message's own line breaks become spaces, so entries stay parseable.
    const line = `${now().toISOString()} ${level.toUpperCase()} ${redact(message).replace(/\r?\n/g, " ")}\n`;
    queue = queue.then(async () => {
      await mkdir(options.dir, { recursive: true });
      await rotateIfNeeded();
      await appendFile(file, line, "utf8");
    });
    return queue;
  }

  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}
