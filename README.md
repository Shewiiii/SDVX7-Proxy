# SDVX ∇ Tracker Proxy

Standalone proxy to intercept play data, for SOUND VOLTEX ∇, natively compatible with the RyuNET network and Asphyxia. Tested on KFC.

RyuNET's custom maps are supported.

> [!NOTE]
> A custom EA Service URL can be chosen, but some data returned by the server on card login, such as the saved chart data used to calculate VolForce, may not be correctly parsed by the proxy.

This repository is a cleaned-up version of [SDVX ∇ VolForce Tracker](https://github.com/Shewiiii/SDVX7-VolForce-Tracker), meant for broader use.

## Requirements

- Python 3.10+
- NodeJS 22.5+

## Setup

Follow these steps only if you want to install the proxy alone.

- Run `setup.bat` and follow the instructions.
- From now on, `run-proxy.bat` before starting the game. Otherwise, it will not connect to the network, but you can change back `EA Service URL` to your server URL at any point .

## Logged data

After in-game login and a play, you will find the following files in `player-data`.

- `playtime.json` stores active playtime in seconds, play count, and the game-log cursor used to resume tracking. `pending` is a temporary variable that stores the timestamp of a game scene attach in stdout, then change back to `null` on detach.

```json
{
    "version": 1,
    "seconds": 3600,
    "plays": 20,
    "cursor": {},
    "pending": null
}
```

- `score_log.jsonl` contains all the data the game sends to the E-Amusement server, with a new JSON entry added after each play.

```json
// Example with S-CRITICAL enabled
// When disabled, btfx_s_critical's value is always 0
{
    "music_id": 1938,
    "diff_idx": 2,
    "score": 9492028,
    "clear_type": 2,
    "score_grade": 6,
    "exscore": 8075,
    "volforce": 340, // Chart VF / 1000
    "volforce_source": "updated",
    "level": 19.1,
    "judgments": {
        "near": 175,
        "error": 75,
        "early_near": 84,
        "late_near": 91,
        "critical": 240, // early and late critical data is not sent to the server for some reasons
        "s_critical": 2709
    },
    "raw_judgments": {
        "btfx_s_critical": 449,
        "critical_including_s_critical": 2949,
        "near": 175,
        "error": 75
    },
    "timing_histogram": [84, 47, 140, 2459, 87, 32, 91],
    "s_critical_enabled": true,
    "result_options": {
        "mode": 5,
        "start_option": 4,
        "gauge_type": 0,
        "notes_option": 0,
        "etc": "dfmt:173, scr:1, max_sound_delay:9.6324, max_sound_distance:9.6324, mstat: t99s0r0nd0"
    },
    "received_at": "2026-10-21T17:25:56.900Z"
}
```

- `volforce_history.jsonl` stores timestamped total VolForce and worst chart VF in top 50, in thousandths, with a new JSON entry added after each play.

```json
{
    "timestamp": "2026-10-22T12:44:15.355Z",
    "profile_id": "...",
    "total_volforce": 16918,
    "minimum_volforce": 326,
    "top_count": 50
}
```

## Credits

- E-Amusement decoding utils from [RyuNET-core](https://github.com/Ryu7w7/RyuNET-core)
