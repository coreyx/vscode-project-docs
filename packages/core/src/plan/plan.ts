/**
 * The planner (design decision 1): decides everything a sync pass does, from the two snapshots,
 * the index, the rules and the guards, without touching either folder. Being a pure function of
 * its inputs (plus injected readers) is what lets the property-based tests drive it with random
 * histories, lets the bulk guard see a whole pass before anything happens, and makes the CLI's
 * `status` simply "plan, don't execute".
 *
 * The decision table follows design.md (Interfaces, "Planner decision table"). Two principles
 * shape every branch:
 *  - Nothing is ever discarded: whatever a write replaces is either merged in, kept as a conflict,
 *    or moved to a trash by an explicit `trash` action.
 *  - Nothing private reaches the repo: every change heading there passes the guards first.
 */
import { checkVaultChange, inPrivateSubfolder, type GuardReason } from "../guards/index.js";
import { convertWikilinks } from "../links/index.js";
import { mergeText } from "../merge/index.js";
import { checkPortable, findCaseClashes } from "../paths/index.js";
import { isInvalidRule, readRule, type SyncRule } from "../rules/index.js";
import {
  isNeverSynced,
  markdownHash,
  toLf,
  type LineEnding,
  type SnapshotEntry,
} from "../scan/index.js";
import type { Side } from "../sidefs/index.js";
import type { IndexEntry } from "../state/index.js";
import type {
  Action,
  BulkCheck,
  IndexUpdate,
  Notice,
  Plan,
  PlanInput,
  SideTraits,
} from "./types.js";

/** States whose `baseHash` is content both sides agreed on, so a missing file means a delete. */
const AGREED = new Set<IndexEntry["state"]>(["synced", "heldBack", "conflict"]);

/** True when an index entry records content both sides once agreed on. */
export function hasAgreedBase(entry: IndexEntry | undefined): entry is IndexEntry {
  return entry !== undefined && AGREED.has(entry.state) && entry.baseHash !== "";
}

const other = (side: Side): Side => (side === "repo" ? "vault" : "repo");

/** The line ending to write to a side: what the file there uses, what was recorded, or the side's default. */
function lineEndingFor(
  existing: SnapshotEntry | undefined,
  recorded: LineEnding | undefined,
  traits: SideTraits,
): LineEnding {
  if (existing && existing.lineEnding !== "none") return existing.lineEnding;
  if (recorded && recorded !== "none") return recorded;
  return traits.isWindowsFs ? "crlf" : "lf";
}

function reasonsOf(reasons: readonly GuardReason[]): string[] {
  return reasons.map((r) => r.message);
}

/** Plans one sync pass. */
export async function plan(input: PlanInput): Promise<Plan> {
  return new Planner(input).run();
}

class Planner {
  private readonly actions: Action[] = [];
  private readonly notices: Notice[] = [];
  /** Vault Markdown text read this pass, by key. */
  private readonly vaultTexts = new Map<string, string>();
  /** Vault notes found to carry the `private` marker this pass. */
  private readonly markedPrivate = new Set<string>();
  /** Keys handled as part of a rename, or excluded, and so not planned again on their own. */
  private readonly handled = new Set<string>();
  /** Snapshot entries moved by a rename, as seen from the renamed-to key. */
  private readonly moved = new Map<
    string,
    {
      repo?: SnapshotEntry;
      vault?: SnapshotEntry;
      base: IndexEntry;
      /** Where the not-yet-renamed side's file still is while planning. */
      sourceKeys: { repo: string; vault: string };
    }
  >();

  constructor(private readonly input: PlanInput) {}

  private traits(side: Side): SideTraits {
    return side === "repo" ? this.input.repoTraits : this.input.vaultTraits;
  }

  private snapshot(side: Side) {
    return side === "repo" ? this.input.repo.entries : this.input.vault.entries;
  }

  private entry(key: string): IndexEntry | undefined {
    return this.input.index.entries[key];
  }

