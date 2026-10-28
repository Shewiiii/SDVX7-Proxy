// @ts-nocheck

const fs = require("node:fs");
const path = require("node:path");

const axes = /^(notes|peak|tsumami|tricky|onehand|handtrip|one_hand|hand_trip|power|earned_power)$/i;
const sensitive = /refid|dataid|card|token|session|password|passwd|secret|auth|name|code|address|email/i;

function inspect(node) {
    const schema = {};
    const candidates = {};
    let visited = 0;
    let truncated = false;

    function visit(value, parts, radarContext = false, depth = 0) {
        if (++visited > 30000 || depth > 24) {
            truncated = true;
            return;
        }
        const key = parts.join(".");

        if (Buffer.isBuffer(value)) {
            schema[key] = { type: "buffer", length: value.length };
            return;
        }

        if (Array.isArray(value)) {
            schema[key] = { type: "array", length: value.length };
            if (radarContext && value.every(Number.isFinite)) {
                candidates[key] = value.slice(0, 512);
                if (value.length > 512) truncated = true;
            } else {
                if (value.length > 3) truncated = true;
                value.slice(0, 3).forEach((item, index) => {
                    visit(item, [...parts, String(index)], radarContext, depth + 1);
                });
            }
            return;
        }

        if (value && typeof value === "object") {
            for (const [name, child] of Object.entries(value)) {
                if (sensitive.test(name)) continue;
                visit(
                    child,
                    [...parts, name],
                    radarContext || /radar|variant_gate/i.test(name) || axes.test(name),
                    depth + 1,
                );
            }
            return;
        }

        schema[key] = { type: value === null ? "null" : typeof value };
        if (radarContext && typeof value === "number" && Number.isFinite(value)) {
            candidates[key] = value;
        }
    }

    visit(node, []);
    return { schema, candidates, truncated };
}

function numericContent(node, limit = 1024) {
    const value = node && typeof node === "object" && "@content" in node
        ? node["@content"]
        : node;
    if (Number.isSafeInteger(value)) return [value];
    if (!Array.isArray(value) || value.length > limit) return undefined;
    if (!value.every(Number.isSafeInteger)) return undefined;
    return value.slice();
}

function parameterRecords(node, scores = false) {
    const entries = (scores ? node?.music : node?.param)?.info;
    if (!entries) return [];
    const records = [];

    for (const entry of Array.isArray(entries) ? entries : [entries]) {
        const param = numericContent(entry?.param, scores ? 26 : 1024);
        if (!param || (scores && param.length !== 26)) continue;
        if (scores) {
            records.push({ param });
        } else {
            const type = numericContent(entry?.type, 1)?.[0];
            const id = numericContent(entry?.id, 1)?.[0];
            if (type === undefined || id === undefined) continue;
            records.push({ type, id, param });
        }
    }

    return records;
}

function captureRadarProbe(playerDataRoot, route, request, response) {
    if (process.env.RADAR_PROBE !== "1") return;
    if (!["game.sv7_load", "game.sv7_load_m", "game.sv7_save"].includes(route)) return;

    try {
        const directory = path.join(playerDataRoot, "radar-probe");
        fs.mkdirSync(directory, { recursive: true });
        const report = {
            captured_at: new Date().toISOString(),
            route,
            response: route === "game.sv7_load_m"
                ? { score_records: parameterRecords(response, true) }
                : { ...inspect(response), profile_parameters: parameterRecords(response) },
            request: { ...inspect(request), profile_parameters: parameterRecords(request) },
        };
        const filename = path.join(directory, `${route}.json`);
        fs.writeFileSync(filename, JSON.stringify(report, null, 2) + "\n");
        console.log(`[radar probe] Saved ${filename}`);
    } catch (error) {
        console.warn("Radar probe failed:", error.message);
    }
}

module.exports = { captureRadarProbe, inspect, numericContent, parameterRecords };
