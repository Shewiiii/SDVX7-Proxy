import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent
load_dotenv(REPO_ROOT / ".env")
GAME_ROOT = REPO_ROOT.parent

SCORE_LOG_PATH = REPO_ROOT / "score_log.txt"
VOLFORCE_HISTORY_PATH = REPO_ROOT / "volforce_history.jsonl"
MUSIC_DB_PATH = GAME_ROOT / "data" / "others" / "music_db.xml"
GAME_LOG_PATH = Path(os.getenv("TRACKER_GAME_LOG") or GAME_ROOT / "log.txt")
PLAYTIME_STATE_PATH = REPO_ROOT / "cache" / "playtime.json"
PULLING_RATE = 2
