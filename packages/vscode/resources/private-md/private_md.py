#!/usr/bin/env python3
"""Reference implementation of the PRIVATE.md standard.

Tracked docs hold placeholders (``myhost``, ``example.ts.net``, ``100.64.0.x``, ...) in place of a
deployment's real hostnames, IPs and paths. The gitignored PRIVATE.md at the repo root maps each
placeholder to its real value in the table under its ``## Placeholders`` heading. This module
decodes ("restores") a doc with that mapping. The standard itself is README.md at
https://github.com/coreyx/private-md-standard.

It also checks that real values haven't slipped into tracked files or commit messages.

Usage:
    python private_md.py restore DOC [DOC ...] [--private PATH] [-o OUT|-]
    python private_md.py check                     # staged files (the pre-commit hook)
    python private_md.py check --message FILE      # a commit message (the commit-msg hook)
    python private_md.py check --paths FILE ...    # working-tree files, before staging
    python private_md.py check --history           # every file and message in every commit
    python private_md.py install-hooks [REPO]      # copy the tools into a repo and wire up hooks
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable

# Checked before anything else runs, so an old interpreter gets a clear message instead of a
# traceback from newer syntax further down.
if sys.version_info < (3, 10):
    sys.exit("private_md.py needs Python 3.10 or newer")

import re
import subprocess
from pathlib import Path

PLACEHOLDER_HEADING = "## Placeholders"
# \r?\n because sources are read with their line endings intact, and a Windows checkout can be CRLF.
PUBLIC_ONLY_BLOCK = re.compile(
    r"^<!-- public-only -->\r?\n.*?^<!-- /public-only -->\r?\n(?:\r?\n)?", re.M | re.S
)
# A letter or digit in any script: word characters minus the underscore. Same set as str.isalnum(),
# so the test for whether an end needs a boundary and the boundary itself agree.
ALNUM = r"[^\W_]"
# A Markdown code span: a run of backticks, the content, then the same run again.
CODE_SPAN = re.compile(r"^(`+)(.*?)\1$", re.S)
# The commit check skips real values shorter than this, because they would match ordinary words.
MIN_CHECK_LENGTH = 4


class PrivateMdError(Exception):
    """A condition the standard treats as a hard error (§7): no output may be produced.

    ``kind`` is a stable identifier that tests and the conformance cases assert on; ``message`` is
    for people. The standard's own errors are ``missing-file``, ``no-section``, ``no-rows`` and
    ``duplicate``; the command-line tools add ``no-repo``, ``usage`` and ``unsafe-output``.
    """

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def parse_code_span(cell: str) -> str | None:
    """Return the literal text of a table cell that is exactly one code span, else None.

    Follows CommonMark: when the content is padded with one space on each side (needed when it
    starts or ends with a backtick, as in ``` `` a `b` `` ```), that one space is stripped.
    """
    match = CODE_SPAN.match(cell.strip())
    if not match:
        return None
    text = match.group(2)
    if len(text) >= 2 and text.startswith(" ") and text.endswith(" ") and text.strip():
        text = text[1:-1]
    return text


def load_placeholders(private_md: Path) -> dict[str, str]:
    """Read the placeholder -> real value table under PRIVATE.md's ``## Placeholders`` heading.

    Only rows whose first two cells are both code spans count, so the header and separator rows
    are skipped. Raises PrivateMdError when the file, the section or the table is missing, or when a
    placeholder is listed twice, because a silently partial mapping would leave placeholders in the
    output.
    """
    if not private_md.is_file():
        raise PrivateMdError(
            "missing-file",
            f"{private_md} not found: it's gitignored, so restore it from wherever you keep it",
        )
    lines = private_md.read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index(PLACEHOLDER_HEADING) + 1
    except ValueError:
        raise PrivateMdError("no-section", f"{private_md}: no '{PLACEHOLDER_HEADING}' section") from None

    mapping: dict[str, str] = {}
    for line in lines[start:]:
        if line.startswith("## "):
            break
        if not line.startswith("|"):
            continue
        # A plain split on '|': the standard forbids a pipe in placeholder and real-value cells.
        cells = line.strip().strip("|").split("|")
        if len(cells) < 2:
            continue
        placeholder, real = parse_code_span(cells[0]), parse_code_span(cells[1])
        if not placeholder or real is None:
            continue
        if placeholder in mapping:
            raise PrivateMdError("duplicate", f"{private_md}: placeholder {placeholder!r} is listed twice")
        mapping[placeholder] = real

    if not mapping:
        raise PrivateMdError("no-rows", f"{private_md}: no placeholder rows under '{PLACEHOLDER_HEADING}'")
    return mapping


def placeholder_pattern(placeholder: str) -> str:
    """Regex for one placeholder that won't match inside a longer word or number.

    A boundary is only enforced on an end that is a letter or digit, so ``100.64.0.1`` doesn't
    match the start of ``100.64.0.10`` and ``myhost`` doesn't match inside ``notmyhost``, while
    ``example.ts.net`` still matches after ``nas.``.
    """
    pattern = re.escape(placeholder)
    if placeholder[0].isalnum():
        pattern = f"(?<!{ALNUM})" + pattern
    if placeholder[-1].isalnum():
        pattern += f"(?!{ALNUM})"
    return pattern


def restore(text: str, mapping: dict[str, str]) -> str:
    """Drop public-only blocks, then replace every placeholder with its real value in one pass.

    A single alternation (longest placeholder first) means replaced text is never scanned again,
    so a real value that happens to contain another placeholder stays intact.
    """
    text = PUBLIC_ONLY_BLOCK.sub("", text)
    ordered = sorted(mapping, key=len, reverse=True)
    combined = re.compile("|".join(f"({placeholder_pattern(p)})" for p in ordered))
    return combined.sub(lambda m: mapping[ordered[m.lastindex - 1]], text)


def find_repo_root(start: Path) -> Path:
    """Return the root of the git repository containing ``start`` (a file or a folder).

    This script lives in the skill's folder, or in a repo's ``scripts/``, so the repo can't be
    found from the script's own location; it has to come from the docs being worked on. Asks git
    first, so worktrees and submodules resolve correctly, then falls back to looking for ``.git``
    when git isn't installed.
    """
    start = start.resolve()
    folder = start if start.is_dir() else start.parent
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=folder, capture_output=True, text=True, encoding="utf-8",
        )
        if result.returncode == 0 and result.stdout.strip():
            return Path(result.stdout.strip()).resolve()
    except FileNotFoundError:
        pass
    for candidate in (folder, *folder.parents):
        if (candidate / ".git").exists():
            return candidate
    raise PrivateMdError("no-repo", f"{start} is not inside a git repository")


def check_output_is_ignored(out: Path) -> None:
    """Raise unless git would ignore ``out``, so a private copy can't end up in a commit.

    A path outside any repository isn't tracked anywhere and is allowed. Inside one, the answer
    comes from ``git check-ignore``; when git can't be asked, the write is refused rather than
    assumed safe.
    """
    try:
        repo = find_repo_root(out.parent)
    except PrivateMdError:
        return
    try:
        result = subprocess.run(
            ["git", "check-ignore", "-q", str(out.resolve())],
            cwd=repo, capture_output=True, text=True, encoding="utf-8",
        )
    except FileNotFoundError:
        raise PrivateMdError(
            "unsafe-output", f"can't confirm {out} is gitignored because git isn't available; use -o - instead"
        ) from None
    if result.returncode != 0:
        raise PrivateMdError(
            "unsafe-output",
            f"refusing to write {out}: git would track it, and it will contain real values. "
            "Add '*.private.md' to .gitignore, or use -o - to print to stdout",
        )


def default_output(doc: Path) -> Path:
    """Return where a doc's private copy goes by default: ``<name>.private.md`` beside it."""
    return doc.with_name(doc.stem + ".private.md")