  async run(): Promise<Plan> {
    for (const snapshot of [this.input.repo, this.input.vault]) {
      for (const skipped of snapshot.skipped) {
        this.notices.push({ key: skipped.key, code: "scan-skipped", message: skipped.message });
      }
    }
    await this.readChangedVaultNotes();
    this.excludeCaseClashes();
    this.detectRenames();

    const keys = new Set<string>([
      ...Object.keys(this.input.index.entries),
      ...this.snapshot("repo").keys(),
      ...this.snapshot("vault").keys(),
      ...this.moved.keys(),
    ]);
    for (const key of [...keys].sort()) {
      if (this.handled.has(key) && !this.moved.has(key)) continue;
      await this.planKey(key);
    }
    return { actions: this.actions, notices: this.notices, bulk: this.bulkCheck() };
  }

  /** Reads vault notes that are new or changed, so rules and private markers are known up front. */
  private async readChangedVaultNotes(): Promise<void> {
    for (const [key, v] of this.snapshot("vault")) {
      if (v.kind !== "markdown") continue;
      const known = this.entry(key);
      if (known && known.baseHash === v.hash) {
        if (
          known.state === "vaultOnly" &&
          known.reasons.some((r) => r.includes("marked private"))
        ) {
          this.markedPrivate.add(key);
        }
        continue;
      }
      const text = await this.input.readText("vault", key);
      if (text === null) continue;
      this.vaultTexts.set(key, text);
      if (readRule(text) === "private") this.markedPrivate.add(key);
    }
  }

  /** The path a key's file has on a side right now: a rename planned this pass hasn't happened yet. */
  private sourceKey(side: Side, key: string): string {
    return this.moved.get(key)?.sourceKeys[side] ?? key;
  }

  private readSide(side: Side, key: string): Promise<string | null> {
    return this.input.readText(side, this.sourceKey(side, key));
  }

  private async vaultText(key: string): Promise<string | null> {
    const path = this.sourceKey("vault", key);
    const cached = this.vaultTexts.get(path);
    if (cached !== undefined) return cached;
    const text = await this.input.readText("vault", path);
    if (text !== null) this.vaultTexts.set(path, text);
    return text;
  }

  /** Files that differ only by case can't both exist on a case-insensitive side (REQ-16.0.3). */
  private excludeCaseClashes(): void {
    for (const side of ["repo", "vault"] as const) {
      if (!this.traits(other(side)).caseInsensitive) continue;
      for (const group of findCaseClashes(this.snapshot(side).keys())) {
        for (const key of group) {
          this.handled.add(key);
          this.notices.push({
            key,
            code: "case-clash",
            message: `${group.join(" and ")} differ only by letter case, which the ${other(side)} side can't hold apart; neither is synced`,
          });
        }
      }
    }
  }

  /**
   * Finds renames on each side (design decision 3): a key with an agreed base that disappeared,
   * and a new key with exactly that base's content.
   */
  private detectRenames(): void {
    for (const side of ["repo", "vault"] as const) {
      const files = this.snapshot(side);
      const otherFiles = this.snapshot(other(side));
      const gone = new Map<string, string[]>();
      for (const [key, entry] of Object.entries(this.input.index.entries)) {
        if (
          hasAgreedBase(entry) &&
          entry.state === "synced" &&
          !files.has(key) &&
          !this.handled.has(key)
        ) {
          gone.set(entry.baseHash, [...(gone.get(entry.baseHash) ?? []), key]);
        }
      }
      if (gone.size === 0) continue;
      for (const [to, file] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (hasAgreedBase(this.entry(to)) || this.handled.has(to) || otherFiles.has(to)) continue;
        const candidates = gone.get(file.hash);
        const from = candidates?.shift();
        if (from === undefined) continue;
        const base = this.entry(from) as IndexEntry;
        const otherFile = otherFiles.get(from);
        this.handled.add(from);
        this.handled.add(to);

        if (side === "vault" && this.vaultOnlyByPath(to)) {
          // Moved into the private folder: the note becomes vault-only, and the repo copy is left
          // where it is rather than renamed, which would publish its new, private path.
          this.detach(from, base, otherFile);
          this.handled.delete(to);
          continue;
        }
        if (!otherFile) {
          // Gone from the other side too: nothing to rename there; the renamed file is new to it.
          this.record(from, null);
          this.handled.delete(to);
          continue;
        }
        const problem = checkPortable(to, this.traits(other(side)).isWindowsFs);
        if (problem) {
          this.notPortable(to, problem.message);
          continue;
        }
        const update = { key: to, entry: { ...base, key: to } };
        this.actions.push({ type: "rename", side: other(side), from, to, update, removeKey: from });
        this.moved.set(
          to,
          side === "repo"
            ? {
                repo: file,
                vault: otherFile,
                base: { ...base, key: to },
                sourceKeys: { repo: to, vault: from },
              }
            : {
                repo: otherFile,
                vault: file,
                base: { ...base, key: to },
                sourceKeys: { repo: from, vault: to },
              },
        );
      }
    }
  }

