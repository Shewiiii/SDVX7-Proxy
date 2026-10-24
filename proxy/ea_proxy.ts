// @ts-nocheck

const http = require("http");
const https = require("https");
const path = require("path");
const querystring = require("querystring");
const fs = require("fs");
const { TotalVolforceStore } = require("./total_volforce");
const { ChartLevelStore } = require("./music_db");
const repoRoot = path.resolve(__dirname, "..");
const totalVolforce = new TotalVolforceStore(
    path.join(repoRoot, "cache", "total_volforce.json"),
    process.env.TRACKER_VOLFORCE_HISTORY || path.join(repoRoot, "volforce_history.jsonl"),
);

const listenPort = Number(process.env.TRACKER_PROXY_PORT || 8080);
const upstreamUrl = new URL(
    process.env.TRACKER_UPSTREAM || "http://ea.ryu7w7.xyz",
);
const scoreLogPath =
    process.env.TRACKER_SCORE_LOG || path.join(repoRoot, "score_log.txt");
fs.mkdirSync(path.dirname(scoreLogPath), { recursive: true });
const ryuRoot = process.env.RYUNET_ROOT;

if (!ryuRoot) {
    throw new Error(
        "RYUNET_ROOT must point to the protocol decoder folder. Run setup.bat.",
    );
}

const { KonmaiEncrypt } = require(
    path.join(ryuRoot, "src/utils/KonmaiEncrypt"),
);
const LzKN = require(path.join(ryuRoot, "src/utils/LzKN")).default;
const KBin = require(path.join(ryuRoot, "src/utils/KBinJSON"));
const xmlParser = require(
    path.join(ryuRoot, "node_modules", "fast-xml-parser"),
);

const gameRoot = path.resolve(repoRoot, "..");
const musicDbPath = path.join(gameRoot, "data", "others", "music_db.xml");
const musicDbPaths = [
    musicDbPath,
    path.join(
        gameRoot,
        "data_mods",
        "ryunet_custom",
        "others",
        "music_db.merged.xml",
    ),
];
const chartLevelStore = new ChartLevelStore(musicDbPaths, (raw) => {
    const validation = xmlParser.validate(raw.toString("latin1"));
    if (validation !== true) throw new Error(validation.err.msg);
    return KBin.xmlToData(raw, KBin.detectXMLEncoding(raw));
});
chartLevelStore.refresh();

function calculatePlayVolforce(level, score, clearType) {
    const grades = [
        [9900000, 105],
        [9800000, 102],
        [9700000, 100],
        [9500000, 97],
        [9300000, 94],
        [9000000, 91],
        [8700000, 88],
        [7500000, 85],
        [6500000, 82],
        [0, 80],
    ];
    const clears = { 1: 50, 2: 100, 3: 102, 4: 104, 5: 106, 6: 110 };
    if (
        !Number.isFinite(level) ||
        level <= 0 ||
        !Number.isSafeInteger(score) ||
        score < 0 ||
        score > 10000000 ||
        !(clearType in clears)
    )
        return undefined;
    const grade = grades.find(([threshold]) => score >= threshold)[1];
    // Integer arithmetic avoids floating-point errors at truncation boundaries.
    const numerator =
        BigInt(Math.round(level * 10)) *
        BigInt(score) *
        BigInt(grade) *
        BigInt(clears[clearType]) *
        20n;
    return Number(numerator / 1000000000000n);
}

function first(value) {
    if (Array.isArray(value)) return value.length ? first(value[0]) : undefined;
    if (value && typeof value === "object" && "@content" in value) {
        return first(value["@content"]);
    }
    return value;
}

function number(value) {
    const result = Number(first(value));
    return Number.isFinite(result) ? result : undefined;
}

function field(node, name) {
    if (!node || typeof node !== "object") return undefined;
    if (name in node) return first(node[name]);
    if (node["@attr"] && name in node["@attr"])
        return first(node["@attr"][name]);
    return undefined;
}

