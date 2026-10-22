#!/usr/bin/env python3
"""Refuse to commit this deployment's real hostnames, tailnet name and other private values.

Compatibility entry point: it keeps the command line repos already use for check-private.py,
while the logic lives in private_md.py beside it. Copy both files into a repo's ``scripts/``.

Usage:
    python scripts/check-private.py                  # staged files (the pre-commit hook)
    python scripts/check-private.py --message FILE   # a commit message (the commit-msg hook)
    python scripts/check-private.py --paths FILE...  # working-tree files, before staging
    python scripts/check-private.py --history        # every file and message in every commit
"""

import argparse
import sys
from pathlib import Path

# -I (isolated mode) leaves the script's folder off sys.path, so add it to find private_md.py.
sys.path.insert(0, str(Path(__file__).resolve().parent))
# Importing would otherwise leave a __pycache__ folder in the repo's scripts/, waiting to be committed.
sys.dont_write_bytecode = True
import private_md  # noqa: E402


def main() -> int:
    """Parse the original command line and run private_md's check."""
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    private_md.add_check_arguments(parser)
    args = parser.parse_args()
    return private_md.run(private_md.cmd_check, args.private, args.message, args.paths, args.history)


if __name__ == "__main__":
    sys.exit(main())
