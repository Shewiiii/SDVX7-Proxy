from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from xml.dom import minidom
from xml.parsers.expat import ExpatError

GAME_NAME = "Sound Voltex"


def ensure_spicecfg_closed() -> None:
    if os.name != "nt":
        return
    result = subprocess.run(
        ["tasklist", "/FO", "CSV", "/NH"],
        check=True,
        capture_output=True,
        text=True,
        errors="replace",
    )
    if re.search(
        r'^"spicecfg(?:64)?\.exe",', result.stdout, re.IGNORECASE | re.MULTILINE
    ):
        raise RuntimeError(
            "Close Spicecfg before running setup; its open settings can overwrite the EA URL."
        )


def service_url(value: str) -> str:
    """Accept the host:port shorthand supported by Spice2x."""
    value = value.strip()
    if not value:
        raise ValueError("Enter the EA server's URL.")
    if "://" not in value:
        value = "http://" + value
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValueError("Enter a valid HTTP or HTTPS server URL.") from None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or any(character.isspace() for character in value)
        or port is not None
        and not 1 <= port <= 65535
    ):
        raise ValueError("Enter a valid HTTP or HTTPS server URL.")
    return urlunsplit(parsed)


def proxy_port(value: str) -> int:
    try:
        port = int(value)
        if not 1 <= port <= 65535:
            raise ValueError
        return port
    except ValueError:
        raise ValueError("TRACKER_PROXY_PORT must be between 1 and 65535.") from None


def is_proxy_url(value: str, port: int) -> bool:
    parsed = urlsplit(service_url(value))
    host = parsed.hostname.lower().rstrip(".")
    return (
        host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
        and (parsed.port or (443 if parsed.scheme == "https" else 80)) == port
    )


def config_path(game_root: Path, override: str = "") -> Path:
    if not override:
        # Spice2x logs -cfgpath overrides when it opens its configuration.
        log = game_root / "log.txt"
        if log.is_file():
            with log.open("rb") as stream:
                stream.seek(max(0, log.stat().st_size - 262144))
                tail = stream.read().decode("utf-8", errors="replace")
            matches = list(
                re.finditer(r"using (custom|global) config file:\s*([^\r\n]+)", tail)
            )
            if matches and matches[-1][1] == "custom":
                override = matches[-1][2].strip().strip('"')
    if override:
        path = Path(os.path.expandvars(override)).expanduser()
        return path if path.is_absolute() else game_root / path
    appdata = os.getenv("APPDATA")
    if not appdata:
        raise RuntimeError(
            "Cannot locate Spice2x settings. Set TRACKER_SPICE_CONFIG to spicetools.xml."
        )
    return Path(appdata) / "spicetools.xml"


class SpiceConfig:
    """Edit SOUND VOLTEX's url option without changing other game settings."""

    def __init__(self, path: Path):
        self.path = path
        self.original = path.read_bytes() if path.exists() else None
        try:
            self.document = minidom.parseString(
                self.original if self.original is not None else b"<games/>"
            )
        except ExpatError as error:
            raise RuntimeError(
                f"Cannot parse Spice2x config {path}: {error}"
            ) from error
        if self.document.documentElement.tagName != "games":
            raise RuntimeError(f"Expected a <games> root in Spice2x config {path}.")
        games = [
            node
            for node in self.document.documentElement.childNodes
            if node.nodeType == node.ELEMENT_NODE
            and node.tagName == "game"
            and node.getAttribute("name").casefold() == GAME_NAME.casefold()
        ]
        self.game = next(
            (node for node in games if node.getAttribute("name") == GAME_NAME),
            games[0] if games else None,
        )
        self.legacy_stubs = [
            node
            for node in games
            if node is not self.game and self._is_proxy_stub(node)
        ]

    @staticmethod
    def _child(parent, tag: str):
        return next(
            (
                node
                for node in parent.childNodes
                if node.nodeType == node.ELEMENT_NODE and node.tagName == tag
            ),
            None,
        )

    @staticmethod
    def _is_proxy_stub(game) -> bool:
        if game.getAttribute("name") != "SOUND VOLTEX" or game.attributes.length != 1:
            return False
        if any(node.nodeType == node.COMMENT_NODE for node in game.childNodes):
            return False
        children = [
            node for node in game.childNodes if node.nodeType == node.ELEMENT_NODE
        ]
        if len(children) != 1 or children[0].tagName != "options":
            return False
        if children[0].attributes.length:
            return False
        options = [
            node
            for node in children[0].childNodes
            if node.nodeType == node.ELEMENT_NODE
        ]
        if len(options) != 1 or options[0].tagName != "option":
            return False
        option = options[0]
        if option.getAttribute("name") != "url" or option.attributes.length != 2:
            return False
        try:
            value = urlsplit(service_url(option.getAttribute("value")))
        except ValueError:
            return False
        return (
            value.hostname in {"127.0.0.1", "localhost", "::1"}
            and value.path == "/service"
            and not value.query
            and not value.fragment
        )

    def _url_options(self):
        options = self._child(self.game, "options") if self.game is not None else None
        if options is None:
            return []
        return [
            node
            for node in options.childNodes
            if node.nodeType == node.ELEMENT_NODE
            and node.tagName == "option"
            and node.getAttribute("name") == "url"
        ]

    @property
    def url(self) -> str:
        options = self._url_options()
        return options[0].getAttribute("value") if options else ""

    def set_url(self, value: str) -> Path | None:
        options = self._url_options()
        if (
            options
            and all(node.getAttribute("value") == value for node in options)
            and self.game.getAttribute("name") == GAME_NAME
            and not self.legacy_stubs
        ):
            return None
        if self.game is None:
            self.game = self.document.createElement("game")
            self.game.setAttribute("name", GAME_NAME)
            self.document.documentElement.appendChild(self.game)
        self.game.setAttribute("name", GAME_NAME)
        for stub in self.legacy_stubs:
            self.document.documentElement.removeChild(stub)
        self.legacy_stubs = []
        parent = self._child(self.game, "options")
        if parent is None:
            parent = self.document.createElement("options")
            self.game.appendChild(parent)
        if not options:
            node = self.document.createElement("option")
            node.setAttribute("name", "url")
            parent.appendChild(node)
            options.append(node)
        for node in options:
            node.setAttribute("value", value)

        # Detect edits made in Spicecfg while setup was waiting for user input.
        current = self.path.read_bytes() if self.path.exists() else None
        if current != self.original:
            raise RuntimeError(
                "Spice2x settings changed during setup. Close Spicecfg and retry."
            )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        backup = None
        if self.original is not None:
            backup = self.path.with_name(self.path.name + ".bak")
            # Keep the first pre-proxy configuration available for restoration.
            if not backup.exists():
                with backup.open("xb") as stream:
                    stream.write(self.original)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=self.path.parent, delete=False
            ) as stream:
                temporary = Path(stream.name)
                stream.write(self.document.toxml(encoding="utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self.path)
            self.original = self.path.read_bytes()
            saved = SpiceConfig(self.path)
            if (
                saved.game is None
                or saved.game.getAttribute("name") != GAME_NAME
                or saved.url != value
            ):
                raise RuntimeError(
                    "Could not verify the saved Sound Voltex EA Service URL."
                )
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return backup