function findTracks(value, result = []) {
    if (!value || typeof value !== "object") return result;
    if (Array.isArray(value)) {
        for (const item of value) findTracks(item, result);
        return result;
    }
    for (const [key, child] of Object.entries(value)) {
        if (key === "track") {
            for (const item of Array.isArray(child) ? child : [child]) {
                if (item && typeof item === "object") result.push(item);
            }
        } else if (key !== "@attr" && key !== "@content") {
            findTracks(child, result);
        }
    }
    return result;
}

function decodePayload(headers, raw) {
    // Decoders operate on a copy; forwarding always retains the original bytes.
    let body = Buffer.from(raw);
    const compressed = String(headers["x-compress"] || "none");
    const contentType = String(headers["content-type"] || "");

    if (contentType.includes("application/x-www-form-urlencoded")) {
        const form = querystring.parse(raw.toString("utf8"));
        if (form.request && form.protocol_version) {
            throw new Error(
                "EaCloud form payloads are not supported by this sidecar yet.",
            );
        }
    } else if (headers["x-eamuse-info"]) {
        body = new KonmaiEncrypt(String(headers["x-eamuse-info"])).encrypt(
            body,
        );
    }

    if (compressed === "lz77") body = LzKN.inflate(body);
    else if (compressed !== "none")
        throw new Error(`Unsupported X-Compress: ${compressed}`);
    if (
        headers["content-encoding"] &&
        headers["content-encoding"] !== "identity"
    )
        throw new Error("Unsupported HTTP Content-Encoding");

    let data;
    let encoding = "utf8";
    if (KBin.isKBin(body)) {
        encoding = KBin.kgetEncoding(body);
        data = KBin.kdecode(body);
    } else {
        encoding = KBin.detectXMLEncoding(body);
        data = KBin.xmlToData(body, encoding);
    }

    return { data, encoding };
}

function decodeRequest(req, raw) {
    const { data, encoding } = decodePayload(req.headers, raw);
    const call = data.call || {};
    const moduleName = call["@attr"]
        ? Object.keys(call).find((key) => key !== "@attr")
        : undefined;
    const moduleData = moduleName ? call[moduleName] : undefined;
    const methods = Array.isArray(moduleData) ? moduleData : [moduleData];
    const method = methods
        .map((item) => item && item["@attr"] && item["@attr"].method)
        .filter(Boolean)
        .join(".");

    return { data: moduleData, route: `${moduleName}.${method}`, encoding };
}

function captureJudgments(track) {
    const counts = {};
    const raw = {};
    const visit = (node, parts = []) => {
        if (!node || typeof node !== "object" || Buffer.isBuffer(node)) return;
        for (const [name, child] of Object.entries(node)) {
            if (name === "@content") continue;
            if (name === "@attr") {
                visit(child, parts);
                continue;
            }
            const pathParts = [...parts, name];
            if (/critical|\bjust\b|near|error|early|late|judg/i.test(name)) {
                let value = child;
                if (value && typeof value === "object" && "@content" in value)
                    value = value["@content"];
                if (Array.isArray(value) && value.length === 1)
                    value = value[0];
                if (
                    typeof value === "number" ||
                    typeof value === "string" ||
                    Array.isArray(value)
                )
                    raw[pathParts.join(".")] = value;
            }
            const normalized = pathParts
                .join("_")
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");
            const aliases = {
                scritical: "s_critical",
                just: "btfx_s_critical",
                critical: "critical_including_s_critical",
                near: "near",
                error: "error",
                early: "early",
                late: "late",
                earlycritical: "early_critical",
                criticalearly: "early_critical",
                earlynear: "early_near",
                nearearly: "early_near",
                earlyerror: "early_error",
                errorearly: "early_error",
                latecritical: "late_critical",
                criticallate: "late_critical",
                latenear: "late_near",
                nearlate: "late_near",
                lateerror: "late_error",
                errorlate: "late_error",
            };
            const key = aliases[normalized];
            let value = child;
            if (value && typeof value === "object" && "@content" in value)
                value = value["@content"];
            if (Array.isArray(value) && value.length === 1) value = value[0];
            if (
                key &&
                (typeof value === "number" ||
                    (typeof value === "string" && /^\d+$/.test(value)))
            ) {
                const count = Number(value);
                if (
                    Number.isSafeInteger(count) &&
                    count >= 0 &&
                    !(key in counts)
                )
                    counts[key] = count;
            }
            if (child && typeof child === "object" && !("@content" in child))
                visit(child, pathParts);
        }
    };
    visit(track);
    const histogram = raw.judge;
    if (
        Array.isArray(histogram) &&
        histogram.length === 7 &&
        histogram.every((count) => Number.isSafeInteger(count) && count >= 0) &&
        counts.near === histogram[0] + histogram[6]
    ) {
        // This layout omits ERROR: its outer bins match the scalar NEAR total.
        counts.early_near ??= histogram[0];
        counts.late_near ??= histogram[6];
        // The inner timing bins are not the result in-game's CRITICAL sides.
    }
    return { counts, raw, histogram };
}

