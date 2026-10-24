from pathlib import Path


def migrate_player_data(repo_root: Path, player_data_root: Path) -> None:
    # From VF tracker's structure
    sources = (
        (repo_root / "score_log.txt", player_data_root / "score_log.jsonl"),
        (
            repo_root / "volforce_history.jsonl",
            player_data_root / "volforce_history.jsonl",
        ),
        (repo_root / "cache" / "playtime.json", player_data_root / "playtime.json"),
    )
    for source, destination in sources:
        if source.is_file() and not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            source.rename(destination)
            print(
                f"Migrated {source.relative_to(repo_root)} "
                f"to {destination.relative_to(repo_root)}",
                flush=True,
            )
