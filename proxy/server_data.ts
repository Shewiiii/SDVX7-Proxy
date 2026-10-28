// @ts-nocheck

import fs = require("node:fs");
import path = require("node:path");
import crypto = require("node:crypto");
const { profileData, chartRecord } = require("./server_fields");

interface ServerDataSnapshot {
    version?: 1;
    source: "sv7_load_m";
    profile_id: string;
    captured_at: string;
    updated_at: string;
    chart_volforce: Record<string, number>;
    chart_count: number;
    total_volforce: number;
    chart_records?: Record<string, { score: number; clear_type: number }>;
    player?: Record<string, string | number>;
    player_updated_at?: string;
    profile_data_captured_at?: string;
    profile_data_updated_at?: string;
    profile_options?: Record<string, number>;
    profile_parameters?: { type: number; id: number; param: number[] }[];
    variant_gate?: Record<string, unknown>;
}

interface ChartInfo {
    param?: { "@content"?: unknown };
}

interface GameResponse {
    [key: string]: unknown;
    "@attr"?: { status?: number | string };
    music?: { info?: ChartInfo | ChartInfo[] };
}

type ProtocolNode = Record<string, unknown>;
type FieldReader = (node: ProtocolNode, name: string) => unknown;

// Ryu7w7/asphyxia_plugins, handlers/profiles.ts: sv7_load_m uses 26 u32s
// per chart. Slots 0/1 identify the chart, slot 11 is its saved best VF,
// including the previous-version fallback supplied by the server.
export class ServerDataStore {
    private readonly filename: string;
    private readonly historyFilename: string;
    state: ServerDataSnapshot | undefined;
    private pendingProfiles = new Map<string, Partial<ServerDataSnapshot>>();

    constructor(filename: string, historyFilename: string) {
        this.filename = filename;
        this.historyFilename = historyFilename;
        this.state = undefined;
        try {
            const state: ServerDataSnapshot = JSON.parse(
                fs.readFileSync(filename, "utf8"),
            );
            if (
                state.source !== "sv7_load_m" ||
                typeof state.profile_id !== "string" ||
                !/^[a-f0-9]{64}$/.test(state.profile_id) ||
                !state.chart_volforce ||
                Array.isArray(state.chart_volforce) ||
                typeof state.chart_volforce !== "object" ||
                !Number.isFinite(Date.parse(state.captured_at)) ||
                Object.entries(state.chart_volforce).some(
                    ([key, value]) =>
                        !/^[1-9][0-9]*:[0-5]$/.test(key) ||
                        !Number.isSafeInteger(value) ||
                        value < 0,
                )
            )
                throw new Error("Invalid server data snapshot");
            this.state = state;
            // An older cache provides one known observation, not a past timeline.
            if (
                !fs.existsSync(this.historyFilename) ||
                fs.statSync(this.historyFilename).size === 0
            )
                this.recordHistory(state);
        } catch (caught) {
            const error = caught as NodeJS.ErrnoException;
            if (error.code !== "ENOENT")
                console.warn("Cannot read server data:", error.message);
        }
    }

