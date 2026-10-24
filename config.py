import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent
load_dotenv(REPO_ROOT / ".env")
GAME_ROOT = REPO_ROOT.parent

PLAYER_DATA_ROOT = REPO_ROOT / "player-data"
SCORE_LOG_PATH = PLAYER_DATA_ROOT / "score_log.jsonl"
VOLFORCE_HISTORY_PATH = PLAYER_DATA_ROOT / "volforce_history.jsonl"
MUSIC_DB_PATH = GAME_ROOT / "data" / "others" / "music_db.xml"
GAME_LOG_PATH = Path(os.getenv("GAME_LOG") or GAME_ROOT / "log.txt")
PLAYTIME_STATE_PATH = PLAYER_DATA_ROOT / "playtime.json"
PULLING_RATE = 2