function recoverScoreBreakdown(counts, sCriticalEnabled, exscore) {
    const total = counts.critical_including_s_critical;
    if (total === undefined) return;
    if (sCriticalEnabled === false) {
        counts.critical = total;
        return;
    }
    if (sCriticalEnabled !== true) return;
    const just = counts.btfx_s_critical;
    const near = counts.near;
    if (
        ![just, near, exscore].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
        )
    )
        return;
    // EX = 2*total + 3*SC_btfx + 2*C_btfx + 2*NEAR.
    const remainder = exscore - 2 * total - 3 * just - 2 * near;
    if (remainder < 0 || remainder % 2 || just + remainder / 2 > total) return;
    counts.critical = remainder / 2;
    counts.s_critical = total - counts.critical;
}

function writeResults(decoded) {
    if (!decoded.route || !decoded.route.endsWith("_save_m")) return;
    const chartLevels = chartLevelStore.refresh();

    for (const track of findTracks(decoded.data)) {
        const musicId = number(field(track, "music_id"));
        const diffIdx = number(field(track, "music_type"));
        const score = number(field(track, "score"));
        const clearType = number(field(track, "clear_type"));
        if (
            musicId === undefined ||
            diffIdx === undefined ||
            score === undefined
        )
            continue;
        const level = chartLevels.get(`${musicId}:${diffIdx}`);
        const volforce = calculatePlayVolforce(level, score, clearType);
        if (volforce === undefined) {
            console.warn(
                "Cannot calculate current-play VolForce: missing level or invalid score/clear type",
                {
                    musicId,
                    diffIdx,
                    level,
                    clearType,
                },
            );
            continue;
        }

        const judgments = captureJudgments(track);
        const resultOptions = Object.fromEntries(
            [
                "mode",
                "start_option",
                "gauge_type",
                "notes_option",
                "etc",
                "s_critical_enabled",
                "scritical_enabled",
                "critical_mode",
            ]
                .map((key) => [key, field(track, key)])
                .filter(([, value]) => value !== undefined && value !== null),
        );
        const explicitMode =
            resultOptions.s_critical_enabled ?? resultOptions.scritical_enabled;
        let sCriticalEnabled = [true, 1, "1", "true"].includes(explicitMode)
            ? true
            : [false, 0, "0", "false"].includes(explicitMode)
              ? false
              : undefined;
        if (
            sCriticalEnabled === undefined &&
            typeof resultOptions.etc === "string"
        ) {
            const match = resultOptions.etc.match(
                /(?:^|[,;]\s*)scr\s*:\s*([01])(?=\s*[,;]|$)/,
            );
            if (match) sCriticalEnabled = match[1] === "1";
        }
        recoverScoreBreakdown(
            judgments.counts,
            sCriticalEnabled,
            number(field(track, "exscore")),
        );
        if (!Object.keys(judgments.counts).length) {
            console.warn(
                "No recognized judgment counters. Judgment field names:",
                Object.keys(judgments.raw),
            );
        }
        const record = {
            music_id: musicId,
            diff_idx: diffIdx,
            score,
            clear_type: clearType,
            score_grade: number(field(track, "score_grade")) || 0,
            exscore: number(field(track, "exscore")) || 0,
            volforce,
            volforce_source: "updated",
            level,
            judgments: Object.fromEntries(
                Object.entries(judgments.counts).filter(
                    ([key]) =>
                        ![
                            "btfx_s_critical",
                            "critical_including_s_critical",
                        ].includes(key),
                ),
            ),
            raw_judgments: Object.fromEntries(
                Object.entries(judgments.raw)
                    .filter(([key]) => key !== "judge")
                    .map(([key, value]) => [
                        key === "just"
                            ? "btfx_s_critical"
                            : key === "critical"
                              ? "critical_including_s_critical"
                              : key,
                        value,
                    ]),
            ),
            timing_histogram: judgments.histogram,
            s_critical_enabled: sCriticalEnabled ?? null,
            result_options: resultOptions,
            received_at: new Date().toISOString(),
        };
        fs.appendFileSync(scoreLogPath, JSON.stringify(record) + "\n", "utf8");
        console.log("Captured VolForce", record);
    }
}