  /** True for vault keys that are vault-only by location or name alone. */
  private vaultOnlyByPath(key: string): boolean {
    return (
      isNeverSynced(key) ||
      key === this.input.linkNoteKey ||
      inPrivateSubfolder(key, this.input.settings.privateSubfolder)
    );
  }

  private detach(key: string, base: IndexEntry, repoFile: SnapshotEntry | undefined): void {
    if (!repoFile) {
      this.record(key, null);
      return;
    }
    this.record(key, {
      ...base,
      state: "detached",
      reasons: ["the note became private; the repo copy is no longer synced"],
    });
    this.notices.push({
      key,
      code: "no-longer-synced",
      message: `${key} became private in the vault, so its repo copy is no longer synced; move the repo copy to the trash if it shouldn't stay`,
    });
  }

  private record(key: string, entry: IndexEntry | null): void {
    this.actions.push({ type: "record", key, update: { key, entry } });
  }

  private notPortable(key: string, message: string): void {
    this.handled.add(key);
    this.notices.push({ key, code: "not-portable", message });
  }

  private isPrivateNote = (key: string): boolean => {
    if (this.markedPrivate.has(key)) return true;
    const known = this.entry(key);
    return known?.state === "vaultOnly" && known.reasons.some((r) => r.includes("marked private"));
  };

  /** Converts wikilinks and runs the guards on a vault change headed for the repo. */
  private guardVault(key: string, file: SnapshotEntry, text: string | undefined) {
    let converted = text;
    if (file.kind === "markdown" && text !== undefined) {
      const conversion = convertWikilinks(text, key, this.input.resolver, {
        keepLinksAsWritten: this.input.settings.keepLinksAsWritten,
      });
      converted = conversion.text;
      const unconvertible = conversion.unconvertible.filter(
        (u) => u.reason !== "the target is outside the project folder",
      );
      if (unconvertible.length > 0) {
        this.notices.push({
          key,
          code: "unconvertible-links",
          message: `${key} has links that stay as written, since they have no Markdown equivalent`,
          reasons: unconvertible.map((u) => `${u.link.raw}: ${u.reason}`),
        });
      }
    }
    const verdict = checkVaultChange(
      {
        key,
        kind: file.kind,
        hash: converted === undefined ? file.hash : markdownHash(converted),
        text: converted,
      },
      {
        privateSubfolder: this.input.settings.privateSubfolder,
        linkNoteKey: this.input.linkNoteKey,
        privateFiles: this.input.privateFiles,
        allowLinksOutside: this.input.settings.allowLinksOutsideProjectFolder,
        mapping: this.input.mapping,
        resolver: this.input.resolver,
        isPrivateNote: this.isPrivateNote,
      },
    );
    return { verdict, converted };
  }

  private async repoRule(key: string, file: SnapshotEntry): Promise<SyncRule | "invalid" | "gone"> {
    if (file.kind !== "markdown") return "sync";
    const text = await this.readSide("repo", key);
    if (text === null) return "gone";
    const rule = readRule(text);
    if (isInvalidRule(rule)) {
      this.notices.push({ key, code: "invalid-rule", message: `${key}: ${rule.message}` });
      return "invalid";
    }
    return rule;
  }

