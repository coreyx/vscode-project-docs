/**
 * Polling for changes where native file watching is unreliable (REQ-4.0.2): a Windows drive seen
 * from WSL (`/mnt/c`), and network drives. Every interval it lists the side and compares each
 * file's size and modification time with the previous listing; nothing is read or hashed.
 */
import type { SideFs } from "../sidefs/index.js";

/** Default polling interval: changes are noticed within 5 s, well inside REQ-4.0.2's 10 s. */
export const POLL_INTERVAL_MS = 5_000;

/** Takes one listing of a side: key -> "size:mtime". */
async function fingerprint(
  fs: SideFs,
  skipFolder: (key: string) => boolean,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for await (const entry of fs.list(skipFolder))
    result.set(entry.key, `${entry.size}:${entry.mtimeMs}`);
  return result;
}

/** Compares two listings and returns the keys that were added, changed or removed. */
export function diffListings(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const changed: string[] = [];
  for (const [key, value] of after) if (before.get(key) !== value) changed.push(key);
  for (const key of before.keys()) if (!after.has(key)) changed.push(key);
  return changed.sort();
}

/** Options for `startPolling`. */
export interface PollOptions {
  readonly intervalMs?: number;
  readonly skipFolder?: (key: string) => boolean;
  /** Called with the changed keys whenever a poll finds any. */
  readonly onChange: (keys: string[]) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Starts polling a side. Returns a function that stops it. Polls never overlap: a slow listing
 * delays the next poll rather than running two at once.
 */
export function startPolling(fs: SideFs, options: PollOptions): () => void {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  const skip = options.skipFolder ?? (() => false);
  let previous: Map<string, string> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    try {
      const current = await fingerprint(fs, skip);
      if (previous) {
        const changed = diffListings(previous, current);
        if (changed.length > 0) options.onChange(changed);
      }
      previous = current;
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void poll(), interval);
  };
  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