    capture(
        route: string,
        refid: unknown,
        response: GameResponse | undefined,
        tracks: ProtocolNode[],
        field: FieldReader,
        requestData?: ProtocolNode,
    ): void {
        if (
            !refid ||
            ![
                "game.sv7_load",
                "game.sv7_load_m",
                "game.sv7_save_m",
                "game.sv7_save",
            ].includes(route)
        )
            return;
        if (!response || String(response["@attr"]?.status) !== "0") return;
        // Bind to the first profile, so another card cannot overwrite the owner's total.
        const profile = crypto
            .createHash("sha256")
            .update(String(refid))
            .digest("hex");
        if (this.state && this.state.profile_id !== profile) {
            console.warn(
                "Ignoring Total VolForce for a different card/profile.",
            );
            return;
        }
        if (route === "game.sv7_save") {
            if (!requestData) return;
            const previous = this.state || this.pendingProfiles.get(profile);
            if (!previous) return;
            const data = profileData(requestData, field, previous, true);
            if (this.state) {
                this.persist({ ...this.state, ...data });
            } else {
                this.pendingProfiles.set(profile, data);
            }
            return;
        }
        if (route === "game.sv7_load") {
            // Retain selected game data, excluding card IDs and authentication.
            if (Number(field(response, "result")) !== 0) return;
            const data = profileData(response, field);
            if (!data.player.name) return;
            if (this.state) {
                this.persist({ ...this.state, ...data });
            } else {
                this.pendingProfiles.set(profile, data);
            }
            return;
        }
        let charts: Record<string, number>;
        let records: NonNullable<ServerDataSnapshot["chart_records"]>;
        if (route === "game.sv7_load_m") {
            if (!response.music || typeof response.music !== "object") return;
            charts = {};
            records = {};
            const entries = response.music.info || [];
            for (const entry of Array.isArray(entries) ? entries : [entries]) {
                const param = entry?.param?.["@content"];
                if (!Array.isArray(param) || param.length !== 26)
                    throw new Error(
                        "Unrecognized sv7_load_m chart layout. Preserving old total",
                    );
                const [mid, difficulty] = param;
                const vf = param[11];
                if (
                    !Number.isSafeInteger(mid) ||
                    mid <= 0 ||
                    !Number.isSafeInteger(difficulty) ||
                    difficulty < 0 ||
                    difficulty > 5 ||
                    !Number.isSafeInteger(vf) ||
                    vf < 0
                )
                    throw new Error(
                        "Invalid sv7_load_m chart. Preserving old total",
                    );
                const key = `${mid}:${difficulty}`;
                charts[key] = Math.max(charts[key] || 0, vf);
                const saved = chartRecord(param);
                const old = records[key];
                if (old) {
                    const best = saved.score >= old.score ? saved : old;
                    records[key] = {
                        ...best,
                        score: Math.max(old.score, saved.score),
                        exscore: Math.max(old.exscore || 0, saved.exscore),
                        clear_type: Math.max(old.clear_type, saved.clear_type),
                        score_grade: Math.max(
                            old.score_grade || 0,
                            saved.score_grade,
                        ),
                    };
                } else {
                    records[key] = saved;
                }
            }
        } else {
            if (!this.state) return; // A partial play log cannot establish a total.
            charts = { ...this.state.chart_volforce };
            records = { ...this.state.chart_records };
            let receivedBest = false;
            for (const track of tracks) {
                const mid = field(track, "music_id");
                const difficulty = field(track, "music_type");
                const raw = field(track, "volforce");
                if (
                    mid == null ||
                    difficulty == null ||
                    mid === "" ||
                    difficulty === ""
                )
                    continue;
                if (raw === undefined || raw === null || raw === "") continue;
                const vf = Number(raw);
                if (
                    !Number.isSafeInteger(Number(mid)) ||
                    Number(mid) <= 0 ||
                    !Number.isSafeInteger(Number(difficulty)) ||
                    Number(difficulty) < 0 ||
                    Number(difficulty) > 5 ||
                    !Number.isSafeInteger(vf) ||
                    vf < 0
                )
                    continue;
                const key = `${Number(mid)}:${Number(difficulty)}`;
                charts[key] = Math.max(charts[key] || 0, vf);
                const score = field(track, "score");
                const clear = field(track, "clear_type");
                if (
                    score != null &&
                    clear != null &&
                    score !== "" &&
                    clear !== "" &&
                    Number.isSafeInteger(Number(score)) &&
                    Number(score) >= 0 &&
                    Number(score) <= 10000000 &&
                    Number.isSafeInteger(Number(clear)) &&
                    Number(clear) >= 0 &&
                    Number(clear) <= 6
                ) {
                    const old = records[key] || {};
                    const updated = { ...old };
                    const exscore = field(track, "exscore");
                    if (
                        exscore != null &&
                        exscore !== "" &&
                        Number.isSafeInteger(Number(exscore)) &&
                        Number(exscore) >= 0
                    ) {
                        updated.exscore = Math.max(
                            old.exscore || 0,
                            Number(exscore),
                        );
                    }
                    const grade = field(track, "score_grade");
                    if (
                        grade != null &&
                        grade !== "" &&
                        Number.isSafeInteger(Number(grade)) &&
                        Number(grade) >= 0
                    ) {
                        updated.score_grade = Math.max(
                            old.score_grade || 0,
                            Number(grade),
                        );
                    }
                    if (
                        !Number.isSafeInteger(old.score) ||
                        Number(score) > old.score
                    ) {
                        for (const name of [
                            "btn_rate",
                            "long_rate",
                            "vol_rate",
                        ]) {
                            const raw = field(track, name);
                            if (
                                raw != null &&
                                raw !== "" &&
                                Number.isSafeInteger(Number(raw)) &&
                                Number(raw) >= 0
                            ) {
                                updated[name] = Number(raw);
                            }
                        }
                    }
                    records[key] = {
                        ...updated,
                        score: Math.max(
                            records[key]?.score || 0,
                            Number(score),
                        ),
                        clear_type: Math.max(
                            records[key]?.clear_type || 0,
                            Number(clear),
                        ),
                    };
                }
                receivedBest = true;
            }
            if (!receivedBest) return;
        }
        const values = Object.values(charts).sort((a, b) => b - a);
        const now = new Date().toISOString();
        const state: ServerDataSnapshot = {
            ...this.state,
            version: 1,
            source: "sv7_load_m",
            profile_id: profile,
            captured_at:
                route === "game.sv7_load_m" ? now : this.state!.captured_at,
            updated_at: now,
            chart_volforce: charts,
            chart_records: records,
            chart_count: values.length,
            total_volforce: values
                .slice(0, 50)
                .reduce((sum, vf) => sum + vf, 0),
        };
        const pending = this.pendingProfiles.get(profile);
        if (pending) Object.assign(state, pending);
        this.persist(state);
        this.recordHistory(state);
        this.pendingProfiles.clear();
        console.log(
            `Total VolForce: ${(state.total_volforce / 1000).toFixed(3)} (${values.length} saved charts)`,
        );
    }

    private recordHistory(state: ServerDataSnapshot): void {
        const best = Object.values(state.chart_volforce)
            .sort((a, b) => b - a)
            .slice(0, 50);
        const observation = {
            timestamp: state.updated_at,
            profile_id: state.profile_id,
            total_volforce: best.reduce((sum, vf) => sum + vf, 0),
            // VF uses integer thousandths: exceeding the 50th chart needs +1.
            minimum_volforce: best.length === 50 ? best[49] + 1 : null,
            top_count: best.length,
        };
        try {
            fs.mkdirSync(path.dirname(this.historyFilename), {
                recursive: true,
            });
            fs.appendFileSync(
                this.historyFilename,
                JSON.stringify(observation) + "\n",
                "utf8",
            );
        } catch (caught) {
            console.warn(
                "Cannot record VolForce history:",
                (caught as Error).message,
            );
        }
    }

    private persist(state: ServerDataSnapshot): void {
        fs.mkdirSync(path.dirname(this.filename), { recursive: true });
        const temporary = this.filename + ".tmp";
        fs.writeFileSync(temporary, JSON.stringify(state) + "\n", "utf8");
        fs.renameSync(temporary, this.filename);
        this.state = state;
    }
}
