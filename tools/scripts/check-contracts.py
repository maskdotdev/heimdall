#!/usr/bin/env python3
"""Run the full contract validation and generation drift check."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def run(command: list[str]) -> int:
    print("$ " + " ".join(command), flush=True)
    return subprocess.run(command, cwd=REPO_ROOT, check=False).returncode


def main() -> int:
    checks = [
        ["python3", "tools/scripts/validate-json-schemas.py", "--fixtures"],
        ["python3", "tools/scripts/generate-contracts.py", "--check"],
    ]
    for command in checks:
        exit_code = run(command)
        if exit_code != 0:
            return exit_code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