  private vaultRule(key: string, text: string | undefined): SyncRule | "invalid" {
    if (text === undefined) return "sync";
    const rule = readRule(text);
    if (isInvalidRule(rule)) {
      this.notices.push({ key, code: "invalid-rule", message: `${key}: ${rule.message}` });
      return "invalid";
    }
    return rule;
  }

  private synced(
    key: string,
    kind: "markdown" | "attachment",
    hash: string,
    repoLineEnding: LineEnding,
    vaultLineEnding: LineEnding,
  ): IndexEntry {
    return {
      key,
      kind,
      baseHash: hash,
      repoLineEnding,
      vaultLineEnding,
      state: "synced",
      reasons: [],
    };
  }

  private copy(key: string, from: Side, file: SnapshotEntry, base: IndexEntry | undefined): void {
    const to = other(from);
    const target = this.files(key)[to];
    const problem = checkPortable(key, this.traits(to).isWindowsFs);
    if (problem) {
      this.notPortable(key, problem.message);
      this.record(key, base ?? null);
      return;
    }
    const recorded = to === "repo" ? base?.repoLineEnding : base?.vaultLineEnding;
    const targetLineEnding = lineEndingFor(target, recorded, this.traits(to));
    const entry =
      from === "repo"
        ? this.synced(key, file.kind, file.hash, file.lineEnding, targetLineEnding)
        : this.synced(key, file.kind, file.hash, targetLineEnding, file.lineEnding);
    const update: IndexUpdate = { key, entry };
    this.actions.push({
      type: "copy",
      key,
      from,
      kind: file.kind,
      hash: file.hash,
      targetLineEnding,
      overwrites: target !== undefined && target.hash !== file.hash,
      expectTargetHash: target?.hash ?? null,
      update,
    });
  }

  private writeBoth(
    key: string,
    text: string,
    base: IndexEntry | undefined,
    expectRepoHash: string | null,
    expectVaultHash: string | null,
  ): void {
    for (const side of ["repo", "vault"] as const) {
      const problem = checkPortable(key, this.traits(side).isWindowsFs);
      if (problem) {
        this.notPortable(key, problem.message);
        this.record(key, base ?? null);
        return;
      }
    }
    const lf = toLf(text);
    const hash = markdownHash(lf);
    const { repo, vault } = this.files(key);
    const repoLineEnding = lineEndingFor(repo, base?.repoLineEnding, this.input.repoTraits);
    const vaultLineEnding = lineEndingFor(vault, base?.vaultLineEnding, this.input.vaultTraits);
    this.actions.push({
      type: "writeBoth",
      key,
      text: lf,
      hash,
      repoLineEnding,
      vaultLineEnding,
      expectRepoHash,
      expectVaultHash,
      overwrites: [repo, vault].some((f) => f !== undefined && f.hash !== hash),
      update: { key, entry: this.synced(key, "markdown", hash, repoLineEnding, vaultLineEnding) },
    });
  }

  private conflict(
    key: string,
    repo: SnapshotEntry,
    vault: SnapshotEntry,
    base: IndexEntry | undefined,
  ): void {
    const entry: IndexEntry = {
      key,
      kind: repo.kind,
      baseHash: base?.baseHash ?? "",
      repoLineEnding: repo.lineEnding,
      vaultLineEnding: vault.lineEnding,
      state: "conflict",
      reasons: ["edited differently on both sides"],
    };
    this.actions.push({
      type: "conflict",
      key,
      kind: repo.kind,
      repoHash: repo.hash,
      vaultHash: vault.hash,
      baseHash: base?.baseHash || null,
      vaultLineEnding: lineEndingFor(vault, base?.vaultLineEnding, this.input.vaultTraits),
      update: { key, entry },
    });
    this.notices.push({
      key,
      code: "conflict",
      message: `${key} was edited differently in VS Code and Obsidian; the repo's version is in place and the vault's is kept for you to merge`,
    });
  }

