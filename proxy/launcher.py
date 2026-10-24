from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from .data import migrate_player_data
from .setup import (
    REPO_ROOT,
    RUNTIME_ROOT,
    node_tools,
    probe_runtime,
    runtime_environment,
)


def check_packages(imports: str) -> None:
    packages = subprocess.run(
        [sys.executable, "-c", imports],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if packages.returncode:
        raise RuntimeError("Python requirements are missing. Run setup.bat first.")


def prepare() -> tuple[list[list[str]], dict[str, str], Path]:
    check_packages("import dotenv")
    # config loads this repository's .env, even when launched from another folder.
    from config import (
        MUSIC_DB_PATH,
        PLAYER_DATA_ROOT,
        SCORE_LOG_PATH,
        VOLFORCE_HISTORY_PATH,
    )

    migrate_player_data(REPO_ROOT, PLAYER_DATA_ROOT)

    if not MUSIC_DB_PATH.is_file():
        raise RuntimeError(
            "music_db.xml was not found. Put the proxy folder inside your game folder."
        )
    node, _ = node_tools()
    if not probe_runtime(node):
        raise RuntimeError(
            "Protocol utilities or dependencies are missing. Run setup.bat first."
        )
    env = runtime_environment()
    env.update(
        SCORE_LOG=str(SCORE_LOG_PATH),
        VOLFORCE_HISTORY=str(VOLFORCE_HISTORY_PATH),
    )
    from proxy.spice import is_proxy_url, service_url

    try:
        port = int(env.get("PROXY_PORT", "8080"))
        if not 1 <= port <= 65535:
            raise ValueError
    except ValueError:
        raise RuntimeError(
            "PROXY_PORT must be a port between 1 and 65535."
        ) from None
    try:
        upstream = service_url(env.get("UPSTREAM") or "http://ea.ryu7w7.xyz")
        if is_proxy_url(upstream, port):
            raise ValueError("The upstream server cannot be the proxy itself.")
        env["UPSTREAM"] = upstream
    except ValueError as error:
        raise RuntimeError(f"Invalid UPSTREAM: {error}") from None
    try:
        with socket.socket() as listener:
            if os.name == "nt":
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            listener.bind(("127.0.0.1", port))
    except OSError:
        raise RuntimeError(
            f"Port {port} is already in use. Close the other proxy before starting this one."
        ) from None
    commands = [
        [
            node,
            "-r",
            str(RUNTIME_ROOT / "node_modules/ts-node/register"),
            str(REPO_ROOT / "proxy/ea_proxy.ts"),
        ],
    ]
    return commands, env, RUNTIME_ROOT


def stop(processes: list[subprocess.Popen]) -> None:
    for process in processes:
        if process.poll() is None:
            process.terminate()
    for process in processes:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main() -> int:
    processes = []
    try:
        commands, env, root = prepare()
        next_poll = 0.0
        from config import GAME_LOG_PATH, PLAYTIME_STATE_PATH, PULLING_RATE
        from proxy.playtime import PlaytimeCollector

        playtime = PlaytimeCollector(GAME_LOG_PATH, PLAYTIME_STATE_PATH)
        print(
            "Starting the proxy. Keep this window open.",
            flush=True,
        )
        for command in commands:
            processes.append(subprocess.Popen(command, cwd=root, env=env))
        while all(process.poll() is None for process in processes):
            if time.monotonic() >= next_poll:
                try:
                    playtime.poll()
                except (OSError, ValueError, TypeError, KeyError) as error:
                    print(f"Could not update active playtime: {error}", file=sys.stderr)
                next_poll = time.monotonic() + PULLING_RATE
            time.sleep(0.5)
        return 1
    except KeyboardInterrupt:
        print("Stopping the proxy...")
        return 0
    except (OSError, RuntimeError) as error:
        print(f"Cannot start proxy: {error}", file=sys.stderr)
        return 1
    finally:
        stop(processes)


if __name__ == "__main__":
    raise SystemExit(main())
