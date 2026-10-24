from __future__ import annotations

import os
import shutil
import subprocess
import sys
import urllib.request
import venv
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = REPO_ROOT / "runtime"
VENV_ROOT = REPO_ROOT / ".venv"
DECODER_COMMIT_SHA = "c1a01de4b9412d9bb3f9a5eed452f2c221739aff"  # Oct 2, 2026
DECODER_FILES = (
    "src/utils/AutoBuffer.ts",
    "src/utils/KBinJSON.ts",
    "src/utils/KonmaiEncrypt.ts",
    "src/utils/Logger.ts",
    "src/utils/LzKN.ts",
    "LICENSE",
)
PYTHON_IMPORTS = "import dotenv"


def venv_python(root: Path = VENV_ROOT) -> Path:
    # Nabla only runs on Windows (I think ?) but just in case
    return root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run(command: list[str], **kwargs) -> None:
    subprocess.run(command, check=True, **kwargs)


def node_tools() -> tuple[str, str]:
    node = shutil.which("node")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not node or not npm:
        raise RuntimeError(
            "Install Node.js LTS from https://nodejs.org/en/download and try again."
        )
    version = subprocess.check_output([node, "--version"], text=True).strip()
    if tuple(int(part) for part in version.lstrip("v").split(".")) < (22, 5, 0):
        raise RuntimeError("Node.js 22.5 or newer is required.")
    return node, npm


def decoder_environment(root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        RYUNET_ROOT=str(root),
        TS_NODE_PROJECT=str(RUNTIME_ROOT / "tsconfig.json"),
        TS_NODE_TRANSPILE_ONLY="true",
    )
    return env


def probe_decoders(node: str, root: Path) -> bool:
    if not root.is_dir():
        return False
    script = (
        "const p = require('path'); const r = process.env.RYUNET_ROOT; "
        "for (const f of ['KonmaiEncrypt', 'LzKN', 'KBinJSON']) "
        "require(p.join(r, 'src/utils', f)); "
        "require(p.join(r, 'node_modules/fast-xml-parser'));"
    )
    result = subprocess.run(
        [node, "-r", str(root / "node_modules/ts-node/register"), "-e", script],
        check=False,
        cwd=root,
        env=decoder_environment(root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def find_decoder_root(node: str) -> Path | None:
    override = os.getenv("RYUNET_ROOT")
    if override:
        root = Path(override).expanduser().resolve()
        if probe_decoders(node, root):
            return root
    for root in (RUNTIME_ROOT, REPO_ROOT / "RyuNET-core-master"):
        if probe_decoders(node, root):
            return root
    return None


def download_decoders() -> None:
    marker = RUNTIME_ROOT / ".decoder-revision"
    if (
        marker.is_file()
        and marker.read_text(encoding="utf-8").strip() == DECODER_COMMIT_SHA
        and all((RUNTIME_ROOT / name).is_file() for name in DECODER_FILES)
    ):
        return

    def fetch(name: str) -> tuple[str, bytes]:
        url = f"https://raw.githubusercontent.com/Ryu7w7/RyuNET-core/{DECODER_COMMIT_SHA}/{name}"
        request = urllib.request.Request(
            url, headers={"User-Agent": "SDVX-VolForce-Tracker"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return name, response.read()

    print(
        "Downloading the RyuNET protocol decoders...",
        flush=True,
    )
    with ThreadPoolExecutor(max_workers=6) as pool:
        downloads = list(pool.map(fetch, DECODER_FILES))
    for name, content in downloads:
        target = RUNTIME_ROOT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    marker.write_text(DECODER_COMMIT_SHA + "\n", encoding="utf-8")


def install() -> Path:
    node, npm = node_tools()
    python = venv_python()
    if not python.is_file():
        print("Creating the proxy's Python environment...", flush=True)
        venv.EnvBuilder(with_pip=True).create(VENV_ROOT)
    print("Installing Python requirements...", flush=True)
    run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            str(RUNTIME_ROOT / "requirements.txt"),
        ]
    )
    run([str(python), "-c", PYTHON_IMPORTS])
    root = find_decoder_root(node)
    if root is None:
        download_decoders()
        print("Installing the decoder dependencies...", flush=True)
        run([npm, "ci", "--no-audit", "--no-fund"], cwd=RUNTIME_ROOT)
        if not probe_decoders(node, RUNTIME_ROOT):
            raise RuntimeError("Decoder check failed. Run setup.bat again to retry.")
    else:
        print(f"Reusing working decoders in {root}", flush=True)
    return python


def prompt(label: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    return input(f"{label}{suffix}: ").strip() or default


def configure() -> None:
    from dotenv import dotenv_values, set_key

    from config import (
        GAME_LOG_PATH,
        PLAYTIME_STATE_PATH,
    )
    from tracker.playtime import PlaytimeTracker, parse_playtime

    env_path = REPO_ROOT / ".env"
    existing = dotenv_values(env_path)
    previous = existing.get("TRACKER_INITIAL_PLAYTIME") or "0"
    try:
        previous_seconds = parse_playtime(previous)
    except ValueError:
        previous_seconds = None
    initial_playtime = previous if previous_seconds is not None else "0"
    while True:
        initial_playtime = prompt(
            "RyuNET starting playtime (2d 7h, 13h or 12h 30m)",
            initial_playtime,
        )
        try:
            initial_seconds = parse_playtime(initial_playtime)
            break
        except ValueError as error:
            print(error)
            initial_playtime = "0"

    playtime_settings = {"TRACKER_INITIAL_PLAYTIME": initial_playtime}
    same_initial = (
        previous_seconds == initial_seconds
        and existing.get("TRACKER_PLAYTIME_BASELINE_SECONDS") is not None
        and existing.get("TRACKER_PLAYTIME_BASELINE_PLAYS") is not None
    )
    if not same_initial:
        checkpoint = {"seconds": 0, "plays": 0}
        if initial_seconds:
            checkpoint = PlaytimeTracker(
                GAME_LOG_PATH, PLAYTIME_STATE_PATH
            ).checkpoint()
        playtime_settings.update(
            TRACKER_PLAYTIME_BASELINE_SECONDS=str(checkpoint["seconds"]),
            TRACKER_PLAYTIME_BASELINE_PLAYS=str(checkpoint["plays"]),
        )

    for key, value in playtime_settings.items():
        set_key(env_path, key, value, quote_mode="always")
    print("Configuration saved.")


def main() -> int:
    try:
        python = install()
        run(
            [str(python), "-c", "from tracker.setup import configure; configure()"],
            cwd=REPO_ROOT,
        )
        return 0
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Setup failed: {error}", file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("Setup cancelled.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
