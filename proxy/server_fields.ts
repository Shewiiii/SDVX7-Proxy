// @ts-nocheck

const PROFILE_FIELDS = [
    "skill_level",
    "skill_base_id",
    "skill_name_id",
    "skill_type",
    "gamecoin_packet",
    "gamecoin_block",
    "blaster_energy",
    "appeal_id",
    "play_count",
    "day_count",
    "today_count",
    "week_count",
    "week_play_count",
    "play_chain",
    "week_chain",
    "max_play_chain",
    "max_week_chain",
];
const OPTION_FIELDS = [
    "last_music_id",
    "last_music_type",
    "sort_type",
    "headphone",
    "hispeed",
    "lanespeed",
    "gauge_option",
    "ars_option",
    "notes_option",
    "early_late_disp",
    "draw_adjust",
    "eff_c_left",
    "eff_c_right",
    "narrow_down",
];
const AXES = ["notes", "peak", "tsumami", "tricky", "handtrip", "onehand"];

function integers(node, limit = 1024) {
    const value =
        node && typeof node === "object" && "@content" in node
            ? node["@content"]
            : node;
    const values = Array.isArray(value) ? value : [value];
    if (values.length > limit || !values.every(Number.isSafeInteger))
        return undefined;
    return values.slice();
}

function scalar(node, key, field) {
    const raw = field(node, key);
    if (raw === undefined || raw === null || raw === "") return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
}

function numericFields(node, names, field) {
    const result = {};
    for (const name of names) {
        const value = scalar(node, name, field);
        if (value !== undefined) result[name] = value;
    }
    return result;
}

function mergeParameters(previous = [], node) {
    const entries = node?.param?.info || [];
    const merged = new Map(
        previous.map((entry) => [`${entry.type}:${entry.id}`, entry]),
    );
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
        const type = integers(entry?.type, 1)?.[0];
        const id = integers(entry?.id, 1)?.[0];
        const param = integers(entry?.param);
        if (type === undefined || id === undefined || !param) continue;
        merged.set(`${type}:${id}`, { type, id, param });
    }
    return [...merged.values()];
}

function variantData(node, field, previous, saving = false) {
    const variant = node?.variant_gate;
    if (!variant || typeof variant !== "object" || Array.isArray(variant))
        return previous;
    const result = saving ? { ...previous } : {};
    const power = scalar(variant, saving ? "earned_power" : "power", field);
    if (
        power !== undefined &&
        (!saving || Number.isSafeInteger(result.power))
    ) {
        result.power = saving ? result.power + power : power;
    }
    const elements = numericFields(
        variant[saving ? "earned_element" : "element"],
        AXES,
        field,
    );
    if (saving) {
        result.element = { ...result.element };
        for (const [axis, earned] of Object.entries(elements)) {
            if (Number.isSafeInteger(result.element[axis]))
                result.element[axis] += earned;
        }
    } else {
        result.element = elements;
    }
    const radar = integers(variant.over_radar, 6);
    if (radar?.length === 6) result.over_radar = radar;
    return result;
}

function profileData(node, field, previous = {}, saving = false) {
    const now = new Date().toISOString();
    const player = saving ? { ...previous.player } : {};
    if (!saving) {
        for (const name of ["name", "code", "sdvx_id"]) {
            const value = field(node, name);
            if (typeof value === "string" && value.trim())
                player[name] = value.slice(0, 100);
        }
    }
    const fields = saving
        ? [
              "appeal_id",
              "skill_level",
              "skill_base_id",
              "skill_name_id",
              "skill_type",
          ]
        : PROFILE_FIELDS;
    Object.assign(player, numericFields(node, fields, field));
    return {
        player,
        player_updated_at: now,
        profile_data_captured_at: saving
            ? previous.profile_data_captured_at
            : now,
        profile_data_updated_at: now,
        profile_options: {
            ...(saving ? previous.profile_options : {}),
            ...numericFields(node, OPTION_FIELDS, field),
        },
        profile_parameters: mergeParameters(
            saving ? previous.profile_parameters : [],
            node,
        ),
        variant_gate: variantData(node, field, previous.variant_gate, saving),
    };
}

function chartRecord(param) {
    if (
        !Array.isArray(param) ||
        param.length !== 26 ||
        !param.every((value) => Number.isSafeInteger(value) && value >= 0)
    ) {
        throw new Error("Invalid sv7_load_m chart parameters");
    }
    const previous = param[2] === 0 && param[4] === 0;
    const record = {
        score: param[previous ? 12 : 2],
        exscore: param[previous ? 13 : 3],
        clear_type: param[previous ? 14 : 4],
        score_grade: param[previous ? 15 : 5],
        btn_rate: param[8],
        long_rate: param[9],
        vol_rate: param[10],
    };
    if (record.score > 10000000 || record.clear_type > 6) {
        throw new Error("Invalid saved chart score or clear type");
    }
    if (param.slice(12, 16).some((value) => value > 0)) {
        record.previous_version = {
            score: param[12],
            exscore: param[13],
            clear_type: param[14],
            score_grade: param[15],
        };
    }
    if (param.slice(18, 21).some((value) => value > 0)) {
        record.konasute = {
            score: param[18],
            clear_type: param[19],
            score_grade: param[20],
        };
    }
    return record;
}

module.exports = { profileData, chartRecord, integers };