const serviceTargets = new Map();
const servicePrefix = "/__tracker/service/";

function rewriteServicesResponse(requestUrl, body, headers) {
    if (
        new URL(requestUrl, upstreamUrl).searchParams.get("f") !==
        "services.get"
    )
        return body;

    try {
        let plain = body;
        const key = headers["x-eamuse-info"]
            ? new KonmaiEncrypt(String(headers["x-eamuse-info"]))
            : undefined;
        if (key) plain = key.encrypt(plain);
        const compression = String(headers["x-compress"] || "none");
        if (compression === "lz77") plain = LzKN.inflate(plain);
        else if (compression !== "none")
            throw new Error(`Unsupported X-Compress: ${compression}`);
        if (
            headers["content-encoding"] &&
            headers["content-encoding"] !== "identity"
        )
            throw new Error("Unsupported HTTP Content-Encoding");

        const binary = KBin.isKBin(plain);
        const encoding = binary
            ? KBin.kgetEncoding(plain)
            : KBin.detectXMLEncoding(plain);
        const decoded = binary
            ? KBin.kdecode(plain)
            : KBin.xmlToData(plain, encoding);
        const items = decoded?.response?.services?.item;
        if (!items) throw new Error("Missing response.services.item");
        const targets = new Map();
        for (const item of Array.isArray(items) ? items : [items]) {
            const attrs = item["@attr"];
            if (
                !attrs?.url ||
                !attrs.name ||
                ["ntp", "keepalive"].includes(attrs.name)
            )
                continue;
            const target = new URL(attrs.url);
            if (!["http:", "https:"].includes(target.protocol)) continue;
            const name = encodeURIComponent(attrs.name);
            targets.set(name, target);
            attrs.url = `http://127.0.0.1:${listenPort}${servicePrefix}${name}${target.pathname}${target.search}`;
        }
        if (!targets.size) throw new Error("No HTTP service endpoints found");
        let response = binary
            ? KBin.kencode(decoded, encoding, plain[1] === 0x42)
            : KBin.dataToXMLBuffer(decoded, { encoding });
        if (compression === "lz77") response = LzKN.deflate(response);
        if (key) response = key.encrypt(response);
        for (const [name, target] of targets) serviceTargets.set(name, target);
        console.log(
            `Rewrote ${targets.size} service endpoints (format=${binary ? "KBin" : "XML"}, x-compress=${compression}, encrypted=${Boolean(key)})`,
        );
        return response;
    } catch (error) {
        console.error(
            "services.get rewrite failed. Forwarding original response:",
            error.message,
        );
        return body;
    }
}

function forwardingTarget(requestUrl) {
    const incoming = new URL(requestUrl, upstreamUrl);
    if (incoming.pathname.startsWith(servicePrefix)) {
        const rest = incoming.pathname.slice(servicePrefix.length);
        const slash = rest.indexOf("/");
        const name = slash < 0 ? rest : rest.slice(0, slash);
        const target = serviceTargets.get(name);
        if (!target)
            throw new Error(
                "Unknown service endpoint. Restart the game to refresh discovery",
            );
        return new URL(
            `${slash < 0 ? "/" : rest.slice(slash)}${incoming.search}`,
            target.origin,
        );
    }
    return new URL(
        `${upstreamUrl.pathname.replace(/\/$/, "")}${incoming.pathname}${incoming.search}`,
        upstreamUrl.origin,
    );
}