  private holdBack(
    key: string,
    base: IndexEntry | undefined,
    vault: SnapshotEntry,
    reasons: readonly GuardReason[],
    repoChanged: boolean,
  ): void {
    const messages = reasonsOf(reasons);
    if (repoChanged)
      messages.push("the repo copy has also changed; it syncs once the vault copy can");
    this.record(key, {
      key,
      kind: vault.kind,
      baseHash: base && hasAgreedBase(base) ? base.baseHash : "",
      repoLineEnding: base?.repoLineEnding ?? "none",
      vaultLineEnding: vault.lineEnding,
      state: "heldBack",
      reasons: messages,
    });
    this.notices.push({
      key,
      code: "held-back",
      message: `${key} isn't synced to the repo until this is fixed`,
      reasons: messages,
      ...(reasons.some((r) => r.code === "real-value")
        ? { fix: "replace-real-values" as const }
        : {}),
    });
  }

  private vaultOnly(
    key: string,
    vault: SnapshotEntry,
    reasons: readonly GuardReason[],
    repo: SnapshotEntry | undefined,
  ): void {
    this.record(key, {
      key,
      kind: vault.kind,
      baseHash: vault.hash,
      repoLineEnding: "none",
      vaultLineEnding: vault.lineEnding,
      state: "vaultOnly",
      reasons: reasonsOf(reasons),
    });
    if (repo) {
      this.notices.push({
        key,
        code: "no-longer-synced",
        message: `${key} is private in the vault, so the repo's copy isn't synced; move the repo copy to the trash if it shouldn't stay`,
      });
    }
  }

  private files(key: string): {
    repo?: SnapshotEntry | undefined;
    vault?: SnapshotEntry | undefined;
  } {
    const moved = this.moved.get(key);
    if (moved) return { repo: moved.repo, vault: moved.vault };
    return { repo: this.snapshot("repo").get(key), vault: this.snapshot("vault").get(key) };
  }

  private async planKey(key: string): Promise<void> {
    const base = this.moved.get(key)?.base ?? this.entry(key);
    const { repo, vault } = this.files(key);

    if (base?.state === "conflict") {
      // Frozen until the user resolves it (REQ-5.0.5).
      this.notices.push({ key, code: "conflict", message: `${key} has an unresolved conflict` });
      return;
    }
    if (base?.state === "detached") {
      if (!repo) this.record(key, null);
      else
        this.notices.push({
          key,
          code: "no-longer-synced",
          message: base.reasons[0] ?? `${key} is no longer synced`,
        });
      return;
    }
    if (base?.state === "vaultOnly" && vault && vault.hash === base.baseHash) {
      // An unchanged private vault file: nothing to read or do.
      if (repo)
        this.notices.push({
          key,
          code: "no-longer-synced",
          message: `${key} is private in the vault, so the repo's copy isn't synced`,
        });
      return;
    }
    if (!hasAgreedBase(base)) {
      await this.planNew(key, base, repo, vault);
      return;
    }
    await this.planKnown(key, base, repo, vault);
  }

