from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

SCENE_EVENT = re.compile(
    r"^\[(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})\] "
    r"I:(Attach|Detach): in (?:ALTERNATIVE_GAME_SCENE|GAME_SCENE)$"
)


def parse_playtime(value: str) -> int:
    """Accept whole d/h/m/s units, or 0 to skip. Return seconds."""
    value = value.strip()
    if value == "0":
        return 0
    units = re.fullmatch(
        r"(?:(\d+)\s*d\s*)?(?:(\d+)\s*h\s*)?" r"(?:(\d+)\s*m\s*)?(?:(\d+)\s*s\s*)?",
        value,
        re.IGNORECASE,
    )
    if units and any(part is not None for part in units.groups()):
        return sum(
            int(part or 0) * factor
            for part, factor in zip(units.groups(), (86400, 3600, 60, 1))
        )
    raise ValueError("Enter a duration like 2d 7h, 13h or 12h 30m, or 0 to skip.")


def format_playtime(seconds: int, include_seconds: bool = True) -> str:
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    text = f"{hours:,}h {minutes:02d}m"
    return f"{text} {seconds:02d}s" if include_seconds else text


def read_state(path: Path) -> dict:
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": 1, "seconds": 0, "plays": 0, "cursor": {}}
    if (
        not isinstance(state, dict)
        or state.get("version") != 1
        or any(
            type(state.get(key)) is not int or state[key] < 0
            for key in ("seconds", "plays")
        )
        or not isinstance(state.get("cursor"), dict)
    ):
        raise ValueError(
            "Invalid playtime history. Restore cache/playtime.json from backup."
        )
    cursor = state["cursor"]
    if cursor:
        if (
            not isinstance(cursor.get("generation"), str)
            or type(cursor.get("offset")) is not int
            or cursor["offset"] < 0
        ):
            raise ValueError("Invalid playtime log cursor.")
        if cursor.get("pending") is not None:
            datetime.strptime(cursor["pending"], "%Y/%m/%d %H:%M:%S")
    return state


class PlaytimeTracker:
    def __init__(self, log_path: str | Path, state_path: str | Path):
        self.log_path = Path(log_path)
        self.state_path = Path(state_path)

    def poll(self) -> dict:
        with self._lock():
            return self._poll()

    def checkpoint(self) -> dict:
        """Exclude all completed history and any in-progress play from an import."""
        with self._lock():
            state = self._poll()
            if state["cursor"].get("pending"):
                state["cursor"]["pending"] = None
                self._save(state)
            return state

    @contextmanager
    def _lock(self):
        # Serialize setup and collectors, including accidentally duplicated launches.
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with self.state_path.with_suffix(".lock").open("a+b") as stream:
            if os.name == "nt":
                import msvcrt

                if stream.tell() == 0:
                    stream.write(b"0")
                    stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == "nt":
                    stream.seek(0)
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

    def _poll(self) -> dict:
        state = read_state(self.state_path)
        try:
            stream = self.log_path.open("rb")
        except FileNotFoundError:
            return state
        with stream:
            first = stream.readline()
            if not first.endswith(b"\n"):
                return state
            stat = os.fstat(stream.fileno())
            generation = hashlib.sha256(
                first + f"{stat.st_dev}:{stat.st_ino}".encode("ascii")
            ).hexdigest()
            cursor = state["cursor"]
            offset = cursor.get("offset", 0)
            if cursor.get("generation") != generation or stat.st_size < offset:
                cursor = {"generation": generation, "offset": 0, "pending": None}
                state["cursor"] = cursor
                offset = 0
            stream.seek(offset)
            while True:
                line = stream.readline()
                if not line.endswith(b"\n"):
                    break  # Retry partial writes on the next poll.
                cursor["offset"] = stream.tell()
                match = SCENE_EVENT.match(
                    line.decode("utf-8", errors="replace").strip()
                )
                if not match:
                    continue
                stamp, event = match.groups()
                try:
                    timestamp = datetime.strptime(stamp, "%Y/%m/%d %H:%M:%S")
                except ValueError:
                    continue
                if event == "Attach":
                    # A second start abandons an interval whose end is missing.
                    cursor["pending"] = stamp
                elif cursor.get("pending"):
                    start = datetime.strptime(cursor["pending"], "%Y/%m/%d %H:%M:%S")
                    seconds = int((timestamp - start).total_seconds())
                    cursor["pending"] = None
                    if seconds > 0:
                        state["seconds"] += seconds
                        state["plays"] += 1
            changed = cursor["offset"] != offset
            # The game may recreate the log while we read it. Retry that run later.
            stream.seek(0)
            if (
                stream.readline() != first
                or os.fstat(stream.fileno()).st_size < cursor["offset"]
            ):
                return read_state(self.state_path)
        if changed:
            self._save(state)
        return state

    def _save(self, state: dict) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        # Atomically commit the cursor and total together to avoid duplicate plays.
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.state_path.parent, delete=False
            ) as stream:
                temporary = Path(stream.name)
                json.dump(state, stream, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self.state_path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def load_playtime_summary(
    path: str | Path,
    initial: str = "0",
    baseline_seconds: int = 0,
    baseline_plays: int = 0,
) -> dict:
    state = read_state(Path(path))
    if baseline_seconds < 0 or baseline_plays < 0:
        raise ValueError("Playtime checkpoints must be nonnegative.")
    imported = parse_playtime(initial)
    local = max(0, state["seconds"] - baseline_seconds)
    return {
        "total_seconds": imported + local,
        "initial_seconds": imported,
        "local_seconds": local,
        "plays": max(0, state["plays"] - baseline_plays),
    }
