from __future__ import annotations

import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = REPO_ROOT / "runtime"
VENV_ROOT = REPO_ROOT / ".venv"
UTILS_ROOT = REPO_ROOT / "utils"
UTILITY_FILES = (
    "AutoBuffer.ts",
    "KBinJSON.ts",
    "KonmaiEncrypt.ts",
    "Logger.ts",
    "LzKN.ts",
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


def runtime_environment() -> dict[str, str]:
    env = os.environ.copy()
    # The bundled utilities sit beside runtime, where npm installs dependencies.
    node_paths = [str(RUNTIME_ROOT / "node_modules")]
    if env.get("NODE_PATH"):
        node_paths.append(env["NODE_PATH"])
    env.update(
        NODE_PATH=os.pathsep.join(node_paths),
        TS_NODE_PROJECT=str(RUNTIME_ROOT / "tsconfig.json"),
        TS_NODE_TRANSPILE_ONLY="true",
    )
    return env


def probe_runtime(node: str) -> bool:
    if not all((UTILS_ROOT / name).is_file() for name in UTILITY_FILES):
        return False
    script = (
        "const p = require('path'); "
        "for (const f of ['KonmaiEncrypt', 'LzKN', 'KBinJSON']) "
        "require(p.resolve('../utils', f)); "
        "require('fast-xml-parser');"
    )
    result = subprocess.run(
        [node, "-r", str(RUNTIME_ROOT / "node_modules/ts-node/register"), "-e", script],
        check=False,
        cwd=RUNTIME_ROOT,
        env=runtime_environment(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def install() -> Path:
    node, npm = node_tools()
    if not all((UTILS_ROOT / name).is_file() for name in UTILITY_FILES):
        raise RuntimeError(
            "Bundled protocol utilities are missing. Restore the utils folder."
        )
    python = venv_python()
    if not python.is_file():
        print("Creating the proxy's Python venv...", flush=True)
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
    if not probe_runtime(node):
        print("Installing the proxy's Node.js dependencies...", flush=True)
        run([npm, "ci", "--no-audit", "--no-fund"], cwd=RUNTIME_ROOT)
        if not probe_runtime(node):
            raise RuntimeError(
                "Protocol utility check failed. Run setup.bat again to retry."
            )
    else:
        print("Proxy's Node.js dependencies are already installed.", flush=True)
    return python


def prompt(label: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    return input(f"{label}{suffix}: ").strip() or default


def configure() -> None:
    from dotenv import dotenv_values, set_key

    from config import (
        GAME_LOG_PATH,
        GAME_ROOT,
        PLAYER_DATA_ROOT,
        PLAYTIME_STATE_PATH,
    )
    from tracker.data import migrate_player_data
    from tracker.playtime import PlaytimeTracker, parse_playtime
    from tracker.spice import (
        SpiceConfig,
        config_path,
        ensure_spicecfg_closed,
        is_proxy_url,
        proxy_port,
        service_url,
    )

    ensure_spicecfg_closed()
    migrate_player_data(REPO_ROOT, PLAYER_DATA_ROOT)
    env_path = REPO_ROOT / ".env"
    existing = dotenv_values(env_path)
    port = proxy_port(
        os.getenv("TRACKER_PROXY_PORT") or existing.get("TRACKER_PROXY_PORT") or "8080"
    )
    local_url = f"http://127.0.0.1:{port}/service"
    spice_path = config_path(
        GAME_ROOT,
        os.getenv("TRACKER_SPICE_CONFIG") or existing.get("TRACKER_SPICE_CONFIG") or "",
    )
    spice = SpiceConfig(spice_path)
    saved_upstream = (
        os.getenv("TRACKER_UPSTREAM") or existing.get("TRACKER_UPSTREAM") or ""
    )
    default_server = (
        (os.getenv("TRACKER_SERVER") or existing.get("TRACKER_SERVER") or "ryunet")
        .strip()
        .lower()
    )
    if default_server not in {"ryunet", "asphyxia", "custom"}:
        default_server = "ryunet"
    if saved_upstream:
        print(f"Previously saved upstream: {saved_upstream}")
    # The game's EA3 URL can be a bundled placeholder. Always ask which server
    # to use, including on reruns, before changing either saved configuration.
    server = ""
    while server not in {"ryunet", "asphyxia", "custom"}:
        server = prompt("EA server (ryunet/asphyxia/custom)", default_server).lower()
        if server not in {"ryunet", "asphyxia", "custom"}:
            print("Enter ryunet, asphyxia, or custom.")
    if server == "ryunet":
        upstream = "http://ea.ryu7w7.xyz/service"
    else:
        if server == "custom":
            print("WARNING: Some data, such as total VolForce or the top 50, may not be correctly parsed by the proxy.")
        upstream = "http://127.0.0.1:8083" if server == "asphyxia" else ""
        if server == default_server and existing.get("TRACKER_SERVER") == server:
            upstream = saved_upstream or upstream
        upstream = prompt("EA server URL", upstream)
    while True:
        try:
            upstream = service_url(upstream)
            if is_proxy_url(upstream, port):
                raise ValueError("The upstream server cannot be the proxy itself.")
            break
        except ValueError as error:
            print(error)
            upstream = prompt("EA server URL")
    print(f"Upstream EA server: {upstream}")
    print(f"Spice2x config: {spice_path}")
    previous = existing.get("TRACKER_INITIAL_PLAYTIME") or "0"
    try:
        previous_seconds = parse_playtime(previous)
    except ValueError:
        previous_seconds = None
    initial_playtime = previous if previous_seconds is not None else "0"
    while True:
        initial_playtime = prompt(
            "Starting playtime (2d 7h, 13h or 12h 30m)",
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

    ensure_spicecfg_closed()
    # Save the upstream before redirecting the game, so reruns cannot lose it.
    settings = {
        "TRACKER_SERVER": server,
        "TRACKER_UPSTREAM": upstream,
        "TRACKER_PROXY_PORT": str(port),
        "TRACKER_SPICE_CONFIG": str(spice_path),
        **playtime_settings,
    }
    for key, value in settings.items():
        set_key(env_path, key, value, quote_mode="always")
    backup = spice.set_url(local_url)
    print(f"EA Service URL set to {local_url}")
    if backup is not None:
        print(f"Original Spice2x config backed up to {backup}")
    print("Configuration saved. You can run the proxy then the game.")


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