def cmd_restore(docs: list[Path], private: Path | None = None, output: str | None = None) -> None:
    """Write the private copy of each doc, or print it when ``output`` is ``-``.

    Everything is checked before anything is written, so one bad doc or unsafe output path leaves
    no partial set of private copies behind.
    """
    if not docs:
        raise PrivateMdError("usage", "no document given")
    if output is not None and len(docs) > 1:
        raise PrivateMdError("usage", "-o can only be used with a single document")
    for doc in docs:
        if not doc.is_file():
            raise PrivateMdError("usage", f"{doc} not found")

    private = private or find_repo_root(docs[0]) / "PRIVATE.md"
    mapping = load_placeholders(private)

    plans: list[tuple[Path, Path | None]] = []
    for doc in docs:
        out = None if output == "-" else Path(output) if output else default_output(doc)
        if out is not None:
            # Writing real values into the tracked doc would put them in the next commit.
            if out.resolve() == doc.resolve():
                raise PrivateMdError("unsafe-output", f"refusing to overwrite {doc} with private values")
            check_output_is_ignored(out)
        plans.append((doc, out))

    for doc, out in plans:
        # newline="" keeps the source's line endings exactly as they are, on read and on write.
        result = restore(doc.read_text(encoding="utf-8", newline=""), mapping)
        if out is None:
            sys.stdout.reconfigure(encoding="utf-8", newline="")
            sys.stdout.write(result)
        else:
            out.write_text(result, encoding="utf-8", newline="")
            print(f"wrote {out}")


