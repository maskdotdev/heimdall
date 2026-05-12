from __future__ import annotations

import subprocess
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class GitCommandRunner:
    def run(self, command: list[str]) -> str:
        result = subprocess.run(command, check=False, text=True, capture_output=True)
        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise RuntimeError(f"{' '.join(command)} failed: {stderr}")
        return result.stdout.strip()

    def default_branch(self, remote_url: str) -> str:
        output = self.run(["git", "ls-remote", "--symref", remote_url, "HEAD"])
        for line in output.splitlines():
            if line.startswith("ref: refs/heads/") and line.endswith("\tHEAD"):
                return line.removeprefix("ref: refs/heads/").removesuffix("\tHEAD")
        return "main"