  /** A key with no agreed base: a new file, or one that was skipped or vault-only. */
  private async planNew(
    key: string,
    base: IndexEntry | undefined,
    repo: SnapshotEntry | undefined,
    vault: SnapshotEntry | undefined,
  ): Promise<void> {
    if (!repo && !vault) {
      if (base) this.record(key, null);
      return;
    }
    if (repo && !vault) {
      const rule = await this.repoRule(key, repo);
      if (rule === "gone") return;
      if (rule === "invalid" || rule === "repo-only" || rule === "private") {
        this.record(key, {
          key,
          kind: repo.kind,
          baseHash: "",
          repoLineEnding: repo.lineEnding,
          vaultLineEnding: "none",
          state: "skipped",
          reasons: [rule === "invalid" ? "invalid sync rule" : `marked ${rule}`],
        });
        return;
      }
      this.copy(key, "repo", repo, base);
      return;
    }
    const v = vault as SnapshotEntry;
    const text = v.kind === "markdown" ? ((await this.vaultText(key)) ?? undefined) : undefined;
    if (v.kind === "markdown" && text === undefined) return;
    if (this.vaultRule(key, text) === "invalid") {
      this.record(key, {
        key,
        kind: v.kind,
        baseHash: "",
        repoLineEnding: "none",
        vaultLineEnding: v.lineEnding,
        state: "skipped",
        reasons: ["invalid sync rule"],
      });
      return;
    }
    const { verdict, converted } = this.guardVault(key, v, text);
    if (verdict.action === "vaultOnly") {
      this.vaultOnly(key, v, verdict.reasons, repo);
      return;
    }
    if (verdict.action === "holdBack") {
      this.holdBack(key, undefined, v, verdict.reasons, false);
      return;
    }
    if (!repo) {
      if (converted !== undefined && converted !== text)
        this.writeBoth(key, converted, base, null, v.hash);
      else this.copy(key, "vault", v, base);
      return;
    }
    // Both sides have a file with no agreed base: the first sync of a linked folder (REQ-1.0.3).
    if (repo.hash === v.hash) {
      this.actions.push({
        type: "adopt",
        key,
        update: {
          key,
          entry: this.synced(key, repo.kind, repo.hash, repo.lineEnding, v.lineEnding),
        },
      });
      return;
    }
    const rule = await this.repoRule(key, repo);
    if (rule === "gone") return;
    if (rule === "invalid" || rule === "repo-only" || rule === "private") {
      this.notices.push({
        key,
        code: "repo-only-vault-copy",
        message: `${key} isn't synced to the vault, but the vault has a copy; move the vault copy to the trash if it shouldn't stay`,
      });
      this.record(key, {
        key,
        kind: repo.kind,
        baseHash: "",
        repoLineEnding: repo.lineEnding,
        vaultLineEnding: v.lineEnding,
        state: "skipped",
        reasons: [`marked ${rule}`],
      });
      return;
    }
    if (converted !== undefined && converted !== text && markdownHash(converted) === repo.hash) {
      // The only difference was wikilinks, which conversion resolves.
      this.writeBoth(key, converted, base, repo.hash, v.hash);
      return;
    }
    this.conflict(key, repo, v, undefined);
  }

  /** A key whose content both sides agreed on at some point: the decision table proper. */
  private async planKnown(
    key: string,
    base: IndexEntry,
    repo: SnapshotEntry | undefined,
    vault: SnapshotEntry | undefined,
  ): Promise<void> {
    const repoState = !repo ? "deleted" : repo.hash === base.baseHash ? "same" : "changed";
    const vaultState = !vault ? "deleted" : vault.hash === base.baseHash ? "same" : "changed";

    if (repoState === "same" && vaultState === "same") {
      if (base.state === "heldBack") this.record(key, { ...base, state: "synced", reasons: [] });
      return;
    }
    if (repoState === "deleted" && vaultState === "deleted") {
      this.record(key, null);
      return;
    }
    if (repoState === "deleted" && vaultState === "same") {
      const v = vault as SnapshotEntry;
      this.actions.push({
        type: "trash",
        side: "vault",
        key,
        hash: v.hash,
        update: { key, entry: null },
      });
      return;
    }
    if (repoState === "same" && vaultState === "deleted") {
      const r = repo as SnapshotEntry;
      this.actions.push({
        type: "trash",
        side: "repo",
        key,
        hash: r.hash,
        update: { key, entry: null },
      });
      return;
    }
    if (vaultState === "same" || (repoState === "changed" && vaultState === "deleted")) {
      await this.repoChanged(key, base, repo as SnapshotEntry, vault, vaultState === "deleted");
      return;
    }
    await this.vaultChanged(key, base, repo, vault as SnapshotEntry, repoState);
  }

  /** The repo changed and the vault didn't (or deleted it). */
  private async repoChanged(
    key: string,
    base: IndexEntry,
    repo: SnapshotEntry,
    vault: SnapshotEntry | undefined,
    vaultDeleted: boolean,
  ): Promise<void> {
    const rule = await this.repoRule(key, repo);
    if (rule === "gone") return;
    if (rule === "invalid" || rule === "repo-only" || rule === "private") {
      if (vault) {
        this.notices.push({
          key,
          code: "repo-only-vault-copy",
          message: `${key} is no longer synced to the vault; move the vault copy to the trash if it shouldn't stay`,
        });
      }
      this.record(key, { ...base, state: "skipped", baseHash: "", reasons: [`marked ${rule}`] });
      return;
    }
    if (vaultDeleted) {
      this.notices.push({
        key,
        code: "delete-overridden",
        message: `${key} was deleted in the vault but changed in the repo, so it was kept`,
      });
    }
    if (base.state === "heldBack" && vault && vault.hash !== base.baseHash) return;
    this.copy(key, "repo", repo, base);
  }