def git(repo: Path, *args: str) -> str:
    """Run a git command in ``repo`` and return its stdout as text."""
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True,
        text=True, encoding="utf-8", errors="replace",
    ).stdout


def findings(name: str, text: str, needles: dict[str, str]) -> list[str]:
    """Return one line per (line, placeholder) where a real value appears in ``text``.

    ``needles`` maps lower-cased real values to their placeholders. A finding names the
    placeholder, never the real value, so the report is safe to paste anywhere.
    """
    found = []
    for number, line in enumerate(text.splitlines(), 1):
        lowered = line.lower()
        for real, placeholder in needles.items():
            if real in lowered:
                found.append(f"{name}:{number}: real value for `{placeholder}`")
    return found


def staged_findings(repo: Path, needles: dict[str, str]) -> list[str]:
    """Check the staged version of every added, copied, modified or renamed file."""
    found = []
    for path in git(repo, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0"):
        if path:
            found += findings(path, git(repo, "show", f":{path}"), needles)
    return found


def history_findings(repo: Path, needles: dict[str, str]) -> list[str]:
    """Check every file and commit message in every commit reachable from any ref."""
    found = []
    for commit in git(repo, "rev-list", "--all").split():
        short = commit[:8]
        found += findings(f"{short} (message)", git(repo, "log", "-1", "--format=%B", commit), needles)
        for path in git(repo, "ls-tree", "-r", "--name-only", "-z", commit).split("\0"):
            if path:
                found += findings(f"{short}:{path}", git(repo, "show", f"{commit}:{path}"), needles)
    return found


def cmd_check(
    private: Path | None = None,
    message: Path | None = None,
    paths: list[Path] | None = None,
    history: bool = False,
) -> int:
    """Look for real values where they must not be; return 1 and list findings if any are found.

    Checks the staged files unless ``message``, ``paths`` or ``history`` picks another target.
    Matching ignores case, so a hostname is caught whichever case it's written in. A missing
    PRIVATE.md fails the check rather than passing it, since nothing could be checked.
    """
    repo = find_repo_root(Path.cwd())
    private = private or repo / "PRIVATE.md"
    try:
        mapping = load_placeholders(private)
    except PrivateMdError as error:
        if error.kind == "missing-file":
            raise PrivateMdError(
                "missing-file",
                f"{private} not found, so private values can't be checked. Restore it from your copy "
                "(see PRIVATE.example.md), or commit with --no-verify if you're sure.",
            ) from None
        raise
    needles = {real.lower(): placeholder for placeholder, real in mapping.items() if len(real) >= MIN_CHECK_LENGTH}

    if message is not None:
        found = findings("commit message", message.read_text(encoding="utf-8"), needles)
    elif paths:
        found = []
        for path in paths:
            found += findings(str(path), path.read_text(encoding="utf-8", errors="replace"), needles)
    elif history:
        found = history_findings(repo, needles)
    else:
        found = staged_findings(repo, needles)

    if found:
        print("Private values found; use the placeholders from PRIVATE.md instead:", file=sys.stderr)
        print("\n".join(f"  {line}" for line in found), file=sys.stderr)
        return 1
    if history:
        print("no private values in any commit", file=sys.stderr)
    elif paths:
        print(f"no private values in {len(paths)} file(s)", file=sys.stderr)
    return 0


# Copied into a repo's scripts/ by install-hooks; the two compatibility entry points need private_md.py.
TOOL_FILES = ("private_md.py", "restore-private.py", "check-private.py")
GITIGNORE_LINES = ("PRIVATE.md", "*.private.md")
HOOKS_DIR = ".githooks"
HOOK_TEMPLATE = """#!/bin/sh
# Block {what} that contain this repo's real private values (see scripts/check-private.py).
# WSL usually has only python3; Windows may have only python.
PY=$(command -v python3 || command -v python) || {{ echo "{name}: no python found" >&2; exit 1; }}
exec "$PY" scripts/check-private.py{args}
"""
HOOKS = {
    "pre-commit": HOOK_TEMPLATE.format(what="commits", name="pre-commit", args=""),
    "commit-msg": HOOK_TEMPLATE.format(what="commit messages", name="commit-msg", args=' --message "$1"'),
}


def active_default_hooks(repo: Path) -> list[str]:
    """Return the names of hooks in the repo's default hooks folder that git would run today.

    Setting core.hooksPath makes git ignore that folder, so these would silently stop running.
    """
    hooks = Path(git(repo, "rev-parse", "--git-path", "hooks").strip())
    hooks = hooks if hooks.is_absolute() else repo / hooks
    if not hooks.is_dir():
        return []
    return sorted(p.name for p in hooks.iterdir() if p.is_file() and not p.name.endswith(".sample"))


def install_file(target: Path, content: str, report: list[str], executable: bool = False) -> None:
    """Write ``content`` to ``target`` unless something is already there; record what happened.

    An existing file is never overwritten: identical content counts as already in place, and
    different content is left for the user to merge by hand.
    """
    if target.exists():
        if target.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n") == content:
            report.append(f"already in place: {target}")
        else:
            report.append(f"manual: {target} exists with other content; merge the reference version in by hand")
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")
    if executable:
        target.chmod(0o755)
    report.append(f"done: wrote {target}")


def cmd_install_hooks(repo: Path | None = None) -> int:
    """Copy the tools into a repo's ``scripts/``, add commit hooks, and gitignore private files.

    Safe to run again: each step reports done, already in place, or a manual edit to make. It never
    overwrites a file, never repoints a core.hooksPath that's already set elsewhere, and doesn't set
    one when the repo has active hooks that setting it would switch off.
    """
    repo = find_repo_root(repo or Path.cwd())
    source = Path(__file__).resolve().parent
    report: list[str] = []

    for name in TOOL_FILES:
        install_file(repo / "scripts" / name, (source / name).read_text(encoding="utf-8"), report)

    hooks_path = subprocess.run(
        ["git", "config", "--get", "core.hooksPath"], cwd=repo, capture_output=True, text=True, encoding="utf-8",
    ).stdout.strip()
    if hooks_path and hooks_path.rstrip("/") != HOOKS_DIR:
        report.append(
            f"manual: core.hooksPath is {hooks_path}; add 'scripts/check-private.py' to its pre-commit hook "
            "and 'scripts/check-private.py --message \"$1\"' to its commit-msg hook"
        )
    else:
        for name, content in HOOKS.items():
            install_file(repo / HOOKS_DIR / name, content, report, executable=True)
        if hooks_path:
            report.append(f"already in place: core.hooksPath = {HOOKS_DIR}")
        elif active := active_default_hooks(repo):
            report.append(
                f"manual: the repo already runs hooks from its default folder ({', '.join(active)}), which "
                f"setting core.hooksPath would switch off; move them into {HOOKS_DIR}/, then run "
                f"'git config core.hooksPath {HOOKS_DIR}'"
            )
        else:
            git(repo, "config", "core.hooksPath", HOOKS_DIR)
            report.append(f"done: set core.hooksPath = {HOOKS_DIR}")

    gitignore = repo / ".gitignore"
    existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    present = {line.strip() for line in existing.splitlines()}
    missing = [line for line in GITIGNORE_LINES if line not in present]
    if missing:
        newline = "\r\n" if "\r\n" in existing else "\n"
        prefix = "" if not existing or existing.endswith("\n") else newline
        with gitignore.open("a", encoding="utf-8", newline="") as file:
            file.write(prefix + newline.join(missing) + newline)
        report.append(f"done: added {', '.join(missing)} to .gitignore")
    else:
        report.append("already in place: .gitignore entries")

    print("\n".join(report))
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser, with one subcommand per tool."""
    parser = argparse.ArgumentParser(prog="private_md.py", description="Tools for the PRIVATE.md standard.")
    commands = parser.add_subparsers(dest="command", required=True)

    restore_cmd = commands.add_parser("restore", help="write the private copy of redacted docs")
    restore_cmd.add_argument("docs", nargs="+", type=Path, metavar="DOC", help="redacted doc to restore")
    restore_cmd.add_argument("--private", type=Path, help="PRIVATE.md to use (default: <repo root>/PRIVATE.md)")
    restore_cmd.add_argument("-o", "--output", help="output path, or - for stdout (default: <doc>.private.md)")

    check_cmd = commands.add_parser("check", help="find real values in staged files, a message, files or history")
    add_check_arguments(check_cmd)

    hooks_cmd = commands.add_parser("install-hooks", help="copy the tools into a repo and add commit hooks")
    hooks_cmd.add_argument("repo", nargs="?", type=Path, help="repo to set up (default: the current one)")
    return parser


def add_check_arguments(parser: argparse.ArgumentParser) -> None:
    """Add the ``check`` options to ``parser``; shared with the check-private.py entry point."""
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--message", type=Path, help="check this commit message file")
    mode.add_argument("--paths", nargs="+", type=Path, metavar="FILE", help="check these working-tree files")
    mode.add_argument("--history", action="store_true", help="check every file and message in every commit")
    parser.add_argument("--private", type=Path, help="PRIVATE.md to use (default: <repo root>/PRIVATE.md)")


def run(command: Callable[..., int | None], *args, **kwargs) -> int:
    """Run one command, turning a PrivateMdError into a message on stderr and exit status 1."""
    try:
        return command(*args, **kwargs) or 0
    except PrivateMdError as error:
        print(error.message, file=sys.stderr)
        return 1


def main(argv: list[str] | None = None) -> int:
    """Parse ``argv`` and dispatch to the chosen subcommand; returns the process exit status."""
    # Windows consoles default to a legacy code page; paths and placeholders may be non-ASCII.
    sys.stderr.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    if args.command == "restore":
        return run(cmd_restore, args.docs, args.private, args.output)
    if args.command == "check":
        return run(cmd_check, args.private, args.message, args.paths, args.history)
    if args.command == "install-hooks":
        return run(cmd_install_hooks, args.repo)
    return 2


if __name__ == "__main__":
    sys.exit(main())