const server = http.createServer((req, res) => {
    console.log(`Incoming ${req.method} ${req.url}`);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        const body = Buffer.concat(chunks);
        let decodedRequest;
        try {
            if (req.method === "POST") {
                decodedRequest = decodeRequest(req, body);
                writeResults(decodedRequest);
            }
        } catch (error) {
            console.error("Could not decode request:", error.message);
        }
        let target;
        try {
            target = forwardingTarget(req.url || "/");
        } catch (error) {
            console.error("Cannot forward request:", error.message);
            res.writeHead(502);
            res.end("Bad gateway");
            return;
        }
        const headers = { ...req.headers, host: target.host };
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        headers["content-length"] = body.length;

        const client = target.protocol === "https:" ? https : http;
        const upstream = client.request(
            {
                hostname: target.hostname,
                port: target.port || (target.protocol === "https:" ? 443 : 80),
                method: req.method,
                path: `${target.pathname}${target.search}`,
                headers,
            },
            (upstreamResponse) => {
                const responseChunks = [];
                upstreamResponse.on("data", (chunk) =>
                    responseChunks.push(chunk),
                );
                upstreamResponse.on("end", () => {
                    const upstreamBody = Buffer.concat(responseChunks);
                    if (
                        upstreamResponse.statusCode === 200 &&
                        [
                            "game.sv7_load",
                            "game.sv7_load_m",
                            "game.sv7_save_m",
                            "game.sv7_save",
                        ].includes(decodedRequest?.route)
                    ) {
                        try {
                            const response = decodePayload(
                                upstreamResponse.headers,
                                upstreamBody,
                            ).data;
                            const refid =
                                field(decodedRequest.data, "refid") ||
                                field(decodedRequest.data, "dataid");
                            totalVolforce.capture(
                                decodedRequest.route,
                                refid,
                                response.response?.game,
                                findTracks(decodedRequest.data),
                                field,
                                decodedRequest.data,
                            );
                        } catch (error) {
                            console.error(
                                "Could not capture player profile:",
                                error.message,
                            );
                        }
                    }
                    const responseBody =
                        upstreamResponse.statusCode === 200
                            ? rewriteServicesResponse(
                                  req.url || "",
                                  upstreamBody,
                                  upstreamResponse.headers,
                              )
                            : upstreamBody;
                    if ((req.url || "").includes("f=services.get")) {
                        console.log(
                            `services.get response ${upstreamResponse.statusCode || 502}. ` +
                                `type=${upstreamResponse.headers["content-type"] || "unknown"}. ` +
                                `encoding=${upstreamResponse.headers["content-encoding"] || "identity"}. ` +
                                `bytes=${upstreamBody.length}->${responseBody.length}`,
                        );
                    }
                    const responseHeaders = { ...upstreamResponse.headers };
                    if (responseBody !== upstreamBody) {
                        delete responseHeaders.etag;
                        delete responseHeaders["content-md5"];
                    }
                    delete responseHeaders["content-length"];
                    delete responseHeaders["transfer-encoding"];
                    responseHeaders["content-length"] = responseBody.length;
                    res.writeHead(
                        upstreamResponse.statusCode || 502,
                        responseHeaders,
                    );
                    res.end(responseBody);
                });
            },
        );

        upstream.on("error", (error) => {
            console.error("Upstream request failed:", error.message);
            if (!res.headersSent) res.writeHead(502);
            res.end("Bad gateway");
        });
        upstream.write(body);
        upstream.end();
    });
});

server.listen(listenPort, "127.0.0.1", () => {
    console.log(
        `SDVX ∇ VolForce Tracker listening on http://127.0.0.1:${listenPort}`,
    );
    console.log(`Forwarding to ${upstreamUrl.origin}`);
    console.log(`Writing results to ${scoreLogPath}`);
});
