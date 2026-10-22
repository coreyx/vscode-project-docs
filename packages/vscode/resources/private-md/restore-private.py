#!/usr/bin/env python3
"""Rebuild the private version of a redacted doc.

Compatibility entry point: it keeps the command line repos already use for restore-private.py,
while the logic lives in private_md.py beside it. Copy both files into a repo's ``scripts/``.

Usage:
    python scripts/restore-private.py                       # DEFAULT_DOC -> <doc>.private.md
    python scripts/restore-private.py README.md -o -        # any doc, to stdout
    python scripts/restore-private.py --private path/to/PRIVATE.md
"""

import argparse
import sys
from pathlib import Path

# -I (isolated mode) leaves the script's folder off sys.path, so add it to find private_md.py.
sys.path.insert(0, str(Path(__file__).resolve().parent))
# Importing would otherwise leave a __pycache__ folder in the repo's scripts/, waiting to be committed.
sys.dont_write_bytecode = True
import private_md  # noqa: E402

# The doc restored when none is named, relative to the repo root. Each repo that adopts this script
# sets its own (for example MIGRATION.md). Empty means a doc must be named.
DEFAULT_DOC = ""


def main() -> int:
    """Parse the original command line and run private_md's restore."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("doc", nargs="?", type=Path,
                        help=f"redacted doc to restore (default: {DEFAULT_DOC or 'none'})")
    parser.add_argument("--private", type=Path, help="file holding the placeholder table (default: PRIVATE.md)")
    parser.add_argument("-o", "--output", help="output path, or - for stdout (default: <doc>.private.md)")
    args = parser.parse_args()

    doc = args.doc
    if doc is None:
        if not DEFAULT_DOC:
            parser.error("name the doc to restore")
        try:
            doc = private_md.find_repo_root(Path(__file__)) / DEFAULT_DOC
        except private_md.PrivateMdError as error:
            print(error.message, file=sys.stderr)
            return 1
    return private_md.run(private_md.cmd_restore, [doc], args.private, args.output)


if __name__ == "__main__":
    sys.exit(main())