  /** The vault changed; the repo is unchanged, changed, or deleted. */
  private async vaultChanged(
    key: string,
    base: IndexEntry,
    repo: SnapshotEntry | undefined,
    vault: SnapshotEntry,
    repoState: "same" | "changed" | "deleted",
  ): Promise<void> {
    const text = vault.kind === "markdown" ? ((await this.vaultText(key)) ?? undefined) : undefined;
    if (vault.kind === "markdown" && text === undefined) return;
    const vaultRule = this.vaultRule(key, text);
    if (vaultRule === "invalid") {
      this.record(key, { ...base, state: "skipped", baseHash: "", reasons: ["invalid sync rule"] });
      return;
    }
    if (repoState === "changed" && repo && repo.hash === vault.hash) {
      this.actions.push({
        type: "adopt",
        key,
        update: {
          key,
          entry: this.synced(key, vault.kind, vault.hash, repo.lineEnding, vault.lineEnding),
        },
      });
      return;
    }
    const { verdict, converted } = this.guardVault(key, vault, text);
    if (verdict.action === "vaultOnly") {
      this.vaultOnly(key, vault, verdict.reasons, repo);
      return;
    }
    if (vaultRule === "repo-to-vault" || vaultRule === "repo-only") {
      // The repo is authoritative for this file: the vault edit isn't sent (REQ-8.3).
      if (repoState === "changed" && repo) {
        this.conflict(key, repo, vault, base);
        return;
      }
      this.notices.push({
        key,
        code: "repo-to-vault-edit",
        message: `${key} syncs from the repo only, so the vault edit wasn't sent; it's kept as a conflict if the repo changes`,
      });
      return;
    }
    if (verdict.action === "holdBack") {
      this.holdBack(key, base, vault, verdict.reasons, repoState === "changed");
      return;
    }
    if (repoState === "deleted") {
      this.notices.push({
        key,
        code: "delete-overridden",
        message: `${key} was deleted in the repo but changed in the vault, so it was kept`,
      });
    }
    if (repoState !== "changed" || !repo) {
      if (converted !== undefined && converted !== text) {
        this.writeBoth(key, converted, base, repo?.hash ?? null, vault.hash);
      } else {
        this.copy(key, "vault", vault, base);
      }
      return;
    }
    // Both changed, differently.
    if (vault.kind !== "markdown") {
      this.conflict(key, repo, vault, base);
      return;
    }
    const rule = await this.repoRule(key, repo);
    if (rule === "gone") return;
    if (rule === "repo-to-vault") {
      this.conflict(key, repo, vault, base);
      return;
    }
    const [baseText, repoText] = await Promise.all([
      this.input.readBase(base.baseHash),
      this.readSide("repo", key),
    ]);
    if (repoText === null) return;
    if (baseText === null) {
      this.conflict(key, repo, vault, base);
      return;
    }
    const merged = mergeText(baseText, repoText, converted ?? "");
    if (merged.clean) this.writeBoth(key, merged.text, base, repo.hash, vault.hash);
    else this.conflict(key, repo, vault, base);
  }

  /** Counts the actions that delete or overwrite, against REQ-7's threshold. */
  private bulkCheck(): BulkCheck {
    const destructive = this.actions.filter(
      (a) =>
        a.type === "trash" ||
        a.type === "conflict" ||
        ((a.type === "copy" || a.type === "writeBoth") && a.overwrites),
    ).length;
    const linked = new Set([...this.snapshot("repo").keys(), ...this.snapshot("vault").keys()])
      .size;
    const threshold = Math.min(20, Math.ceil(linked * 0.25));
    return { destructive, threshold, guarded: destructive > threshold };
  }
}
