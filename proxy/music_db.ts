// @ts-nocheck

import fs = require("node:fs");

const difficultyTags = [
    ["novice"],
    ["advanced"],
    ["exhaust"],
    ["infinite", "gravity", "heaven", "vivid", "exceed", "nabla"],
    ["maximum"],
    ["ultimate"],
];

function value(node: any): any {
    if (Array.isArray(node)) return value(node[0]);
    if (node && typeof node === "object" && "@content" in node)
        return value(node["@content"]);
    return node;
}

export class ChartLevelStore {
    private signatures = new Map<string, string>();
    private sources = new Map<string, Map<string, number>>();
    private levels = new Map<string, number>();

    constructor(
        private readonly paths: string[],
        private readonly decodeXml: (raw: Buffer) => any,
    ) {}

    refresh(): Map<string, number> {
        let changed = false;
        for (const filename of this.paths) {
            let stat: fs.Stats;
            try {
                stat = fs.statSync(filename);
            } catch (caught) {
                const error = caught as NodeJS.ErrnoException;
                if (error.code === "ENOENT") {
                    changed = this.sources.delete(filename) || changed;
                    this.signatures.delete(filename);
                } else
                    console.warn(
                        "Cannot inspect music database:",
                        filename,
                        error.message,
                    );
                continue;
            }
            const signature = `${stat.mtimeMs}:${stat.size}`;
            if (this.signatures.get(filename) === signature) continue;
            try {
                const db = this.decodeXml(fs.readFileSync(filename));
                if (!db.mdb) throw new Error("Expected an mdb music database");
                const entries = db.mdb.music || [];
                const source = new Map<string, number>();
                for (const music of Array.isArray(entries)
                    ? entries
                    : [entries]) {
                    const id = Number(value(music.id ?? music["@attr"]?.id));
                    if (!Number.isSafeInteger(id) || id <= 0) continue;
                    difficultyTags.forEach((tags, index) => {
                        const chart = tags
                            .map((tag) => music.difficulty?.[tag])
                            .find(Boolean);
                        const raw = value(chart?.difnum);
                        if (raw == null || raw === "") return;
                        const level = Number(raw);
                        if (!Number.isFinite(level) || level < 0) return;
                        source.set(`${id}:${index}`, level / 10);
                    });
                }
                this.sources.set(filename, source);
                this.signatures.set(filename, signature);
                changed = true;
            } catch (caught) {
                // A sync may briefly leave a file incomplete; retry next result.
                console.warn(
                    "Cannot load music database:",
                    filename,
                    (caught as Error).message,
                );
            }
        }
        if (changed) {
            this.levels = new Map();
            for (const filename of this.paths)
                this.sources
                    .get(filename)
                    ?.forEach((level, key) => this.levels.set(key, level));
            console.log(
                `Loaded ${this.levels.size} original/custom chart levels for current-play VolForce`,
            );
        }
        return this.levels;
    }
}
