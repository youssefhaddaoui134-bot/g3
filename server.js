// =============================================
// FOOTBALL LIVE SERVER
// =============================================

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

require.extensions[".ts"] = require.extensions[".js"];

const app = express();


// =============================================
// SETTINGS
// =============================================

const PORT = process.env.PORT || 8000;

const GOAL_API_KEY =
    process.env.GOAL_API_KEY;

const HAS_API_KEY =
    Boolean(GOAL_API_KEY) &&
    GOAL_API_KEY !== "YOUR_GOAL_API_KEY_HERE";

const API_URL =
    "https://api.goal-api.com/v1";

const BZZOIRO_API_URL =
    "https://sports.bzzoiro.com/api/v2";

const BZZOIRO_API_KEY =
    process.env.BZZOIRO_API_KEY || "";

const FALLBACK_LOGO_PATH =
    path.join(__dirname, "site-logo.svg");

const POSTER_EDITOR_DB_PATH =
    path.join(__dirname, "data", "app.sqlite");

const LEGACY_POSTER_EDITOR_STATE_PATH =
    path.join(__dirname, "data", "poster-editor-state.json");

fs.mkdirSync(path.dirname(POSTER_EDITOR_DB_PATH), { recursive: true });

const posterEditorDatabase = new DatabaseSync(POSTER_EDITOR_DB_PATH);
posterEditorDatabase.exec(`
    CREATE TABLE IF NOT EXISTS poster_editor_state (
        state_key TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
`);

const getPosterEditorState = posterEditorDatabase.prepare(
    "SELECT state_json, updated_at FROM poster_editor_state WHERE state_key = ?"
);

const savePosterEditorState = posterEditorDatabase.prepare(`
    INSERT INTO poster_editor_state (state_key, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
`);

const FOOTBALL_MEDIA_BASE_URL =
    "https://media.api-sports.io/football";

const FOOTBALL_LOGO_CATALOG_URL =
    "https://football-logos.cc/ac-v2.json";

const FOOTBALL_LOGO_ASSET_BASE_URL =
    "https://assets.football-logos.cc/logos";

let footballLogoCatalog = [];
let footballLogoCatalogExpiresAt = 0;
let footballLogoCatalogPromise = null;

async function loadFootballLogoCatalog() {
    if (footballLogoCatalogPromise) return footballLogoCatalogPromise;

    footballLogoCatalogPromise = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
            const response = await fetch(FOOTBALL_LOGO_CATALOG_URL, {
                signal: controller.signal,
                headers: { "User-Agent": "Mozilla/5.0" }
            });
            if (!response.ok) throw new Error(`Logo catalog returned ${response.status}`);

            const catalog = await response.json();
            if (!Array.isArray(catalog)) throw new Error("Invalid logo catalog response");

            footballLogoCatalog = catalog.filter(item =>
                item && typeof item.id === "string" && typeof item.categoryId === "string"
                && typeof item.h === "string" && (item.hasPng || item.hasSvg)
            );
            footballLogoCatalogExpiresAt = Date.now() + (6 * 60 * 60 * 1000);
        }
        catch (error) {
            footballLogoCatalogExpiresAt = Date.now() + (60 * 1000);
            console.warn("تعذر تحميل فهرس الشعارات عالية الجودة:", error.message);
        }
        finally {
            clearTimeout(timeout);
            footballLogoCatalogPromise = null;
        }

        return footballLogoCatalog;
    })();

    return footballLogoCatalogPromise;
}

async function ensureFootballLogoCatalog() {
    if (Date.now() < footballLogoCatalogExpiresAt) return footballLogoCatalog;
    return loadFootballLogoCatalog();
}

app.use("/api", async (req, res, next) => {
    if (/^\/api\/(?:fixtures(?:\/|\?|$)|leagues(?:\?|$)|standings\/|league-fixtures\/|teams\/|top-scorers\/)/.test(req.originalUrl)) {
        await ensureFootballLogoCatalog();
    }
    next();
});

app.use(
    express.json()
);

app.use("/data", (req, res) => res.sendStatus(404));


// =============================================
// STATIC FILES
// =============================================

app.use(
    express.static(
        __dirname
    )
);

app.get("/match/:id", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});


// Proxy external team logos so previews and downloads are not blocked by CORS.
function sendFallbackLogo(res) {
        res.set("Cache-Control", "public, max-age=86400");
        return res.sendFile(FALLBACK_LOGO_PATH);
}

const footballLogoAssetCache = new Map();

async function resolveFootballLogoAsset(entry) {
    const cacheKey = `${entry.categoryId}/${entry.id}`;
    if (footballLogoAssetCache.has(cacheKey)) return footballLogoAssetCache.get(cacheKey);

    const category = entry.categoryId === "tournaments" ? "tournaments" : entry.categoryId;
    const pagePath = entry.categoryId === "tournaments"
        ? `/tournaments/${encodeURIComponent(entry.id)}/`
        : `/${encodeURIComponent(category)}/${encodeURIComponent(entry.id)}/`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetch(`https://football-logos.cc${pagePath}`, {
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (!response.ok) return "";

        const page = await response.text();
        const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(
            `https://assets\\.football-logos\\.cc/logos/${escapeRegExp(category)}/700x700/${escapeRegExp(entry.id)}\\.[a-f0-9]+\\.png`,
            "i"
        );
        const assetUrl = page.match(pattern)?.[0] || "";
        if (assetUrl) footballLogoAssetCache.set(cacheKey, assetUrl);
        return assetUrl;
    }
    catch (error) {
        console.warn(`تعذر تحديد الشعار عالي الجودة ${cacheKey}:`, error.message);
        return "";
    }
    finally {
        clearTimeout(timeout);
    }
}

app.get("/api/football-logo/:categoryId/:id", async (req, res) => {
    await ensureFootballLogoCatalog();
    const requireHighQuality = req.query.quality === "high";
    const entry = footballLogoCatalog.find(item =>
        item.categoryId === req.params.categoryId && item.id === req.params.id
    );
    if (!entry) return requireHighQuality ? res.sendStatus(404) : sendFallbackLogo(res);

    const highQualityAssetUrl = await resolveFootballLogoAsset(entry);
    const assetUrl = highQualityAssetUrl
        || (!requireHighQuality
            ? `${FOOTBALL_LOGO_ASSET_BASE_URL}/${encodeURIComponent(entry.categoryId)}/64x64/${encodeURIComponent(entry.id)}.${entry.h}.png`
            : "");
    if (!assetUrl) return requireHighQuality ? res.sendStatus(404) : sendFallbackLogo(res);

    try {
        const response = await fetch(assetUrl, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
            return requireHighQuality ? res.sendStatus(404) : sendFallbackLogo(res);
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Cross-Origin-Resource-Policy", "cross-origin");
        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=86400");
        res.set("Content-Length", String(bytes.length));
        return res.send(bytes);
    }
    catch (error) {
        if (requireHighQuality) {
            console.warn(`تعذر جلب نسخة عالية الجودة للشعار ${entry.id}:`, error.message);
            return res.sendStatus(502);
        }
        return sendFallbackLogo(res);
    }
});

app.get("/api/logo", async (req, res) => {

    const logoUrl = req.query.url;

    if (!logoUrl || !/^https?:\/\//i.test(logoUrl)) {
        return sendFallbackLogo(res);
    }

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.set("Timing-Allow-Origin", "*");

    try {
        const response = await fetch(logoUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });

        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
            return sendFallbackLogo(res);
        }

        const bytes = Buffer.from(await response.arrayBuffer());

        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=604800, immutable");
        res.set("Content-Length", String(bytes.length));
        res.send(bytes);
    }
    catch (error) {
        sendFallbackLogo(res);
    }
});

// Return national flags as circular SVG images instead of rectangular files.
app.get("/api/national-logo/:code", async (req, res) => {
    const code = String(req.params.code || "").toLowerCase();

    if (!/^[a-z]{2}(?:-[a-z]{3})?$/.test(code)) {
        return res.status(400).send("Invalid country code");
    }

    try {
        const response = await fetch(`${NATIONAL_FLAG_BASE_URL}/${code}.svg`, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });

        if (!response.ok) {
            return sendFallbackLogo(res);
        }

        const contentType = response.headers.get("content-type") || "image/svg+xml";
        const bytes = Buffer.from(await response.arrayBuffer());
        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=604800, immutable");
        res.set("Content-Length", String(bytes.length));
        res.send(bytes);
    }
    catch (error) {
        sendFallbackLogo(res);
    }
});


// =============================================
// API KEY CHECK
// =============================================

if (!HAS_API_KEY) {

    console.log("");
    console.log("=================================");
    console.log("❌ GOAL_API_KEY غير موجود");
    console.log("ضع GOAL_API_KEY في ملف .env");
    console.log("=================================");
    console.log("");

}


// =============================================
// LOAD TRANSLATIONS
// =============================================

let translations = {

    teams: {},

    leagueIds: {},

    leagueCountry: {},

    leagues: {},

    countries: {}

};


try {

    const manualTranslations =
        require("./translations.ts");

    translations = {

        teams:
            {
                ...(manualTranslations.teamTranslations || {})
            },


        leagueIds:
            {
                ...(manualTranslations.leagueIdTranslations || {})
            },


        leagueCountry: {},


        leagues:
            {
                ...(manualTranslations.leagueTranslations || {})
            },

        teamLogoUrls: {
            ...(manualTranslations.teamLogoUrls || {})
        },

        leagueLogoUrls: {
            ...(manualTranslations.leagueLogoUrls || {})
        },


        countries: {}

    };


    console.log(
        "✅ translations.js تم تحميله بنجاح"
    );


    console.log(
        "⚽ عدد الفرق:",
        Object.keys(
            translations.teams
        ).length
    );


    console.log(
        "🏆 عدد البطولات حسب ID:",
        Object.keys(
            translations.leagueIds
        ).length
    );


    console.log(
        "🌍 عدد البطولات حسب الدولة:",
        Object.keys(
            translations.leagueCountry
        ).length
    );


}
catch (error) {

    console.error("");

    console.error(
        "❌ خطأ في تحميل translations.js"
    );

    console.error(
        error.message
    );

    console.error("");

}


// =============================================
// NORMALIZE TEXT
// تنظيف النص قبل المقارنة
// =============================================

function normalizeName(name) {

    if (!name) {

        return "";

    }


    return String(name)

        .trim()

        .toLowerCase()

        .replace(/\s+/g, " ")

        .replace(/[’'`]/g, "")

        .replace(/-/g, " ");

}


// =============================================
// FIND TRANSLATION
// =============================================

function findTranslation(
    object,
    name
) {

    if (
        !object ||
        !name
    ) {

        return null;

    }


    // =========================================
    // DIRECT SEARCH
    // =========================================

    if (
        object[name]
    ) {

        return object[name];

    }


    // =========================================
    // NORMALIZED SEARCH
    // =========================================

    const normalizedName =
        normalizeName(name);


    for (
        const key of Object.keys(object)
    ) {

        if (
            normalizeName(key)
            ===
            normalizedName
        ) {

            return object[key];

        }

    }


    return null;

}

function getManualLogo(value, type) {
    const logos = translations[type] || {};
    if (!value || typeof value !== 'object' && !String(value).trim()) return '';

    const source = typeof value === 'object' ? value : { name: value };
    const candidates = [
        source.id,
        source.teamId,
        source.leagueId,
        source.name,
        source.originalName,
        source.teamName,
        source.leagueName
    ].filter(Boolean);

    for (const candidate of candidates) {
        const logo = findTranslation(logos, String(candidate));
        if (logo) return logo;
    }

    return '';
}

function normalizeFootballLogoName(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function footballLogoNameVariants(value, kind) {
    const normalized = normalizeFootballLogoName(value);
    if (!normalized) return [];

    const variants = [normalized];
    const withoutClubSuffix = normalized
        .replace(/\b(?:football club|fc|cf|sc|afc|cfc)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (withoutClubSuffix && withoutClubSuffix !== normalized) variants.push(withoutClubSuffix);
    if (kind === "leagues") {
        const withoutSeason = normalized
            .replace(/\b(?:19|20)\d{2}(?:\s*[-/]\s*(?:19|20)?\d{2})?\b/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (withoutSeason && withoutSeason !== normalized) variants.push(withoutSeason);

        const withoutStage = withoutSeason
            .replace(/\b(?:league phase|group stage|qualification(?: round)?|qualifiers?|preliminary round|play[\s-]?offs?|round of \d+|semi[\s-]?finals?)\b.*$/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (withoutStage && withoutStage !== withoutSeason) variants.push(withoutStage);
    }

    return variants.filter(variant => variant.length >= 4);
}

function findHighQualityFootballLogo(value, kind) {
    const source = value && typeof value === "object" ? value : { name: value };
    const teamName = source.name || source.teamName || source.originalName;
    const isNationalTeam = kind === "teams" && Boolean(getNationalTeamFlagLogo(teamName));
    const names = [source.name, source.originalName, source.teamName, source.leagueName]
        .filter(Boolean)
        .map(String);
    if (kind === "leagues") {
        for (const name of [...names]) {
            for (const [englishName, translatedName] of Object.entries(translations.leagues || {})) {
                if (normalizeName(translatedName) === normalizeName(name)) {
                    names.push(englishName);
                }
            }
        }
    }
    const searchNames = [...names, ...(isNationalTeam ? names.map(name => `${name} National Team`) : [])];
    const queries = [...new Set(searchNames.flatMap(name => footballLogoNameVariants(name, kind)))];
    if (!queries.length) return "";

    const scores = new Map();

    for (const item of footballLogoCatalog) {
        const nationalEntry = /-national-team$/.test(item.id);
        if (kind === "teams" && nationalEntry !== isNationalTeam) continue;
        if (kind === "teams" && item.categoryId === "tournaments") continue;
        if (kind === "leagues" && nationalEntry) continue;

        const itemName = normalizeFootballLogoName(item.name);
        const itemId = normalizeFootballLogoName(item.id.replace(/-/g, " "));
        const searchText = normalizeFootballLogoName(item.searchText || "");
        let itemScore = 0;
        for (const query of queries) {
            let score = 0;
            if (itemName === query) score = 120;
            else if (itemId === query) score = 115;
            else if (kind === "leagues" && ` ${searchText} `.includes(` ${query} `)) score = 105;

            if (score && kind === "leagues" && item.categoryId === "tournaments") score += 5;
            itemScore = Math.max(itemScore, score);
        }
        if (itemScore) scores.set(item, itemScore);
    }

    const bestScore = [...scores.values()].reduce((highest, score) => Math.max(highest, score), 0);
    const bestMatches = [...scores.entries()]
        .filter(([, score]) => score === bestScore)
        .map(([item]) => item);
    const bestMatch = kind === "leagues" && bestMatches.length !== 1 ? null : bestMatches[0];
    if (!bestMatch?.hasPng) return "";
    const qualityQuery = kind === "leagues" ? "?quality=high" : "";
    return `/api/football-logo/${encodeURIComponent(bestMatch.categoryId)}/${encodeURIComponent(bestMatch.id)}${qualityQuery}`;
}

function getFootballMediaLogo(value, kind) {
    if (kind === "leagues") {
        return findHighQualityFootballLogo(value, kind);
    }

    const manualLogo = getManualLogo(value, kind === "leagues" ? "leagueLogoUrls" : "teamLogoUrls");
    if (manualLogo) return manualLogo;

    const source = value && typeof value === "object" ? value : {};
    const highQualityLogo = findHighQualityFootballLogo(value, kind);
    if (highQualityLogo) return highQualityLogo;

    const id = source.id || source.teamId || source.leagueId;
    const apiLogo = id && /^\d+$/.test(String(id))
        ? `${FOOTBALL_MEDIA_BASE_URL}/${kind}/${encodeURIComponent(id)}.png`
        : '';
    if (apiLogo) return apiLogo;

    return '';
}


// =============================================
// NATIONAL TEAM FLAGS
//
// لعرض شعار المنتخبات الوطنية كعلم دائري بسيط
// (بدون شعار الاتحاد، بدون نجوم، بدون أي رموز إضافية)
// نستعمل صور الأعلام الأصلية بنسبة 3:2 من FlagCDN.
//
// المصدر: https://cdn.jsdelivr.net/gh/HatScripts/circle-flags
// الصيغة: https://cdn.jsdelivr.net/gh/HatScripts/circle-flags/flags/{كود الدولة}.svg
// =============================================

const NATIONAL_FLAG_BASE_URL =
    "https://cdn.jsdelivr.net/gh/HatScripts/circle-flags/flags";

// خريطة: اسم المنتخب (كما يرد من مزود البيانات، بالإنجليزية غالباً) => كود الدولة (ISO 3166-1 alpha-2)
// تشمل أهم الأسماء البديلة (Aliases) الشائعة عند مزودي بيانات كرة القدم
const NATIONAL_TEAM_COUNTRY_CODES = {

    // ===================== أفريقيا =====================
    "Morocco": "ma",
    "Algeria": "dz",
    "Tunisia": "tn",
    "Libya": "ly",
    "Egypt": "eg",
    "Sudan": "sd",
    "South Sudan": "ss",
    "Mauritania": "mr",
    "Senegal": "sn",
    "Gambia": "gm",
    "Guinea-Bissau": "gw",
    "Guinea": "gn",
    "Sierra Leone": "sl",
    "Liberia": "lr",
    "Ivory Coast": "ci",
    "Côte d'Ivoire": "ci",
    "Cote d'Ivoire": "ci",
    "Ghana": "gh",
    "Togo": "tg",
    "Benin": "bj",
    "Nigeria": "ng",
    "Niger": "ne",
    "Burkina Faso": "bf",
    "Mali": "ml",
    "Cape Verde": "cv",
    "Cape Verde Islands": "cv",
    "Cabo Verde": "cv",
    "Cameroon": "cm",
    "Chad": "td",
    "Central African ": "cf",
    "Equatorial Guinea": "gq",
    "Gabon": "ga",
    "Congo": "cg",
    "D.R.Congo": "cd",
    "Congo DR": "cd",
    "Democratic Republic of Congo": "cd",
    "DRC": "cd",
    "Angola": "ao",
    "Zambia": "zm",
    "Malawi": "mw",
    "Mozambique": "mz",
    "Zimbabwe": "zw",
    "Namibia": "na",
    "Botswana": "bw",
    "South Africa": "za",
    "Lesotho": "ls",
    "Eswatini": "sz",
    "Swaziland": "sz",
    "Tanzania": "tz",
    "Kenya": "ke",
    "Uganda": "ug",
    "Rwanda": "rw",
    "Burundi": "bi",
    "Ethiopia": "et",
    "Eritrea": "er",
    "Djibouti": "dj",
    "Somalia": "so",
    "Comoros": "km",
    "Madagascar": "mg",
    "Mauritius": "mu",
    "Seychelles": "sc",

    // ===================== أوروبا =====================
    "England": "gb-eng",
    "Scotland": "gb-sct",
    "Wales": "gb-wls",
    "Northern Ireland": "gb-nir",
    "Republic of Ireland": "ie",
    "Ireland": "ie",
    "France": "fr",
    "Spain": "es",
    "Portugal": "pt",
    "Germany": "de",
    "Italy": "it",
    "Netherlands": "nl",
    "Belgium": "be",
    "Switzerland": "ch",
    "Austria": "at",
    "Denmark": "dk",
    "Sweden": "se",
    "Norway": "no",
    "Finland": "fi",
    "Iceland": "is",
    "Poland": "pl",
    "Czech Republic": "cz",
    "Czechia": "cz",
    "Slovakia": "sk",
    "Hungary": "hu",
    "Romania": "ro",
    "Bulgaria": "bg",
    "Greece": "gr",
    "Turkey": "tr",
    "Cyprus": "cy",
    "Croatia": "hr",
    "Serbia": "rs",
    "Bosnia and Herzegovina": "ba",
    "Bosnia-Herzegovina": "ba",
    "Bosnia": "ba",
    "Montenegro": "me",
    "North Macedonia": "mk",
    "Macedonia FYR": "mk",
    "FYR Macedonia": "mk",
    "Albania": "al",
    "Kosovo": "xk",
    "Slovenia": "si",
    "Ukraine": "ua",
    "Belarus": "by",
    "Moldova": "md",
    "Russia": "ru",
    "Estonia": "ee",
    "Latvia": "lv",
    "Lithuania": "lt",
    "Georgia": "ge",
    "Armenia": "am",
    "Azerbaijan": "az",
    "Luxembourg": "lu",
    "Malta": "mt",
    "Andorra": "ad",
    "San Marino": "sm",
    "Gibraltar": "gi",
    "Faroe Islands": "fo",
    "Israel": "il",
    "Kazakhstan": "kz",

    // ===================== آسيا =====================
    "Saudi Arabia": "sa",
    "United Arab Emirates": "ae",
    "UAE": "ae",
    "Qatar": "qa",
    "Bahrain": "bh",
    "Kuwait": "kw",
    "Oman": "om",
    "Yemen": "ye",
    "Jordan": "jo",
    "Lebanon": "lb",
    "Syria": "sy",
    "Iraq": "iq",
    "Iran": "ir",
    "IR Iran": "ir",
    "Palestine": "ps",
    "Japan": "jp",
    "South Korea": "kr",
    "Korea Republic": "kr",
    "North Korea": "kp",
    "Korea DPR": "kp",
    "China": "cn",
    "China PR": "cn",
    "Chinese Taipei": "tw",
    "Taiwan": "tw",
    "Hong Kong": "hk",
    "Mongolia": "mn",
    "India": "in",
    "Pakistan": "pk",
    "Bangladesh": "bd",
    "Sri Lanka": "lk",
    "Nepal": "np",
    "Bhutan": "bt",
    "Maldives": "mv",
    "Afghanistan": "af",
    "Uzbekistan": "uz",
    "Turkmenistan": "tm",
    "Tajikistan": "tj",
    "Kyrgyzstan": "kg",
    "Thailand": "th",
    "Vietnam": "vn",
    "Malaysia": "my",
    "Singapore": "sg",
    "Indonesia": "id",
    "Philippines": "ph",
    "Myanmar": "mm",
    "Cambodia": "kh",
    "Laos": "la",
    "Brunei": "bn",
    "Timor-Leste": "tl",

    // ===================== أمريكا الشمالية والوسطى والكاريبي =====================
    "USA": "us",
    "United States": "us",
    "United States of America": "us",
    "Canada": "ca",
    "Mexico": "mx",
    "Costa Rica": "cr",
    "Panama": "pa",
    "Honduras": "hn",
    "Guatemala": "gt",
    "El Salvador": "sv",
    "Nicaragua": "ni",
    "Belize": "bz",
    "Jamaica": "jm",
    "Haiti": "ht",
    "Cuba": "cu",
    "Dominican Republic": "do",
    "Trinidad and Tobago": "tt",
    "Trinidad & Tobago": "tt",
    "Bahamas": "bs",
    "Barbados": "bb",
    "Grenada": "gd",
    "Antigua and Barbuda": "ag",
    "St Kitts and Nevis": "kn",
    "Saint Kitts and Nevis": "kn",
    "St Lucia": "lc",
    "Saint Lucia": "lc",
    "St Vincent and the Grenadines": "vc",
    "Saint Vincent and the Grenadines": "vc",
    "Guyana": "gy",
    "Suriname": "sr",
    "Puerto Rico": "pr",
    "Bermuda": "bm",

    // ===================== أمريكا الجنوبية =====================
    "Brazil": "br",
    "Argentina": "ar",
    "Uruguay": "uy",
    "Chile": "cl",
    "Colombia": "co",
    "Peru": "pe",
    "Ecuador": "ec",
    "Bolivia": "bo",
    "Paraguay": "py",
    "Venezuela": "ve",

    // ===================== أوقيانوسيا =====================
    "Australia": "au",
    "New Zealand": "nz",
    "Fiji": "fj",
    "Papua New Guinea": "pg",
    "Solomon Islands": "sb",
    "Vanuatu": "vu",
    "New Caledonia": "nc",
    "Tahiti": "pf",
    "Samoa": "ws",
    "Tonga": "to"

};

function normalizeCountryCode(value) {
    if (!value || typeof value !== "object") return null;

    const candidates = [
        value.countryCode,
        value.country_code,
        value.iso2,
        value.isoCode,
        value.country?.code,
        value.country?.countryCode,
        value.country?.iso2,
        value.nationality?.code,
        value.nationality?.iso2
    ];
    const code = candidates.find(candidate => /^[a-z]{2}$/i.test(String(candidate || "").trim()));
    return code ? String(code).trim().toLowerCase() : null;
}

function getNationalTeamFlagLogo(teamOrName) {
    if (!teamOrName) return null;

    const names = typeof teamOrName === "string"
        ? [teamOrName]
        : [teamOrName.name, teamOrName.teamName, teamOrName.originalName]
            .filter(name => typeof name === "string" && name.trim());
    const countryNames = names.flatMap(name => {
        const countryName = name
            .replace(/\b(?:u[\s-]?\d{1,2}|under[\s-]?\d{1,2})\s*(?:w(?:omen(?:['’]?s)?)?|girls?|female)?\b/gi, " ")
            .replace(/\b(?:women(?:['’]?s)?|female|girls?|ladies|national|team|youth|w)\b/gi, " ")
            .replace(/[()[\]{}.,:|/_-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        return countryName && countryName !== name ? [name, countryName] : [name];
    });

    const code = normalizeCountryCode(teamOrName)
        || countryNames
            .map(countryName => findTranslation(NATIONAL_TEAM_COUNTRY_CODES, countryName))
            .find(Boolean);

    if (!code) {
        return null;
    }

    return `/api/national-logo/${code}`;

}

// يطبّق نفس منطق أعلام المنتخبات على كائن مباراة "خام" قادم
// مباشرة من GOAL API (يُستعمل في /api/league-fixtures حيث
// شكل الحقول أقل توحيداً من /api/fixtures). يتم التعديل في
// نفس الكائن (mutate) على كل الحقول المحتملة التي قد يقرأها
// الواجهة الأمامية، حتى يعمل بغض النظر عن الشكل الدقيق للرد.
function applyNationalFlagToRawFixture(event) {

    if (!event || typeof event !== "object") {
        return event;
    }

    const homeTeamObj = event.homeTeam || event.home_team || event.home || event.teams?.home || {};
    const awayTeamObj = event.awayTeam || event.away_team || event.away || event.teams?.away || {};
    const competition = event.competition || event.tournament || event.league;
    if (competition && typeof competition === "object") {
        const uniqueTournament = competition.uniqueTournament || event.uniqueTournament;
        const logo = getFootballMediaLogo(
            uniqueTournament && typeof uniqueTournament === "object" ? uniqueTournament : competition,
            "leagues"
        );
        competition.logo = logo;
        if (uniqueTournament && typeof uniqueTournament === "object") {
            uniqueTournament.logo = logo;
        }
        event.leagueLogo = logo;
    }

    const homeName =
        event.homeTeamName
        || homeTeamObj.name
        || event.homeName
        || "";

    const awayName =
        event.awayTeamName
        || awayTeamObj.name
        || event.awayName
        || "";

    const homeFlagLogo = getNationalTeamFlagLogo(homeTeamObj) || getNationalTeamFlagLogo(homeName);
    const awayFlagLogo = getNationalTeamFlagLogo(awayTeamObj) || getNationalTeamFlagLogo(awayName);

    const homeManualLogo = getFootballMediaLogo(homeTeamObj, "teams")
        || getFootballMediaLogo({ name: homeName }, "teams");
    const homeApiLogo = homeTeamObj.logo || homeTeamObj.badge || homeTeamObj.crest
        || event.teamHomeBadge || event.homeTeamLogo
        || getFootballMediaLogo(homeTeamObj, "teams")
        || getFootballMediaLogo({ name: homeName }, "teams")
        || "";
    const awayManualLogo = getFootballMediaLogo(awayTeamObj, "teams")
        || getFootballMediaLogo({ name: awayName }, "teams");
    const awayApiLogo = awayTeamObj.logo || awayTeamObj.badge || awayTeamObj.crest
        || event.teamAwayBadge || event.awayTeamLogo
        || getFootballMediaLogo(awayTeamObj, "teams")
        || getFootballMediaLogo({ name: awayName }, "teams")
        || "";

    if (homeManualLogo || homeFlagLogo || homeApiLogo) {
        const logo = homeFlagLogo || homeManualLogo || homeApiLogo;
        event.homeTeam = { ...homeTeamObj, badge: logo, logo, crest: logo };
        event.home = { ...(event.home || {}), badge: logo, logo, crest: logo };
        if (event.teams && typeof event.teams === "object") {
            event.teams = {
                ...event.teams,
                home: { ...(event.teams.home || {}), ...homeTeamObj, badge: logo, logo, crest: logo }
            };
        }
        event.teamHomeBadge = logo;
        event.homeTeamLogo = logo;
    }

    if (awayManualLogo || awayFlagLogo || awayApiLogo) {
        const logo = awayFlagLogo || awayManualLogo || awayApiLogo;
        event.awayTeam = { ...awayTeamObj, badge: logo, logo, crest: logo };
        event.away = { ...(event.away || {}), badge: logo, logo, crest: logo };
        if (event.teams && typeof event.teams === "object") {
            event.teams = {
                ...event.teams,
                away: { ...(event.teams.away || {}), ...awayTeamObj, badge: logo, logo, crest: logo }
            };
        }
        event.teamAwayBadge = logo;
        event.awayTeamLogo = logo;
    }

    return event;

}


// =============================================
// TRANSLATE TEAM
// =============================================

function translateNationalYouthTeamName(name) {
    const value = String(name || "").trim();
    if (!value) return null;

    const hasYouthOrWomenMarker =
        /\bu\s*-?\s*\d{1,2}\s*w\b|\bunder\s*-?\s*\d{1,2}\b|\bu\s*-?\s*\d{1,2}\b|\b(?:women(?:['’]?s)?|female|girls?|ladies)\b/i
            .test(value);
    if (!hasYouthOrWomenMarker) return null;

    const countryName = value
        .replace(/\bu\s*-?\s*\d{1,2}\s*w\b/gi, " ")
        .replace(/\b(?:u\s*-?\s*\d{1,2}|under\s*-?\s*\d{1,2})\b/gi, " ")
        .replace(/\b(?:women(?:['’]?s)?|female|girls?|ladies|national|team|youth)\b/gi, " ")
        .replace(/[()[\]{}.,:|/_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!countryName) return null;

    const countryFlag = getNationalTeamFlagLogo(value);
    const countryCode = countryFlag?.match(/\/api\/national-logo\/([a-z]{2}(?:-[a-z]{3})?)/i)?.[1];
    const canonicalCountry = countryCode
        ? Object.keys(NATIONAL_TEAM_COUNTRY_CODES)
            .find(country => NATIONAL_TEAM_COUNTRY_CODES[country] === countryCode)
        : null;
    const translatedCountry = findTranslation(translations.teams, countryName)
        || (canonicalCountry && findTranslation(translations.teams, canonicalCountry));

    return translatedCountry || null;
}

function getYouthTeamAge(value) {
    const text = String(value || "");
    const match = text.match(/\b(?:u\s*-?\s*(\d{1,2})\s*w?|under\s*-?\s*(\d{1,2}))\b|(?:أقل\s*من|تحت)\s*(\d{1,2})(?:\s*سنة)?|(?:^|\s)(\d{1,2})\s*سنة/i);
    return match ? Number(match[1] || match[2] || match[3] || match[4]) : null;
}

function translateTeam(name, competitionName = "") {

    if (!name) {

        return name;

    }

    const value = String(name).trim();
    const competition = String(competitionName || "");
    const youthAge = getYouthTeamAge(value) || getYouthTeamAge(competition);
    const hasWomensMarker = text =>
        /\b(?:women(?:['’]?s)?|female|girls?|ladies)\b|\bu\s*-?\s*\d{1,2}\s*w\b|(?:للسيدات|سيدات)/i.test(text);
    const isWomensTeam = hasWomensMarker(value) || hasWomensMarker(competition);
    const baseName = youthAge || isWomensTeam
        ? value
            .replace(/\b(?:u\s*-?\s*\d{1,2}\s*w?|under\s*-?\s*\d{1,2})\b|(?:أقل\s*من|تحت)\s*\d{1,2}(?:\s*سنة)?|(?:^|\s)\d{1,2}\s*سنة/gi, " ")
            .replace(/\b(?:women(?:['’]?s)?|female|girls?|ladies|national|team|youth)\b/gi, " ")
            .replace(/(?:للسيدات|سيدات)/g, " ")
            .replace(/[()[\]{}.,:|/_-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : "";

    const translated =
        findTranslation(
            translations.teams,
            name
        );

    const baseTranslation = youthAge || isWomensTeam
        ? translateNationalYouthTeamName(name)
            || translated
            || findTranslation(translations.teams, baseName)
            || baseName
        : translateNationalYouthTeamName(name) || translated;

    let teamTranslation = baseTranslation;
    if (baseTranslation && (youthAge || isWomensTeam)) {
        const baseWithoutCategory = baseTranslation
            .replace(/\s+(?:للسيدات\s+)?(?:(?:أقل\s*من|تحت)\s*)?\d{1,2}\s*سنة$/i, "")
            .replace(/\s*(?:للسيدات|سيدات)$/i, "")
            .trim();
        teamTranslation = youthAge
            ? `${baseWithoutCategory} ${youthAge} سنة`
            : baseWithoutCategory;
    }

    if (!teamTranslation) {
        console.warn(
            `ترجمة الفريق غير موجودة، سيتم عرض الاسم الأصلي: ${name}`
        );
    }


    return (
        teamTranslation ||
        name
    );

}

function translateHeadToHeadNames(payload) {
    if (!payload) return payload;

    const translateMatch = match => {
        if (!match || typeof match !== 'object') return match;
        const translated = { ...match };
        const competitionName = match.league?.name
            || match.competition?.name
            || match.tournament?.name
            || match.league_name
            || match.competitionName
            || "";
        ['match_hometeam_name', 'match_awayteam_name', 'homeTeamName', 'awayTeamName'].forEach(field => {
            if (translated[field]) translated[field] = translateTeam(translated[field], competitionName);
        });
        if (translated.homeTeam?.name) translated.homeTeam = { ...translated.homeTeam, name: translateTeam(translated.homeTeam.originalName || translated.homeTeam.name, competitionName) };
        if (translated.awayTeam?.name) translated.awayTeam = { ...translated.awayTeam, name: translateTeam(translated.awayTeam.originalName || translated.awayTeam.name, competitionName) };
        if (translated.home?.name) translated.home = { ...translated.home, name: translateTeam(translated.home.originalName || translated.home.name, competitionName) };
        if (translated.away?.name) translated.away = { ...translated.away, name: translateTeam(translated.away.originalName || translated.away.name, competitionName) };
        return translated;
    };

    const result = Array.isArray(payload) ? payload.map(translateMatch) : { ...payload };
    if (Array.isArray(result)) return result;
    if (Array.isArray(result.matches)) result.matches = result.matches.map(translateMatch);
    if (Array.isArray(result.fixtures)) result.fixtures = result.fixtures.map(translateMatch);
    if (result.team1?.name) result.team1 = { ...result.team1, name: translateTeam(result.team1.name) };
    if (result.team2?.name) result.team2 = { ...result.team2, name: translateTeam(result.team2.name) };
    return result;
}

function translateTeamFixtureNames(items) {
    if (!Array.isArray(items)) return [];

    return items.map(item => {
        if (!item || typeof item !== 'object') return item;
        const result = { ...item };
        const competitionName = item.league?.originalName
            || item.league?.name
            || item.competition?.name
            || item.tournament?.name
            || item.leagueName
            || item.competitionName
            || "";
        const translateObject = value => value && typeof value === 'object'
            ? { ...value, name: value.name ? translateTeam(value.originalName || value.name, competitionName) : value.name }
            : value;

        result.homeTeam = translateObject(result.homeTeam);
        result.awayTeam = translateObject(result.awayTeam);
        result.home = translateObject(result.home);
        result.away = translateObject(result.away);
        result.teams = result.teams ? {
            ...result.teams,
            home: translateObject(result.teams.home),
            away: translateObject(result.teams.away)
        } : result.teams;

        ['homeTeamName', 'awayTeamName', 'homeName', 'awayName', 'match_hometeam_name', 'match_awayteam_name'].forEach(field => {
            if (result[field]) result[field] = translateTeam(result[field], competitionName);
        });
        return result;
    });
}


function translateFixtureNames(result) {

    if (!result || !Array.isArray(result.leagues)) {
        return result;
    }


    result.leagues.forEach(league => {

        league.leagueName = translateLeague(
            league.leagueId,
            league.leagueOriginalName || league.leagueName,
            league.countryOriginal || league.country
        );


        league.matches = Array.isArray(league.matches)
            ? league.matches.map(match => {
                const homeName = match.home?.originalName || match.home?.name;
                const awayName = match.away?.originalName || match.away?.name;
                const competitionName = league.leagueOriginalName || league.leagueName;
                const translatedHome = translateTeam(homeName, competitionName);
                const translatedAway = translateTeam(awayName, competitionName);

                return {
                    ...match,
                    home: { ...match.home, name: translatedHome },
                    away: { ...match.away, name: translatedAway },
                    homeTeam: { ...match.homeTeam, name: translatedHome },
                    awayTeam: { ...match.awayTeam, name: translatedAway }
                };
            })
            : [];
    });


    return result;

}


// =============================================
// TRANSLATE COUNTRY
// =============================================

function translateCountry(name) {

    if (!name) {

        return name;

    }


    const translated =
        findTranslation(
            translations.countries,
            name
        );

    if (translated) return translated;

    const countryTranslations = {
        international: 'دولي',
        intl: 'دولي',
        world: 'العالم',
        england: 'إنجلترا',
        spain: 'إسبانيا',
        france: 'فرنسا',
        germany: 'ألمانيا',
        italy: 'إيطاليا',
        portugal: 'البرتغال',
        netherlands: 'هولندا',
        belgium: 'بلجيكا',
        turkey: 'تركيا',
        greece: 'اليونان',
        egypt: 'مصر',
        algeria: 'الجزائر',
        morocco: 'المغرب',
        tunisia: 'تونس',
        saudi: 'السعودية',
        'saudi arabia': 'السعودية',
        qatar: 'قطر',
        uae: 'الإمارات',
        'united arab emirates': 'الإمارات',
        europe: 'أوروبا',
        africa: 'إفريقيا',
        brazil: 'البرازيل',
        argentina: 'الأرجنتين',
        usa: 'الولايات المتحدة',
        'united states': 'الولايات المتحدة',
        mexico: 'المكسيك',
        japan: 'اليابان',
        korea: 'كوريا الجنوبية',
        australia: 'أستراليا'
    };

    return countryTranslations[normalizeName(name)] || name;

}


// =============================================
// TRANSLATE LEAGUE
//
// الأولوية:
//
// 1️⃣ League ID
// 2️⃣ Country + League Name
// 3️⃣ League Name
// 4️⃣ Original Name
//
// =============================================

function translateLeague(
    leagueId,
    leagueName,
    country
) {

    if (!leagueName) {
        return leagueName;
    }

    const normalizedLeague = normalizeName(leagueName);
    const normalizedCountry = normalizeName(country);

    if (
        normalizedLeague === "premier league" &&
        normalizedCountry !== "england"
    ) {
        return leagueName;
    }

    // =========================================
    // 1 - TRANSLATE BY LEAGUE ID
    // =========================================

    const normalizedLeagueId = leagueId === null || leagueId === undefined
        ? ""
        : String(leagueId).trim();
    const leagueIdTranslation = translations.leagueIds?.[normalizedLeagueId];
    const leagueIdNameAliases = {
        "2": ["uefa champions league", "champions league"],
        "3": ["uefa europa league", "europa league"],
        "39": ["premier league"],
        "61": ["ligue 1"],
        "78": ["bundesliga"],
        "88": ["eredivisie"],
        "94": ["primeira liga", "primeiraliga", "liga portugal"],
        "135": ["serie a"],
        "140": ["la liga", "laliga", "primera division"],
        "144": ["first division a", "belgian pro league"],
        "203": ["super lig", "süper lig"],
        "233": ["egyptian premier league", "egypt premier league"],
        "307": ["saudi pro league", "saudi professional league"],
        "848": ["uefa conference league", "uefa europa conference league", "conference league"]
    };
    const leagueIdCountries = {
        "39": ["england"],
        "61": ["france"],
        "78": ["germany"],
        "88": ["netherlands"],
        "94": ["portugal"],
        "135": ["italy"],
        "140": ["spain"],
        "144": ["belgium"],
        "203": ["turkey", "türkiye"],
        "233": ["egypt"],
        "307": ["saudi arabia", "saudi"]
    };
    const expectedNames = leagueIdNameAliases[normalizedLeagueId] || [];
    const expectedCountries = leagueIdCountries[normalizedLeagueId];
    const leagueIdMatchesCompetition =
        expectedNames.includes(normalizedLeague)
        && (!expectedCountries || expectedCountries.includes(normalizedCountry));

    if (leagueIdTranslation && leagueIdMatchesCompetition) {
        return leagueIdTranslation;
    }


    // =========================================
    // 2 - TRANSLATE BY COUNTRY + NAME
    // =========================================


    const countryKey =
        `${normalizedCountry}:${normalizedLeague}`;


    if (
        translations.leagueCountry &&
        translations.leagueCountry[countryKey]
    ) {

        return translations.leagueCountry[
            countryKey
        ];

    }


    // =========================================
    // 3 - TRANSLATE BY LEAGUE NAME
    // =========================================

    const translated =
        findTranslation(
            translations.leagues,
            leagueName
        );


    if (
        translated
    ) {

        return translated;

    }


    // =========================================
    // 4 - ORIGINAL NAME
    // =========================================

    return leagueName;

}


// =============================================
// MATCH STATUS
// =============================================

function normalizeScore(score) {

    if (score == null) {
        return null;
    }

    if (typeof score === "object") {
        score =
            score.current ??
            score.fullTime ??
            score.fulltime ??
            score.final ??
            score.ft ??
            score.value ??
            score.goals ??
            score.score;
    }

    const normalized = Number(score);

    return Number.isFinite(normalized)
        ? normalized
        : null;

}

function getMatchStatus(status) {

    const short =
        typeof status === "string"
            ? status
            : status?.short || status?.type;

    const normalizedShort =
        String(short || "")
            .trim()
            .toUpperCase()
            .replace(/[ -]/g, "_");


    // =========================================
    // LIVE
    // =========================================

    const liveStatuses = [

        "1H",

        "HT",

        "2H",

        "ET",

        "BT",

        "P",

        "INT",

        "LIVE",

        "IN_PLAY",

        "PAUSED"

    ];


    if (
        liveStatuses.includes(normalizedShort) ||
        ["INPROGRESS", "IN_PROGRESS", "IN_PLAY", "INPLAY"].includes(normalizedShort)
    ) {

        return "live";

    }


    // =========================================
    // FINISHED
    // =========================================

    const finishedStatuses = [

        "FT",

        "AET",

        "PEN",

        "AWARDED"

    ];


    if (
        finishedStatuses.includes(normalizedShort) ||
        ["FINISHED", "COMPLETED", "COMPLETE", "ENDED", "END"].includes(normalizedShort)
    ) {

        return "finished";

    }

    // =========================================
    // POSTPONED
    // =========================================

    const postponedStatuses = [

        "PST",

        "CANC",

        "ABD",

        "AWD",

        "WO",

        "SUSPENDED",

        "CANCELLED"

    ];


    if (
        postponedStatuses.includes(normalizedShort)
    ) {

        return "postponed";

    }


    return "scheduled";

}


// =============================================
// CACHE
// لتقليل استهلاك API
// =============================================

const cache =
    new Map();


// Keep live fixture results fresh while avoiding duplicate upstream requests.

const CACHE_TIME =
    20 * 1000;

const TARGET_FIXTURES_CACHE_TIME =
    5 * 60 * 1000;

const leagueCatalogCache = {
    time: 0,
    data: []
};

const targetFixturesCache = new Map();
const afconFutsalFixturesCache = new Map();

const allLeaguesCache = {
    time: 0,
    data: []
};

const allCountriesCache = {
    time: 0,
    data: []
};

const TOP_SCORERS_SEASON = "2026/2027";
const standingsCache = new Map();
const topScorersCache = new Map();

const STANDINGS_CACHE_TIME = 45 * 1000;
const TOP_SCORERS_CACHE_TIME = 10 * 60 * 1000;

const TARGET_LEAGUES = [
    { name: "Premier League", country: "England" },
    { name: "La Liga", country: "Spain" },
    { name: "Serie A", country: "Italy" },
    { name: "Bundesliga", country: "Germany" },
    { name: "Ligue 1", country: "France" },
    { name: "Eredivisie", country: "Netherlands" },
    { name: "Primeira Liga", country: "Portugal" },
    { name: "First Division A", country: "Belgium" },
    { name: "Süper Lig", country: "Turkey" },
    { name: "Super League 1", country: "Greece" },
    { name: "UEFA Champions League", country: "Europe" },
    { name: "UEFA Europa League", country: "Europe" },
    { name: "UEFA Conference League", country: "Europe" },
    { name: "CAF Champions League", country: "intl" },
    { name: "CAF Confederation Cup", country: "intl" }
];

// =============================================
// PAGINATION HELPERS
//
// GoalAPI قد لا يرجع دائماً نفس شكل حقل "pagination"
// (hasMore / has_more / next / total ...). سابقاً كان
// الكود يعتمد فقط على pagination.hasMore، وإذا كان هذا
// الحقل غير موجود في رد الـ API فإن الحلقة كانت تتوقف من
// أول صفحة (100 عنصر كحد أقصى) وهذا هو سبب اختفاء بعض
// المباريات (خصوصاً الأيام المزدحمة مثل أكتوبر).
//
// الحل: نتحقق من عدة أشكال محتملة لحقل hasMore، وإذا لم
// نجد أي واحد منها نفترض أنه قد توجد صفحة أخرى طالما أن
// الصفحة الحالية رجعت "ممتلئة" (طولها == limit المطلوب).
// كما نضيف حداً أقصى لعدد الصفحات كحماية من infinite loop.
// =============================================

const MAX_PAGINATION_PAGES = 100; // حماية: 100 صفحة * 100 عنصر = 10000 عنصر كحد أقصى لكل طلب

function paginationSaysHasMore(pagination, pageLength, limit) {

    if (!pageLength) {
        return false;
    }

    if (!pagination || typeof pagination !== "object") {
        // لا توجد معلومات pagination في الرد: افترض وجود صفحة
        // أخرى إذا رجعت الصفحة الحالية ممتلئة بالكامل
        return pageLength >= limit;
    }

    if (typeof pagination.hasMore === "boolean") {
        return pagination.hasMore;
    }

    if (typeof pagination.hasMore === "string") {
        return pagination.hasMore.toLowerCase() === "true";
    }

    if (typeof pagination.has_more === "boolean") {
        return pagination.has_more;
    }

    if (typeof pagination.has_next === "boolean") {
        return pagination.has_next;
    }

    if (typeof pagination.hasNext === "boolean") {
        return pagination.hasNext;
    }

    if (pagination.next || pagination.nextOffset != null || pagination.next_offset != null || pagination.nextPage != null || pagination.next_page != null) {
        return true;
    }

    if (pagination.total != null) {
        const total = Number(pagination.total);
        const offset = Number(pagination.offset ?? 0);
        const returnedLimit = Number(pagination.limit ?? limit ?? pageLength);

        if (Number.isFinite(total) && Number.isFinite(offset) && Number.isFinite(returnedLimit)) {
            return offset + returnedLimit < total;
        }
    }

    if (pagination.totalPages != null && pagination.page != null) {
        return Number(pagination.page) < Number(pagination.totalPages);
    }

    // لا توجد أي إشارة صريحة: افترض احتمال وجود صفحة أخرى
    // طالما أن الصفحة الحالية رجعت ممتلئة بالكامل
    return pageLength >= limit;

}

function nextPaginationOffset(pagination, currentOffset, pageLength, limit) {

    const rawOffset = Number(pagination?.offset ?? currentOffset);
    const rawLimit = Number(pagination?.limit ?? limit ?? pageLength);
    const candidate = (Number.isFinite(rawOffset) ? rawOffset : currentOffset)
        + (Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : pageLength);

    // تأكد أن offset يتقدم فعلاً لتفادي أي حلقة لا نهائية
    return candidate > currentOffset ? candidate : currentOffset + pageLength;

}

function buildFixtureDedupeKey(event) {

    return event?.id
        || event?.apiId
        || event?.fixtureId
        || `${event?.homeTeamId || ""}:${event?.awayTeamId || ""}:${event?.kickoffUtc || event?.matchDate || event?.date || ""}`;

}

async function goalApiJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;

    try {
        response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${GOAL_API_KEY}`,
                Accept: "application/json"
            },
            signal: controller.signal
        });
    }
    catch (error) {
        if (error.name === "AbortError") {
            throw new Error("انتهت مهلة الاتصال بمصدر المباريات");
        }
        throw error;
    }
    finally {
        clearTimeout(timeout);
    }

    const data = await response.json();

    if (!response.ok) {
        const error = new Error(
            `GOAL API returned ${response.status}`
        );
        error.status = response.status;
        throw error;
    }

    return data;
}

function getFixtureTypeMeta(event = {}) {
    const values = [
        event.homeTeamType,
        event.awayTeamType,
        event.homeTeam?.type,
        event.awayTeam?.type,
        event.homeTeam?.teamType,
        event.awayTeam?.teamType,
        event.competition?.type,
        event.league?.type,
        event.tournament?.type
    ].filter(value => typeof value === "string" && value.trim().length > 0);

    if (!values.length) {
        return { club: false, national: false };
    }

    const normalized = values.join(" ").toLowerCase();
    const nationalLogo = getNationalTeamFlagLogo(team);

    return {
        club: /club|team/.test(normalized),
        national: /national|country|international|fifa|qualifier|qualifying|nations|world cup|africa cup|copa america|euro|european|confederations|olympic|cup/.test(normalized)
    };
}

// =============================================
// FETCH ALL FIXTURES FOR A GIVEN DATE
// يجلب كل الصفحات المتوفرة من GoalAPI بدون الاعتماد
// حصرياً على pagination.hasMore، ويحذف أي تكرار.
// =============================================

async function fetchAllDateFixtures(date) {
    const allEvents = [];
    const seen = new Set();
    const pageLimit = 100;
    let offset = 0;
    let pageCount = 0;

    while (pageCount < MAX_PAGINATION_PAGES) {

        pageCount++;

        let data;

        try {
            data = await goalApiJson(
                `${API_URL}/fixtures/date/${encodeURIComponent(date)}?limit=${pageLimit}&offset=${offset}`
            );
        }
        catch (error) {
            if (error.status === 429) {
                console.error(
                    `تم إيقاف pagination لتاريخ ${date} بسبب rate limit (429) بعد ${pageCount - 1} صفحة`
                );
                break;
            }
            throw error;
        }

        const page = Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.fixtures)
                ? data.fixtures
                : Array.isArray(data)
                    ? data
                    : [];

        if (!page.length) {
            break;
        }

        for (const event of page) {
            const key = buildFixtureDedupeKey(event);
            if (!key || seen.has(key)) {
                continue;
            }
            seen.add(key);
            allEvents.push(event);
        }

        const pagination = data?.pagination || {};
        const hasMore = paginationSaysHasMore(pagination, page.length, pageLimit);

        if (!hasMore) {
            break;
        }

        offset = nextPaginationOffset(pagination, offset, page.length, pageLimit);

        if (pagination.total != null && offset >= Number(pagination.total)) {
            break;
        }
    }

    if (pageCount >= MAX_PAGINATION_PAGES) {
        console.warn(
            `⚠️ تم بلوغ الحد الأقصى لعدد صفحات pagination (${MAX_PAGINATION_PAGES}) لتاريخ ${date}، قد تكون هناك مباريات إضافية لم يتم جلبها`
        );
    }

    console.log(`[GOAL API] pagination pages fetched for ${date}: ${pageCount}`);

    return allEvents;
}

// مطابقة مرنة لكأس أمم أفريقيا (الاسم الرسمي عند مزودي البيانات يختلف
// حسب الموسم: قد يكون مربوطاً بدولة "World" أو "Africa" أو بلد الاستضافة،
// لذلك لا نعتمد على مطابقة الاسم + الدولة الثابتة مثل باقي TARGET_LEAGUES)
const AFCON_NAME_PATTERN =
    /africa(n)?\s*(cup of nations|nations cup)|afcon|caf\s*africa\s*cup/i;
const AFCON_FUTSAL_NAME_PATTERN =
    /(?:afcon|africa(n)?\s*(?:futsal\s*)?(cup of nations|nations cup)|caf\s*futsal\s*africa\s*cup|futsal\s*africa\s*cup of nations)/i;

async function getTargetLeagues() {
    if (Date.now() - leagueCatalogCache.time < 60 * 60 * 1000) {
        return leagueCatalogCache.data;
    }

    const leagues = await getAllLeagues();

    const targets = leagues.filter(league =>
        league.isActive !== false &&
        (
            TARGET_LEAGUES.some(target =>
                target.name === league.name &&
                target.country === league.countryName
            ) ||
            AFCON_NAME_PATTERN.test(league.name || "")
            || AFCON_FUTSAL_NAME_PATTERN.test(league.name || "")
        )
    );

    if (!targets.some(league => AFCON_FUTSAL_NAME_PATTERN.test(league.name || ""))) {
        console.error(
            "المسابقة غير موجودة في GOAL API: Africa Futsal Cup of Nations"
        );
    }

    if (!targets.some(league => AFCON_NAME_PATTERN.test(league.name || ""))) {
        console.error(
            "المسابقة غير موجودة في GOAL API: Africa Cup of Nations"
        );
    }

    TARGET_LEAGUES.forEach(target => {
        if (!targets.some(league =>
            league.name === target.name &&
            league.countryName === target.country
        )) {
            console.error(
                `المسابقة غير موجودة في GOAL API: ${target.name} (${target.country})`
            );
        }
    });

    leagueCatalogCache.time = Date.now();
    leagueCatalogCache.data = targets;

    return targets;
}

async function getAfconFutsalFixtures(date) {
    const cached = afconFutsalFixturesCache.get(date);
    if (cached && Date.now() - cached.time < TARGET_FIXTURES_CACHE_TIME) {
        return cached.data;
    }

    const leagues = (await getAllLeagues()).filter(league =>
        league.isActive !== false
        && AFCON_FUTSAL_NAME_PATTERN.test(league.name || "")
    );
    const fixtures = [];
    const seenIds = new Set();

    for (const league of leagues) {
        const leagueName = `${league.name} (${league.countryName || league.country || "International"})`;
        let offset = 0;
        let pageCount = 0;
        const limit = 100;

        try {
            while (pageCount < MAX_PAGINATION_PAGES) {
                pageCount++;
                const data = await goalApiJson(
                    `${API_URL}/leagues/${encodeURIComponent(league.id)}/fixtures` +
                    `?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}` +
                    `&limit=${limit}&offset=${offset}`
                );
                const page = Array.isArray(data?.data)
                    ? data.data
                    : Array.isArray(data?.fixtures)
                        ? data.fixtures
                        : [];

                if (!page.length) break;

                for (const fixture of page) {
                    const key = buildFixtureDedupeKey(fixture);
                    if (key && seenIds.has(key)) continue;
                    if (key) seenIds.add(key);
                    fixtures.push(fixture);
                }

                const pagination = data?.pagination || {};
                if (!paginationSaysHasMore(pagination, page.length, limit)) break;
                offset = nextPaginationOffset(pagination, offset, page.length, limit);
            }

            if (pageCount >= MAX_PAGINATION_PAGES) {
                console.warn(`تم بلوغ الحد الأقصى لصفحات مباريات ${leagueName}`);
            }
        }
        catch (error) {
            console.error(`تعذر جلب مباريات ${leagueName}: ${error.message}`);
        }
    }

    afconFutsalFixturesCache.set(date, { time: Date.now(), data: fixtures });
    return fixtures;
}

async function getTargetFixtures(date) {
    const cached = targetFixturesCache.get(date);

    if (cached && Date.now() - cached.time < TARGET_FIXTURES_CACHE_TIME) {
        return cached.data;
    }

    const leagues = await getTargetLeagues();
    const fixtures = [];
    const seenIds = new Set();

    for (const league of leagues) {
        const leagueName = `${league.name} (${league.countryName})`;
        const limit = 100;
        let offset = 0;
        let pageCount = 0;

        try {
            while (pageCount < MAX_PAGINATION_PAGES) {

                pageCount++;

                const data = await goalApiJson(
                    `${API_URL}/leagues/${encodeURIComponent(league.id)}/fixtures` +
                    `?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}` +
                    `&limit=${limit}&offset=${offset}`
                );
                const page = Array.isArray(data.data) ? data.data : [];

                if (!page.length) {
                    break;
                }

                page.forEach(fixture => {
                    const key = buildFixtureDedupeKey(fixture);
                    if (key && seenIds.has(key)) {
                        return;
                    }
                    if (key) {
                        seenIds.add(key);
                    }
                    fixtures.push(fixture);
                });

                const pagination = data?.pagination || {};
                const hasMore = paginationSaysHasMore(pagination, page.length, limit);

                if (!hasMore) {
                    break;
                }

                offset = nextPaginationOffset(pagination, offset, page.length, limit);
            }

            if (pageCount >= MAX_PAGINATION_PAGES) {
                console.warn(
                    `⚠️ تم بلوغ الحد الأقصى لعدد صفحات pagination للمسابقة ${leagueName}`
                );
            }
        }
        catch (error) {
            console.error(
                `تعذر جلب ${leagueName}: ${error.message}`
            );

            if (error.status === 429) {
                console.error(
                    `تم إيقاف pagination للمسابقة ${leagueName} بسبب rate limit (429)`
                );
            }
        }
    }

    // التكرار محذوف مسبقاً أثناء الجمع عبر seenIds
    const uniqueFixtures = fixtures;

    targetFixturesCache.set(date, {
        time: Date.now(),
        data: uniqueFixtures
    });

    return uniqueFixtures;
}

async function getAllLeagues() {
    if (Date.now() - allLeaguesCache.time < 60 * 60 * 1000) {
        return allLeaguesCache.data;
    }

    const leagues = [];
    const seen = new Set();
    const limit = 100;
    let offset = 0;
    let pageCount = 0;

    while (pageCount < MAX_PAGINATION_PAGES) {

        pageCount++;

        const data = await goalApiJson(
            `${API_URL}/leagues?limit=${limit}&offset=${offset}`
        );
        const page = Array.isArray(data.data)
            ? data.data
            : Array.isArray(data.leagues)
                ? data.leagues
                : [];

        if (!page.length) {
            break;
        }

        page.forEach(league => {
            const key = league?.id ?? league?.leagueId ?? `${league?.name || ""}:${league?.countryName || league?.country || ""}`;
            if (key && seen.has(key)) {
                return;
            }
            if (key) {
                seen.add(key);
            }
            leagues.push(league);
        });

        const pagination = data?.pagination || {};
        const hasMore = paginationSaysHasMore(pagination, page.length, limit);

        if (!hasMore) {
            break;
        }

        offset = nextPaginationOffset(pagination, offset, page.length, limit);
    }

    if (pageCount >= MAX_PAGINATION_PAGES) {
        console.warn(
            `⚠️ تم بلوغ الحد الأقصى لعدد صفحات pagination عند جلب قائمة الدوريات`
        );
    }

    const validLeagues = leagues.filter(league => league.isActive !== false);
    allLeaguesCache.time = Date.now();
    allLeaguesCache.data = validLeagues;

    console.log(`[GOAL API] Leagues: ${validLeagues.length}`);
    return validLeagues;
}

async function getAllCountries() {
    if (Date.now() - allCountriesCache.time < 60 * 60 * 1000) {
        return allCountriesCache.data;
    }

    const countries = [];
    const seen = new Set();
    const limit = 100;
    let offset = 0;
    let pageCount = 0;

    while (pageCount < MAX_PAGINATION_PAGES) {

        pageCount++;

        const data = await goalApiJson(
            `${API_URL}/countries?limit=${limit}&offset=${offset}`
        );
        const page = Array.isArray(data.data)
            ? data.data
            : Array.isArray(data.countries)
                ? data.countries
                : [];

        if (!page.length) {
            break;
        }

        page.forEach(country => {
            const key = country?.id ?? country?.countryId ?? country?.code ?? country?.name;
            if (key && seen.has(key)) {
                return;
            }
            if (key) {
                seen.add(key);
            }
            countries.push(country);
        });

        const pagination = data?.pagination || {};
        const hasMore = paginationSaysHasMore(pagination, page.length, limit);

        if (!hasMore) {
            break;
        }

        offset = nextPaginationOffset(pagination, offset, page.length, limit);
    }

    if (pageCount >= MAX_PAGINATION_PAGES) {
        console.warn(
            `⚠️ تم بلوغ الحد الأقصى لعدد صفحات pagination عند جلب قائمة الدول`
        );
    }

    const validCountries = countries.filter(country => country && (country.name || country.countryName || country.code));
    allCountriesCache.time = Date.now();
    allCountriesCache.data = validCountries;

    console.log(`[GOAL API] Countries: ${validCountries.length}`);
    return validCountries;
}

function getLeaguePriority(league) {
    const name = normalizeName(
        `${league.originalName || league.name || ""} ${league.countryName || league.originalCountry || league.country || ""}`
    );

    return getLeagueDisplayPriority(name);
}

function hasLeagueTranslation(leagueId, originalName, country) {
    if (!originalName) return false;

    const translatedName = translateLeague(leagueId, originalName, country);
    return translatedName !== originalName || /[\u0600-\u06ff]/.test(translatedName || "");
}

function getLeagueDisplayPriority(value) {
    const name = normalizeName(value || '');

    if (/la liga|الدوري الإسباني/.test(name)) return 1;
    if (
        (/premier league/.test(name) && /\bengland\b/.test(name)
            || /الدوري الإنجليزي( الممتاز)?/.test(name))
        && !/premier league 2|fkf premier league/.test(name)
    ) return 2;
    if (/uefa champions league|champions league|دوري أبطال أوروبا/.test(name)) return 3;
    if (/caf champions league|دوري أبطال إفريقيا/.test(name)) return 4;
    if (/fa cup|the fa cup|كأس الاتحاد الإنجليزي|كأس إنجلترا/.test(name)) return 5;
    if (/caf confederation|confederation cup|كأس الكونفدرالية الإفريقية|كأس الاتحاد الإفريقي/.test(name)) return 6;
    if (/king cup|kings cup|كأس خادم الحرمين|كأس الملك السعودي|كأس الاتحاد السعودي/.test(name)) return 7;
    if (/saudi pro league|saudi professional|الدوري السعودي/.test(name)) return 8;
    if (/ligue 1|الدوري الفرنسي/.test(name)) return 9;
    if (/africa.*(cup|nations)|afcon|كأس أمم إفريقيا|كأس أمم أفريقيا/.test(name)) return 10;
    if (/euro|european championship|كأس أمم أوروبا|بطولة أمم أوروبا/.test(name)) return 11;
    if (/serie a|الدوري الإيطالي/.test(name)) return 12;
    if (/bundesliga|الدوري الألماني/.test(name)) return 13;
    if (/europa league|الدوري الأوروبي/.test(name)) return 14;
    if (/conference league|دوري المؤتمر الأوروبي/.test(name)) return 15;
    if (/botola|البطولة المغربية|الدوري المغربي/.test(name)) return 16;
    if (/egyptian premier|الدوري المصري/.test(name)) return 17;
    if (/eredivisie|الدوري الهولندي/.test(name)) return 18;
    if (/primeira liga|الدوري البرتغالي/.test(name)) return 19;
    if (/süper lig|super lig|الدوري التركي/.test(name)) return 20;

    return 9999;
}

function normalizeStandingRow(row, index) {
    const team = row.team || row.club || row.squad || {};
    const stats = row.stats || row.statistics || row;
    const goalsFor = stats.goalsFor ?? stats.goalsForTotal ?? stats.gf
        ?? stats.overallLeagueGF ?? stats.goals?.for ?? null;
    const goalsAgainst = stats.goalsAgainst ?? stats.goalsAgainstTotal ?? stats.ga
        ?? stats.overallLeagueGA ?? stats.goals?.against ?? null;
    const played = stats.played ?? stats.matchesPlayed ?? stats.mp
        ?? stats.overallLeaguePlayed ?? null;
    const wins = stats.wins ?? stats.won ?? stats.w
        ?? stats.overallLeagueW ?? null;
    const draws = stats.draws ?? stats.d ?? stats.overallLeagueD ?? null;
    const losses = stats.losses ?? stats.l ?? stats.overallLeagueL ?? null;
    const goalDifference = stats.goalDifference ?? stats.gd
        ?? (stats.overallLeagueGF != null && stats.overallLeagueGA != null
            ? Number(stats.overallLeagueGF) - Number(stats.overallLeagueGA)
            : null)
        ?? (goalsFor != null && goalsAgainst != null
            ? Number(goalsFor) - Number(goalsAgainst)
            : null);
    const teamName = team.name ?? row.teamName ?? null;
    const countryCode = normalizeCountryCode(team) || normalizeCountryCode(row);
    const nationalLogo = getNationalTeamFlagLogo(team) || getNationalTeamFlagLogo(teamName);
    const manualLogo = getFootballMediaLogo(team, "teams") || getFootballMediaLogo({ name: teamName }, "teams");

    if (!teamName) {
        return null;
    }

    const numericValue = value => value == null || value === ""
        ? null
        : Number.isFinite(Number(value))
            ? Number(value)
            : null;

    return {
        position: row.position ?? row.rank ?? row.overallLeaguePosition ?? null,
        team: {
            id: team.id ?? row.teamId,
            name: translateTeam(teamName),
            originalName: teamName,
            countryCode,
            logo: nationalLogo || manualLogo || team.logo || team.badge || team.crest || row.teamLogo || ""
        },
        played: numericValue(played),
        wins: numericValue(wins),
        draws: numericValue(draws),
        losses: numericValue(losses),
        goalsFor: numericValue(goalsFor),
        goalsAgainst: numericValue(goalsAgainst),
        goalDifference: numericValue(goalDifference),
        points: numericValue(stats.points ?? stats.pts ?? stats.overallLeaguePTS),
        form: row.form || stats.form || "",
        description: row.description || stats.description || "",
        status: row.status || stats.status || "",
        qualification: row.qualification || row.qualificationStatus || "",
        qualified: row.qualified ?? row.isQualified ?? null,
        eliminated: row.eliminated ?? row.isEliminated ?? null,
        relegated: row.relegated ?? row.isRelegated ?? null
    };
}

function normalizeStandingsResponse(data) {
    const source = data?.data ?? data;
    const gathered = [];

    function pushRows(value, groupName = '') {
        if (!value) return;

        if (Array.isArray(value)) {
            if (value.length && Array.isArray(value[0]?.rows)) {
                value.forEach((item, index) => pushRows(
                    item.rows,
                    item.name || item.group || item.groupName || item.label || `المجموعة ${String.fromCharCode(65 + index)}`
                ));
                return;
            }

            if (value.length && Array.isArray(value[0]?.table)) {
                value.forEach((item, index) => pushRows(
                    item.table,
                    item.name || item.group || item.groupName || item.label || `المجموعة ${String.fromCharCode(65 + index)}`
                ));
                return;
            }

            const rowGroups = new Map();
            value.forEach(row => {
                const rowGroup = row?.leagueRound?.name
                    || row?.leagueRound
                    || row?.league_round?.name
                    || row?.league_round
                    || row?.group?.name
                    || (typeof row?.group === 'string' ? row.group : '')
                    || row?.groupName
                    || row?.group_name
                    || row?.round?.name
                    || row?.round
                    || row?.stage?.name
                    || row?.stageName
                    || '';
                if (rowGroup) {
                    if (!rowGroups.has(rowGroup)) rowGroups.set(rowGroup, []);
                    rowGroups.get(rowGroup).push(row);
                }
            });

            if (rowGroups.size) {
                rowGroups.forEach((rows, name) => gathered.push({ name, rows }));
            }
            else {
                gathered.push({ name: groupName, rows: value });
            }
            return;
        }

        if (Array.isArray(value?.standings)) {
            pushRows(value.standings, value.name || value.group || value.groupName || value.label || groupName);
            return;
        }

        if (Array.isArray(value?.table)) {
            gathered.push({ name: value.name || value.group || value.groupName || value.label || groupName, rows: value.table });
            return;
        }

        if (Array.isArray(value?.rows)) {
            gathered.push({ name: value.name || value.group || value.groupName || value.label || groupName, rows: value.rows });
        }
    }

    pushRows(source);

    const normalizeRows = rows => {
        const deduped = new Map();
        rows
            .map(normalizeStandingRow)
            .filter(Boolean)
            .forEach(row => {
                const key = `${row.team?.id || row.team?.originalName || row.team?.name || row.position || ''}`;
                const previous = deduped.get(key);
                if (!previous || Number(row.points || 0) > Number(previous.points || 0)) {
                    deduped.set(key, row);
                }
            });

        return [...deduped.values()].sort((a, b) => Number(a.position ?? 999) - Number(b.position ?? 999));
    };

    const standingsGroups = gathered
        .filter(group => Array.isArray(group.rows) && group.rows.length)
        .map((group, index) => ({
            name: group.name || `المجموعة ${String.fromCharCode(65 + index)}`,
            standings: normalizeRows(group.rows)
        }))
        .filter(group => group.standings.length)
        .sort((first, second) => first.name.localeCompare(second.name, "en", { numeric: true }));

    return {
        standings: standingsGroups[0]?.standings || [],
        standingsGroups
    };
}

function normalizeTopScorersResponse(data) {
    const source = data?.data ?? data;
    const rows = [
        source?.topScorers,
        source?.top_scorers,
        source?.scorers,
        source?.players,
        source?.rows,
        Array.isArray(source) ? source : null
    ].find(Array.isArray) || [];
    const numericValue = value => value == null || value === ''
        ? null
        : Number.isFinite(Number(value)) ? Number(value) : null;

    return rows.map((row, index) => {
        const player = row.player || row.person || row.athlete || row;
        const team = row.team || row.club || row.squad || {};
        const teamName = team.name || row.teamName || '';
        const manualLogo = getFootballMediaLogo(team, "teams")
            || getFootballMediaLogo({ name: teamName }, "teams");
        const goals = numericValue(row.goals ?? row.goalsTotal ?? row.totalGoals
            ?? row.statistics?.goals ?? row.stats?.goals ?? player.goals);
        const name = player.name || row.playerName || row.name || '';
        if (!name || goals == null) return null;
        const apiRank = numericValue(row.rank ?? row.position ?? row.place ?? row.playerPlace);
        return {
            rank: apiRank || index + 1,
            name: translateTeam(name),
            originalName: name,
            goals,
            appearances: numericValue(row.appearances ?? row.matches ?? row.games ?? row.stats?.appearances),
            photo: player.photo || player.image || player.picture || row.photo || '',
            team: {
                id: team.id ?? row.teamId,
                name: translateTeam(teamName),
                originalName: teamName,
                logo: manualLogo || team.logo || team.badge || team.crest || row.teamLogo || ''
            }
        };
    }).filter(Boolean).sort((a, b) => a.rank - b.rank || b.goals - a.goals);
}

app.get("/api/leagues", async (req, res) => {
    try {
        if (!HAS_API_KEY) {
            return res.status(500).json({ success: false, error: "GOAL_API_KEY غير موجود في ملف .env" });
        }

        const leagues = (await getAllLeagues())
            .map(league => ({
                id: league.id,
                name: translateLeague(league.id, league.name, league.countryName || league.country),
                originalName: league.name,
                country: translateCountry(league.countryName || league.country || "دولي"),
                originalCountry: league.countryName || league.country || "International",
                logo: getFootballMediaLogo(league, "leagues"),
                seasonId: league.currentSeason?.id || league.currentSeason?.seasonId || league.season?.id || league.season?.seasonId || "",
                season: league.currentSeason?.name || league.currentSeason?.year || league.season?.name || league.season?.year || league.currentSeason || league.season || ""
            }))
            .sort((a, b) =>
                Number(hasLeagueTranslation(b.id, b.originalName, b.originalCountry))
                    - Number(hasLeagueTranslation(a.id, a.originalName, a.originalCountry))
                || getLeaguePriority(a) - getLeaguePriority(b)
                || a.name.localeCompare(b.name, "ar")
            );

        res.json({ success: true, leagues });
    }
    catch (error) {
        console.error("تعذر جلب الدوريات:", error.message);
        res.status(error.status || 500).json({ success: false, error: "تعذر تحميل الدوريات" });
    }
});

app.get("/api/search", async (req, res) => {
    try {
        if (!HAS_API_KEY) {
            return res.status(500).json({ success: false, error: "GOAL_API_KEY غير موجود في ملف .env" });
        }

        const query = String(req.query.q || "").trim();
        if (query.length < 2) {
            return res.status(400).json({ success: false, error: "أدخل حرفين على الأقل للبحث" });
        }

        const [teamData, leagues] = await Promise.all([
            goalApiJson(`${API_URL}/teams?search=${encodeURIComponent(query)}&limit=30`),
            getAllLeagues()
        ]);
        const teamSource = teamData?.data?.teams
            || teamData?.teams
            || teamData?.data?.results
            || teamData?.results
            || teamData?.data?.items
            || teamData?.items
            || teamData?.data
            || [];
        const teamRows = Array.isArray(teamSource)
            ? teamSource
            : teamSource && typeof teamSource === "object" && (teamSource.id || teamSource.teamId)
                ? [teamSource]
                : [];

        const teams = teamRows
            .map(row => row.team || row)
            .filter(team => team && (team.id || team.teamId) && (team.name || team.teamName))
            .map(team => {
                const nationalLogo = getNationalTeamFlagLogo(team);
                const originalName = team.name || team.teamName;
                const logo = nationalLogo
                    || getFootballMediaLogo(team, "teams")
                    || team.logo
                    || team.badge
                    || team.crest
                    || "";
                return {
                    id: team.id || team.teamId,
                    name: translateTeam(originalName),
                    originalName,
                    country: team.countryName || team.country?.name || team.country || "",
                    logo,
                    type: nationalLogo ? "national" : "club"
                };
            });

        const normalizeSearchText = value => String(value || "")
            .normalize("NFKC")
            .toLocaleLowerCase()
            .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        const normalizedQuery = normalizeSearchText(query);
        const matchingLeagues = leagues
            .filter(league => {
                const translatedName = translateLeague(league.id || league.leagueId, league.name, league.countryName || league.country);
                const searchableText = normalizeSearchText(`${league.name || ""} ${translatedName} ${league.countryName || league.country || ""}`);
                return normalizedQuery && searchableText.includes(normalizedQuery);
            })
            .slice(0, 30)
            .map(league => ({
                id: league.id || league.leagueId,
                name: translateLeague(league.id || league.leagueId, league.name, league.countryName || league.country),
                originalName: league.name,
                country: translateCountry(league.countryName || league.country || "دولي"),
                originalCountry: league.countryName || league.country || "International",
                logo: getFootballMediaLogo(league, "leagues"),
                seasonId: league.currentSeason?.id || league.currentSeason?.seasonId || league.season?.id || league.season?.seasonId || "",
                season: league.currentSeason?.name || league.currentSeason?.year || league.season?.name || league.season?.year || ""
            }));

        res.json({ success: true, teams, leagues: matchingLeagues });
    }
    catch (error) {
        console.error("تعذر البحث عن الفرق والبطولات:", error.message);
        res.status(error.status || 500).json({ success: false, error: "تعذر تنفيذ البحث" });
    }
});

app.get("/api/countries", async (req, res) => {
    try {
        if (!HAS_API_KEY) {
            return res.status(500).json({ success: false, error: "GOAL_API_KEY غير موجود في ملف .env" });
        }

        const countries = (await getAllCountries())
            .map(country => ({
                id: country.id || country.countryId || country.code || country.name,
                name: translateCountry(country.name || country.countryName || country.title || country.label || "غير معروف"),
                originalName: country.name || country.countryName || country.title || country.label || "",
                code: country.code || country.countryCode || country.iso || "",
                flag: country.flag || country.flagUrl || country.logo || "",
                slug: country.slug || country.url || "",
                originalName: country.name || country.countryName || country.title || country.label || ""
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "ar"));

        res.json({ success: true, countries, count: countries.length });
    }
    catch (error) {
        console.error("تعذر جلب الدول:", error.message);
        res.status(error.status || 500).json({ success: false, error: "تعذر تحميل الدول" });
    }
});

app.get("/api/league-fixtures/:leagueId", async (req, res) => {
    try {
        if (!HAS_API_KEY) {
            return res.status(500).json({ success: false, error: "GOAL_API_KEY غير موجود في ملف .env" });
        }

        const allMatches = /^(1|true|yes|all)$/i.test(String(req.query.all || ""));
        const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "")
            ? req.query.date
            : "";

        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "")
            ? req.query.from
            : (requestedDate || new Date().toISOString().slice(0, 10));

        const toDate = new Date(`${from}T12:00:00Z`);
        toDate.setUTCDate(toDate.getUTCDate() + 1);
        const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "")
            ? req.query.to
            : toDate.toISOString().slice(0, 10);

        const season = String(req.query.season || "").trim();
        const fixtures = [];
        const seenFixtureIds = new Set();
        const limit = 100;
        let offset = 0;
        let pageCount = 0;

        while (pageCount < MAX_PAGINATION_PAGES) {
            pageCount++;
            const seasonQuery = season ? `&season=${encodeURIComponent(season)}` : "";
            const data = await goalApiJson(
                `${API_URL}/leagues/${encodeURIComponent(req.params.leagueId)}/fixtures` +
                `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${seasonQuery}&limit=${limit}&offset=${offset}`
            );
            const page = Array.isArray(data)
                ? data
                : Array.isArray(data.data)
                    ? data.data
                    : Array.isArray(data.data?.fixtures)
                        ? data.data.fixtures
                        : Array.isArray(data.data?.events)
                            ? data.data.events
                            : Array.isArray(data.fixtures)
                                ? data.fixtures
                                : Array.isArray(data.events)
                                    ? data.events
                                    : [];

            if (!page.length) {
                break;
            }

            page.forEach(fixture => {
                const key = buildFixtureDedupeKey(fixture);
                if (key && seenFixtureIds.has(key)) {
                    return;
                }
                if (key) {
                    seenFixtureIds.add(key);
                }
                fixtures.push(fixture);
            });

            const pagination = data?.pagination || {};
            const hasMore = paginationSaysHasMore(pagination, page.length, limit);
            if (!hasMore) {
                break;
            }
            offset = nextPaginationOffset(pagination, offset, page.length, limit);
        }

        if (pageCount >= MAX_PAGINATION_PAGES) {
            console.warn(`⚠️ تم بلوغ الحد الأقصى لعدد صفحات pagination لمباريات الدوري ${req.params.leagueId}`);
        }

        const normalizedFixtures = fixtures
            .filter(event => {
                if (allMatches) return true;
                const dateValue = event.kickoffUtc || event.startTime || event.date || event.matchDate || '';
                return String(dateValue).slice(0, 10) === (requestedDate || from);
            })
            .map(applyNationalFlagToRawFixture);

        const translatedFixtures = translateTeamFixtureNames(normalizedFixtures);

        res.json({
            success: true,
            all: allMatches,
            selectedDate: allMatches ? null : (requestedDate || from),
            from,
            to,
            fixtures: translatedFixtures
        });
    }
    catch (error) {
        console.error("تعذر جلب مباريات البطولة:", error.message);
        res.status(error.status || 500).json({ success: false, error: "تعذر تحميل مباريات البطولة" });
    }
});

app.get("/api/standings/:leagueId", async (req, res) => {
    try {
        if (!HAS_API_KEY) {
            return res.status(500).json({ success: false, error: "GOAL_API_KEY غير موجود في ملف .env" });
        }

        const leagueId = req.params.leagueId;
        const season = String(req.query.season || "").trim();
        const cachedKey = `${leagueId}:${season || "current"}`;
        const cached = standingsCache.get(cachedKey);

        if (cached && Date.now() - cached.time < STANDINGS_CACHE_TIME) {
            return res.json(cached.data);
        }

        const url = new URL(`${API_URL}/standings/${encodeURIComponent(leagueId)}`);
        if (season) {
            url.searchParams.set("season", season);
        }

        const data = await goalApiJson(url.toString());
        const normalizedStandings = normalizeStandingsResponse(data);
        const result = {
            success: true,
            leagueId,
            historical: false,
            season: data?.season || data?.data?.season || data?.standings?.season || season || "",
            note: "يعرض هذا الجدول آخر ترتيب حقيقي متاح من Goal API، لأن endpoint الترتيب لا يدعم التاريخ.",
            standings: normalizedStandings.standings,
            standingsGroups: normalizedStandings.standingsGroups
        };

        standingsCache.set(cachedKey, { time: Date.now(), data: result });
        res.json(result);
    }
    catch (error) {
        console.error(`تعذر جلب ترتيب الدوري ${req.params.leagueId}:`, error.message);
        res.status(error.status || 500).json({ success: false, error: "تعذر تحميل الترتيب" });
    }
});

app.get("/api/top-scorers/:leagueId", async (req, res) => {
    try {
        if (!HAS_API_KEY) {
            return res.status(500).json({ success: false, error: "GOAL_API_KEY غير موجود في ملف .env" });
        }

        const leagueId = req.params.leagueId;
        const season = String(req.query.season || TOP_SCORERS_SEASON).trim();
        const cacheKey = `${leagueId}:${season || "current"}`;
        const cached = topScorersCache.get(cacheKey);
        if (cached && Date.now() - cached.time < TOP_SCORERS_CACHE_TIME) {
            return res.json(cached.data);
        }

        const seasonQuery = season ? `?season=${encodeURIComponent(season)}` : '';
        const urls = [
            `${API_URL}/leagues/${encodeURIComponent(leagueId)}/top-scorers${seasonQuery}`,
            `${API_URL}/leagues/${encodeURIComponent(leagueId)}/top-scorers`
        ];
        let data;
        let lastError;
        for (const url of urls) {
            try {
                data = await goalApiJson(url);
                break;
            }
            catch (error) {
                lastError = error;
            }
        }
        if (!data) throw lastError || new Error("تعذر جلب الهدافين");

        const result = {
            success: true,
            leagueId,
            season: data?.season || data?.data?.season || season,
            scope: 'season',
            scorers: normalizeTopScorersResponse(data)
        };
        topScorersCache.set(cacheKey, { time: Date.now(), data: result });
        res.json(result);
    }
    catch (error) {
        console.error(`تعذر جلب هدافي الدوري ${req.params.leagueId}:`, error.message);
        res.status(error.status || 500).json({ success: false, error: "تعذر تحميل هدافي البطولة" });
    }
});

app.get("/api/fixtures/:fixtureId", async (req, res) => {
    try {
        if (!HAS_API_KEY) {
            return res.status(500).json({ success: false, error: "GOAL_API_KEY غير موجود في ملف .env" });
        }

        const fixtureId = String(req.params.fixtureId || '').trim();
        if (!fixtureId) {
            return res.status(400).json({ success: false, error: "معرف المباراة غير صالح" });
        }

        const fixtureData = await goalApiJson(`${API_URL}/fixtures/${encodeURIComponent(fixtureId)}`);
        const fixture = translateTeamFixtureNames([
            applyNationalFlagToRawFixture(
                fixtureData?.data?.fixture || fixtureData?.fixture || fixtureData?.data || fixtureData
            )
        ])[0];
        const homeTeamId = fixture?.homeTeamId || fixture?.homeTeam?.id || fixture?.teams?.home?.id;
        const awayTeamId = fixture?.awayTeamId || fixture?.awayTeam?.id || fixture?.teams?.away?.id;
        const optionalRequests = [
            [`lineups`, `${API_URL}/fixtures/${encodeURIComponent(fixtureId)}/lineups`],
            [`statistics`, `${API_URL}/fixtures/${encodeURIComponent(fixtureId)}/statistics`]
        ];

        if (homeTeamId && awayTeamId) {
            optionalRequests.push([
                `headToHead`,
                `${API_URL}/h2h/${encodeURIComponent(homeTeamId)}/${encodeURIComponent(awayTeamId)}/direct`
            ]);
        }

        const optionalResults = await Promise.all(optionalRequests.map(async ([key, url]) => {
            try {
                const data = await goalApiJson(url);
                return [key, data?.data ?? data];
            }
            catch (error) {
                console.warn(`تعذر جلب ${key} للمباراة ${fixtureId}:`, error.message);
                return [key, null];
            }
        }));

        const details = Object.fromEntries(optionalResults);
        details.headToHead = translateHeadToHeadNames(details.headToHead);
        res.json({
            success: true,
            fixture,
            lineups: details.lineups,
            statistics: details.statistics,
            headToHead: details.headToHead
        });
    }
    catch (error) {
        console.error(`تعذر جلب تفاصيل المباراة ${req.params.fixtureId}:`, error.message);
        res.status(error.status || 500).json({ success: false, error: "تعذر تحميل تفاصيل المباراة" });
    }
});

app.get("/api/teams/:teamId/overview", async (req, res) => {
    try {
        if (!HAS_API_KEY) {
            return res.status(500).json({ success: false, error: "GOAL_API_KEY غير موجود في ملف .env" });
        }

        const teamId = String(req.params.teamId || '').trim();
        const season = String(req.query.season || '').trim();
        if (!teamId) return res.status(400).json({ success: false, error: "معرف الفريق غير صالح" });

        const fetchCollection = async (path) => {
            const items = [];
            const limit = 100;
            let offset = 0;
            for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
                const separator = path.includes('?') ? '&' : '?';
                const query = `${separator}limit=${limit}&offset=${offset}${season ? `&season=${encodeURIComponent(season)}` : ''}`;
                const data = await goalApiJson(`${API_URL}${path}${query}`);
                const pageItems = Array.isArray(data?.data) ? data.data
                    : Array.isArray(data?.fixtures) ? data.fixtures
                        : Array.isArray(data?.results) ? data.results
                            : Array.isArray(data) ? data : [];
                if (!pageItems.length) break;
                items.push(...pageItems);
                const pagination = data?.pagination || {};
                if (!paginationSaysHasMore(pagination, pageItems.length, limit)) break;
                offset = nextPaginationOffset(pagination, offset, pageItems.length, limit);
            }
            return items;
        };

        const [teamData, fixtures, results] = await Promise.all([
            goalApiJson(`${API_URL}/teams/${encodeURIComponent(teamId)}`),
            fetchCollection(`/teams/${encodeURIComponent(teamId)}/fixtures`),
            fetchCollection(`/teams/${encodeURIComponent(teamId)}/results`)
        ]);

        const team = teamData?.data?.team || teamData?.team || teamData?.data || teamData;
        const teamManualLogo = team && typeof team === 'object'
            ? getFootballMediaLogo(team, "teams") || getFootballMediaLogo({ name: team.name }, "teams")
            : '';
        const teamNationalLogo = team && typeof team === 'object' ? getNationalTeamFlagLogo(team) : '';
        const teamWithNationalLogo = team && typeof team === 'object'
            ? {
                ...team,
                logo: teamNationalLogo || teamManualLogo || team.logo || team.badge || team.crest || '',
                badge: teamNationalLogo || teamManualLogo || team.badge || team.logo || team.crest || '',
                crest: teamNationalLogo || teamManualLogo || team.crest || team.logo || team.badge || ''
            }
            : team;
        const translatedTeam = teamWithNationalLogo && typeof teamWithNationalLogo === 'object'
            ? { ...teamWithNationalLogo, name: teamWithNationalLogo.name ? translateTeam(teamWithNationalLogo.name) : teamWithNationalLogo.name }
            : teamWithNationalLogo;
        res.json({
            success: true,
            team: translatedTeam,
            fixtures: translateTeamFixtureNames(fixtures.map(applyNationalFlagToRawFixture)),
            results: translateTeamFixtureNames(results.map(applyNationalFlagToRawFixture)),
            season
        });
    }
    catch (error) {
        console.error(`تعذر جلب صفحة الفريق ${req.params.teamId}:`, error.message);
        res.status(error.status || 500).json({ success: false, error: "تعذر تحميل بيانات الفريق" });
    }
});


// =============================================
// LEAGUE PRIORITY
// الدوريات المهمة تظهر أولاً
// =============================================

const leaguePriority = {

    // =========================================
    // EUROPE
    // =========================================

    "الدوري الإسباني": 1,
    "الدوري الإنجليزي": 2,
    "الدوري الإنجليزي الممتاز": 2,
    "دوري أبطال أوروبا": 3,
    "دوري أبطال إفريقيا": 4,
    "كأس الاتحاد الإنجليزي": 5,
    "كأس الكونفدرالية الإفريقية": 6,
    "كأس الاتحاد الإفريقي": 6,
    "كأس خادم الحرمين الشريفين": 7,
    "كأس الملك السعودي": 7,
    "كأس الاتحاد السعودي": 7,
    "الدوري السعودي": 8,
    "الدوري السعودي للمحترفين": 8,
    "الدوري الفرنسي": 9,
    "كأس أمم إفريقيا": 10,
    "كأس أمم أفريقيا": 10,
    "كأس أمم أوروبا": 11,
    "بطولة أمم أوروبا": 11,
    "الدوري الألماني": 13,
    "الدوري الإيطالي": 12,


    // =========================================
    // MOROCCO / ARAB
    // =========================================

    "البطولة المغربية الاحترافية": 7,

    "الدوري المصري الممتاز": 8,

    "الدوري السعودي للمحترفين": 9,


    // =========================================
    // AFRICA
    // =========================================

    "دوري أبطال إفريقيا": 10,

    "كأس الكونفدرالية الإفريقية": 11,

    "كأس السوبر الإفريقي": 12,


    // =========================================
    // EUROPE CUPS
    // =========================================

    "الدوري الأوروبي": 13,

    "دوري المؤتمر الأوروبي": 14,

    "كأس السوبر الأوروبي": 15,


    // =========================================
    // INTERNATIONAL
    // =========================================

    "كأس العالم": 16,

    "كأس العالم للأندية": 17,

    "كأس أمم إفريقيا": 18,

    "كأس أمم إفريقيا للمحليين": 19,


    // =========================================
    // OTHER IMPORTANT
    // =========================================

    "الدوري البرتغالي": 20,

    "الدوري الهولندي": 21,

    "الدوري التركي": 22,

    "الدوري البلجيكي": 23

};


// =============================================
// SORT LEAGUES
// =============================================

function sortLeagues(leagues) {

    return leagues.sort(

        (
            a,
            b
        ) => {

            const translatedA = hasLeagueTranslation(
                a.leagueId,
                a.leagueOriginalName,
                a.countryOriginal || a.country
            );
            const translatedB = hasLeagueTranslation(
                b.leagueId,
                b.leagueOriginalName,
                b.countryOriginal || b.country
            );

            if (translatedA !== translatedB) {
                return translatedA ? -1 : 1;
            }

            const priorityA = getLeagueDisplayPriority(
                `${a.leagueName || ''} ${a.country || ''}`
            );

            const priorityB = getLeagueDisplayPriority(
                `${b.leagueName || ''} ${b.country || ''}`
            );


            // =================================
            // IMPORTANT LEAGUES FIRST
            // =================================

            if (
                priorityA !== priorityB
            ) {

                return (
                    priorityA -
                    priorityB
                );

            }


            // =================================
            // SAME PRIORITY
            // SORT ALPHABETICALLY
            // =================================

            return (
                a.leagueName ||
                ""
            )
            .localeCompare(

                b.leagueName ||
                "",

                "ar"

            );

        }

    );

}


// =============================================
// SORT MATCHES
// =============================================

function sortMatches(matches) {

    return matches.sort(

        (
            a,
            b
        ) => {

            return (
                a.timestamp ||
                0
            )
            -
            (
                b.timestamp ||
                0
            );

        }

    );

}


// =============================================
// GET FIXTURES
// =============================================

function normalizeBroadcastTeamName(value) {
    return String(value || "")
        .normalize("NFD")
        .toLowerCase()
        .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

app.get("/api/bzzoiro/broadcasts", async (req, res) => {
    const date = String(req.query.date || "");
    const homeNames = [req.query.home, req.query.homeOriginal]
        .map(normalizeBroadcastTeamName)
        .filter(Boolean);
    const awayNames = [req.query.away, req.query.awayOriginal]
        .map(normalizeBroadcastTeamName)
        .filter(Boolean);
    const countryCode = String(req.query.countryCode || "MA").toUpperCase();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !homeNames.length || !awayNames.length) {
        return res.status(400).json({ success: false, channels: [], error: "بيانات المباراة غير مكتملة" });
    }

    if (!/^[A-Z]{2}$/.test(countryCode)) {
        return res.status(400).json({ success: false, channels: [], error: "رمز البلد غير صالح" });
    }

    if (!BZZOIRO_API_KEY) {
        return res.status(503).json({ success: false, channels: [], configured: false });
    }

    const url = new URL(`${BZZOIRO_API_URL}/broadcasts/`);
    url.searchParams.set("date_from", date);
    url.searchParams.set("date_to", date);
    url.searchParams.set("country_code", countryCode);
    url.searchParams.set("limit", "200");

    try {
        const response = await fetch(url, {
            headers: {
                Authorization: `Token ${BZZOIRO_API_KEY}`,
                Accept: "application/json"
            }
        });

        if (!response.ok) {
            console.warn(`تعذر جلب قنوات BSD: ${response.status}`);
            return res.status(502).json({ success: false, channels: [] });
        }

        const data = await response.json();
        const broadcasts = Array.isArray(data) ? data : data.results || [];
        const matchingBroadcasts = broadcasts.filter(broadcast => {
            const broadcastHome = normalizeBroadcastTeamName(broadcast.home_team?.name || broadcast.home_team);
            const broadcastAway = normalizeBroadcastTeamName(broadcast.away_team?.name || broadcast.away_team);
            return homeNames.includes(broadcastHome) && awayNames.includes(broadcastAway);
        });
        const channels = [...new Set(matchingBroadcasts
            .map(broadcast => String(broadcast.channel_name || broadcast.channel?.name || "").trim())
            .filter(Boolean))];

        return res.json({ success: true, countryCode, channels });
    }
    catch (error) {
        console.error("تعذر جلب قنوات BSD:", error.message);
        return res.status(502).json({ success: false, channels: [] });
    }
});

app.get(

    "/api/fixtures",

    async (
        req,
        res
    ) => {


        try {


            // =================================
            // CHECK API KEY
            // =================================

            if (!HAS_API_KEY) {

                return res
                .status(500)
                .json({

                    success:

                        false,


                    error:

                        "GOAL_API_KEY غير موجود في ملف .env"

                });

            }


            // =================================
            // GET DATE
            // =================================

            const date =
                req.query.date;


            if (!date) {

                return res
                .status(400)
                .json({

                    success:

                        false,


                    error:

                        "يجب إرسال التاريخ"

                });

            }


            // =================================
            // VALIDATE DATE
            // =================================

            const validDate =
                /^\d{4}-\d{2}-\d{2}$/;


            if (
                !validDate.test(date)
            ) {

                return res
                .status(400)
                .json({

                    success:

                        false,


                    error:

                        "صيغة التاريخ يجب أن تكون YYYY-MM-DD"

                });

            }


            // =================================
            // CHECK CACHE
            // =================================

            const cached =
                cache.get(date);


            if (
                cached &&
                (
                    Date.now()
                    -
                    cached.time
                    <
                    CACHE_TIME
                )
            ) {

                console.log(
                    `📦 Cache used: ${date}`
                );


                return res.json(
                    translateFixtureNames(cached.data)
                );

            }


            console.log("");
            console.log(
                "📅 جاري جلب مباريات:",
                date
            );


            // =================================
            // API REQUEST - ALL FIXTURES FOR THE DAY
            // لا نستخدم قائمة ثابتة للدوريات ولا نستبعد المنتخبات
            // ونجلب كل الصفحات المتوفرة (بدون limit ثابت مثل 10/20)
            // =================================

            const allDateEvents = await fetchAllDateFixtures(date);
            let futsalEvents = [];
            try {
                futsalEvents = await getAfconFutsalFixtures(date);
            }
            catch (error) {
                console.error(`تعذر جلب مباريات كأس أمم أفريقيا داخل القاعة: ${error.message}`);
            }

            const fixtureKeys = new Set(allDateEvents.map(buildFixtureDedupeKey));
            allDateEvents.push(...futsalEvents.filter(event => {
                const key = buildFixtureDedupeKey(event);
                if (fixtureKeys.has(key)) return false;
                fixtureKeys.add(key);
                return true;
            }));

            console.log(`[GOAL API] Fixtures ${date}: ${allDateEvents.length} (including futsal AFCON)`);

            if (!allDateEvents.length) {
                console.warn(`⚠️ لا توجد مباريات متاحة لهذا التاريخ من GOAL API: ${date}`);
                return res.status(200).json({
                    success: true,
                    date,
                    count: 0,
                    leagueCount: 0,
                    leagues: [],
                    message: "لا توجد مباريات متاحة لهذا التاريخ من GOAL API",
                    reason: "empty response from GOAL API"
                });
            }

            const nationalTeamFixtures = allDateEvents.filter(event => getFixtureTypeMeta(event).national).length;
            const clubFixtures = allDateEvents.filter(event => getFixtureTypeMeta(event).club).length;
            const competitionsCount = new Set(
                allDateEvents
                    .map(event => event.leagueId || event.competition?.id || event.league?.id || event.tournament?.id || event.countryId || event.countryName)
                    .filter(Boolean)
            ).size;

            console.log("DATE:", date);
            console.log("TOTAL FIXTURES:", allDateEvents.length);
            console.log("NATIONAL TEAM FIXTURES:", nationalTeamFixtures);
            console.log("CLUB FIXTURES:", clubFixtures);
            console.log("COMPETITIONS COUNT:", competitionsCount);

            const events = allDateEvents;

            const fixtures =
                events.map(rawEvent => {

                    const event = applyNationalFlagToRawFixture(rawEvent);

                    const homeTeam =
                        event.homeTeam || event.home || {};

                    const awayTeam =
                        event.awayTeam || event.away || {};

                    const tournament =
                        event.competition || event.tournament || event.league || {};
                    const uniqueTournament = tournament.uniqueTournament || {};

                    const category =
                        tournament.country || event.countryName || event.country || {};

                    const status =
                        event.matchStatus || event.status || {};

                    const eventDate =
                        event.kickoffUtc ||
                        event.startTime ||
                        event.date ||
                        null;

                    const homeScore = normalizeScore(
                        event.homeTeamScore ??
                        event.homeTeamFtScore ??
                        event.homeScore ??
                        event.score?.home ??
                        event.home?.score
                    );

                    const awayScore = normalizeScore(
                        event.awayTeamScore ??
                        event.awayTeamFtScore ??
                        event.awayScore ??
                        event.score?.away ??
                        event.away?.score
                    );

                    const rawStatus =
                        typeof status === "string"
                            ? status
                            : status.type || status.short || status.status || "";

                    const normalizedStatus =
                        String(rawStatus)
                            .trim()
                            .toLowerCase()
                            .replace(/[ -]/g, "_");

                    const statusShort =
                        event.matchLive === true ||
                            ["live", "inprogress", "in_progress", "in_play", "inplay"].includes(normalizedStatus)
                            ? "LIVE"
                            : ["finished", "ft", "aet", "pen", "awarded", "completed", "complete", "ended", "end"].includes(normalizedStatus)
                                ? "FT"
                                : ["canceled", "cancelled", "postponed", "pst", "canc"].includes(normalizedStatus)
                                    ? "PST"
                                    : "NS";

                    const homeWinner =
                        homeScore > awayScore
                            ? true
                            : awayScore > homeScore
                                ? false
                                : null;

                    const awayWinner =
                        awayScore > homeScore
                            ? true
                            : homeScore > awayScore
                                ? false
                                : null;

                    return {

                        league: {
                            id: uniqueTournament.id || event.leagueId || tournament.id || tournament.competitionId,
                            name: uniqueTournament.name || tournament.name || event.leagueName || "بطولة غير معروفة",
                            country: category.name || category || "International",
                            logo: getFootballMediaLogo({
                                id: uniqueTournament.id || event.leagueId || tournament.id || tournament.competitionId,
                                name: uniqueTournament.name || tournament.name || event.leagueName,
                                logo: uniqueTournament.logo || event.leagueLogo || tournament.logo || ""
                            }, "leagues")
                        },

                        fixture: {
                            id: event.id || event.fixtureId,
                            date: eventDate,
                            timestamp: eventDate
                                ? Math.floor(Date.parse(eventDate) / 1000)
                                : 0,
                            round: event.matchRound ?? event.round ?? "",
                            venue: {
                                name: event.matchStadium || event.venue?.name || event.stadium?.name || ""
                            },
                            status: {
                                short: statusShort,
                                long: status.description || status.type || status || "",
                                elapsed: status.elapsed || null
                            }
                        },

                        teams: {
                            home: {
                                id: event.homeTeamId || homeTeam.id,
                                name: event.homeTeamName || homeTeam.name || homeTeam.teamName,
                                logo: homeTeam.badge || event.teamHomeBadge || homeTeam.logo || homeTeam.crest || "",
                                winner: homeWinner
                            },
                            away: {
                                id: event.awayTeamId || awayTeam.id,
                                name: event.awayTeamName || awayTeam.name || awayTeam.teamName,
                                logo: awayTeam.badge || event.teamAwayBadge || awayTeam.logo || awayTeam.crest || "",
                                winner: awayWinner
                            }
                        },

                        homeTeam: {
                            id: event.homeTeamId || homeTeam.id,
                            name: event.homeTeamName || homeTeam.name || homeTeam.teamName,
                            logo: homeTeam.badge || event.teamHomeBadge || homeTeam.logo || homeTeam.crest || ""
                        },

                        awayTeam: {
                            id: event.awayTeamId || awayTeam.id,
                            name: event.awayTeamName || awayTeam.name || awayTeam.teamName,
                            logo: awayTeam.badge || event.teamAwayBadge || awayTeam.logo || awayTeam.crest || ""
                        },

                        goals: {
                            home: homeScore,
                            away: awayScore
                        },

                        score: {
                            period1: {
                                home: event.homeTeamHalftimeScore ?? event.score?.halftime?.home,
                                away: event.awayTeamHalftimeScore ?? event.score?.halftime?.away
                            },
                            current: {
                                home: homeScore,
                                away: awayScore
                            }
                        }

                    };

                });


            console.log(
                `⚽ عدد المباريات: ${fixtures.length}`
            );


            // =================================
            // GROUP LEAGUES
            // =================================

            const leaguesMap =
                {};


            fixtures.forEach(

                item => {


                    // =============================
                    // LEAGUE DATA
                    // =============================

                    const leagueId =
                        item.league?.id;


                    if (
                        !leagueId
                    ) {

                        return;

                    }


                    const originalLeagueName =
                        item.league?.name
                        ||
                        "بطولة غير معروفة";


                    const originalCountry =
                        item.league?.country
                        ||
                        "International";
                    const leagueKey =
                        `${leagueId}:${normalizeName(originalLeagueName)}:${normalizeName(originalCountry)}`;


                    // =============================
                    // TRANSLATE LEAGUE
                    // =============================

                    const leagueName =
                        translateLeague(

                            leagueId,

                            originalLeagueName,

                            originalCountry

                        );


                    // =============================
                    // TRANSLATE COUNTRY
                    // =============================

                    const country =
                        translateCountry(
                            originalCountry
                        );


                    // =============================
                    // CREATE LEAGUE
                    // =============================

                    if (!leaguesMap[leagueKey]) {

                        leaguesMap[
                            leagueKey
                        ] = {

                            // League ID

                            leagueId:


                                leagueId,


                            // Arabic League Name

                            leagueName:


                                leagueName,


                            round:


                                item.fixture?.round
                                || item.matchRound
                                || item.round
                                || "",


                            // Original League Name

                            leagueOriginalName:


                                originalLeagueName,


                            // Country

                            country:


                                country,


                            countryOriginal:


                                originalCountry,


                            // League Logo

                            leagueLogo:


                                getFootballMediaLogo(item.league || {}, "leagues"),


                            // Matches

                            matches:


                                []

                        };

                    }

                    if (!leaguesMap[leagueKey].round) {
                        leaguesMap[leagueKey].round =
                            item.fixture?.round
                            || item.matchRound
                            || item.round
                            || "";
                    }


                    // =============================
                    // HOME TEAM
                    // =============================

                    const originalHomeName =
                        item.teams?.home?.name
                        ||
                        "الفريق الأول";


                    const homeName =
                        translateTeam(originalHomeName, item.league?.name || item.league?.originalName);


                    // =============================
                    // AWAY TEAM
                    // =============================

                    const originalAwayName =
                        item.teams?.away?.name
                        ||
                        "الفريق الثاني";


                    const awayName =
                        translateTeam(originalAwayName, item.league?.name || item.league?.originalName);


                    // =============================
                    // NATIONAL TEAM FLAGS
                    // إذا كان الفريق منتخباً وطنياً (اسمه يطابق
                    // اسم دولة معروفة) نستبدل شعار الاتحاد
                    // بعلم الدولة الدائري بدل شعار GOAL API
                    // =============================

                    const homeFlagLogo =
                        getNationalTeamFlagLogo(
                            originalHomeName
                        );


                    const awayFlagLogo =
                        getNationalTeamFlagLogo(
                            originalAwayName
                        );


                    // =============================
                    // FIXTURE DATA
                    // =============================

                    leaguesMap[
                        leagueKey
                    ]
                    .matches
                    .push({

                        // =========================
                        // FIXTURE ID
                        // =========================

                        id:

                            item.fixture?.id,


                        // =========================
                        // DATE
                        // =========================

                        date:

                            item.fixture?.date,


                        // =========================
                        // TIMESTAMP
                        // =========================

                        timestamp:

                            item.fixture?.timestamp,


                        // =========================
                        // VENUE
                        // =========================

                        venue:

                            item.fixture?.venue?.name
                            ||
                            "",


                        // =========================
                        // STATUS
                        // =========================

                        status:

                            getMatchStatus(
                                item.fixture?.status
                            ),


                        statusShort:

                            item.fixture?.status?.short
                            ||
                            "",


                        statusLong:

                            item.fixture?.status?.long
                            ||
                            "",


                        elapsed:

                            item.fixture?.status?.elapsed,


                        // =========================
                        // HOME
                        // =========================

                        home: {

                            id:

                                item.teams?.home?.id,


                            name:

                                homeName,


                            originalName:

                                originalHomeName,


                            logo:

                                homeFlagLogo
                                ||
                                item.teams?.home?.logo
                                ||
                                "",


                            winner:

                                item.teams?.home?.winner

                        },


                        // =========================
                        // AWAY
                        // =========================

                        away: {

                            id:

                                item.teams?.away?.id,


                            name:

                                awayName,


                            originalName:

                                originalAwayName,


                            logo:

                                awayFlagLogo
                                ||
                                item.teams?.away?.logo
                                ||
                                "",


                            winner:

                                item.teams?.away?.winner

                        },


                        homeTeam: {

                            id:

                                item.teams?.home?.id,


                            name:

                                homeName,


                            logo:

                                homeFlagLogo
                                ||
                                item.teams?.home?.logo
                                ||
                                ""

                        },


                        awayTeam: {

                            id:

                                item.teams?.away?.id,


                            name:

                                awayName,


                            logo:

                                awayFlagLogo
                                ||
                                item.teams?.away?.logo
                                ||
                                ""

                        },


                        // =========================
                        // GOALS
                        // =========================

                        goals: {

                            home:

                                item.goals?.home,


                            away:

                                item.goals?.away

                        },


                        // =========================
                        // SCORE
                        // =========================

                        score:

                            item.score
                            ||
                            {}

                    });


                }

            );


            // =================================
            // OBJECT TO ARRAY
            // =================================

            let leagues =
                Object.values(
                    leaguesMap
                );


            // =================================
            // SORT MATCHES
            // =================================

            leagues.forEach(

                league => {

                    league.matches =
                        sortMatches(
                            league.matches
                        );

                }

            );


            // =================================
            // SORT LEAGUES
            // =================================

            leagues =
                sortLeagues(
                    leagues
                );


            // =================================
            // FINAL RESULT
            // =================================

            const result = {

                success:

                    true,


                date:

                    date,


                count:

                    fixtures.length,


                leagueCount:

                    leagues.length,


                leagues:

                    leagues

            };


            // =================================
            // SAVE CACHE
            // =================================

            translateFixtureNames(result);

            cache.set(

                date,

                {

                    time:

                        Date.now(),


                    data:

                        result

                }

            );


            // =================================
            // CLEAN OLD CACHE
            // =================================

            if (
                cache.size > 10
            ) {

                const oldestKey =
                    cache.keys()
                    .next()
                    .value;


                cache.delete(
                    oldestKey
                );

            }


            console.log(
                `🏆 عدد البطولات: ${leagues.length}`
            );


            console.log(
                "✅ تم إرسال البيانات"
            );


            // =================================
            // RESPONSE
            // =================================

            res.json(
                result
            );


        }
        catch (
            error
        ) {

            const response =
                error && error.response
                    ? error.response
                    : null;

            const errorStatus =
                response?.status
                ?? error?.status
                ?? "غير متاح";

            const errorData =
                response?.data
                ?? error?.details
                ?? null;

            console.error("GOAL API Error Message:", error?.message || String(error));
            console.error("GOAL API Error Code:", error?.code || "غير متاح");
            console.error("GOAL API Error Status:", errorStatus);
            console.error("GOAL API Error Data:", errorData || "غير متاح");


            console.error("");
            console.error("=================================");
            console.error("❌ SERVER ERROR");
            console.error("=================================");
            console.error(
                error
            );
            console.error("=================================");
            console.error("");


            res
            .status(500)
            .json({

                success:

                    false,


                error:

                    "حدث خطأ في الخادم",


                message:

                    error.message

            });


        }


    }

);


// =============================================
// API TEST
// =============================================

app.get(

    "/api/test",

    async (
        req,
        res
    ) => {

        try {
            const liveLeagues = HAS_API_KEY ? await getAllLeagues() : [];
            const liveCountries = HAS_API_KEY ? await getAllCountries() : [];

            res.json({
                success: true,
                message: "السيرفر يعمل بنجاح",
                server: "Football Live",
                apiKey: HAS_API_KEY ? "موجودة ✅" : "غير موجودة ❌",
                live: {
                    leagues: liveLeagues.length,
                    countries: liveCountries.length
                },
                translations: {
                    teams: Object.keys(translations.teams).length,
                    leagueIds: Object.keys(translations.leagueIds).length,
                    leagueCountry: Object.keys(translations.leagueCountry).length,
                    leagues: Object.keys(translations.leagues).length,
                    countries: Object.keys(translations.countries).length
                },
                cache: {
                    items: cache.size,
                    duration: "5 دقائق"
                }
            });
        }
        catch (error) {
            res.status(500).json({
                success: false,
                error: "تعذر التحقق من بيانات GOAL API",
                message: error.message
            });
        }

    }

);


// =============================================
// TRANSLATION TEST
// =============================================

app.get(

    "/api/translate",

    (
        req,
        res
    ) => {


        const name =
            req.query.name;


        const country =
            req.query.country;


        const leagueId =
            req.query.leagueId;


        if (!name) {

            return res
            .status(400)
            .json({

                success:

                    false,


                error:

                    "أرسل name"

            });

        }


        res.json({

            success:

                true,


            original:

                {

                    name:

                        name,


                    country:

                        country || "",


                    leagueId:

                        leagueId || ""

                },


            translations:

                {

                    team:

                        translateTeam(
                            name
                        ),


                    league:

                        translateLeague(

                            leagueId,

                            name,

                            country

                        ),


                    country:

                        translateCountry(
                            name
                        )

                }

        });


    }

);


// =============================================
// CACHE CLEAR
// =============================================

app.get(

    "/api/cache/clear",

    (
        req,
        res
    ) => {


        cache.clear();


        res.json({

            success:

                true,


            message:

                "تم حذف Cache بنجاح"

        });


    }

);


// =============================================
// SPA FALLBACK FOR CLIENT ROUTES
// =============================================

app.get("/api/poster-editor-state", (req, res) => {
    try {
        let row = getPosterEditorState.get("project-default");
        if (!row && fs.existsSync(LEGACY_POSTER_EDITOR_STATE_PATH)) {
            try {
                const legacyState = JSON.parse(fs.readFileSync(LEGACY_POSTER_EDITOR_STATE_PATH, "utf8"));
                if (legacyState && typeof legacyState === "object" && !Array.isArray(legacyState)) {
                    savePosterEditorState.run("project-default", JSON.stringify(legacyState), new Date().toISOString());
                    row = getPosterEditorState.get("project-default");
                }
            }
            catch (migrationError) {
                console.error("Failed to migrate legacy poster editor state:", migrationError);
            }
        }

        res.set("Cache-Control", "no-store");
        res.json({
            success: true,
            hasState: Boolean(row),
            updatedAt: row?.updated_at || null,
            state: row ? JSON.parse(row.state_json) : {}
        });
    }
    catch (error) {
        console.error("Failed to read poster editor state:", error);
        res.status(500).json({ success: false, error: "تعذر تحميل التصميم المحفوظ" });
    }
});

app.put("/api/poster-editor-state", (req, res) => {
    const state = req.body;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
        return res.status(400).json({ success: false, error: "بيانات التصميم غير صالحة" });
    }

    try {
        const updatedAt = new Date().toISOString();
        savePosterEditorState.run("project-default", JSON.stringify(state), updatedAt);
        res.json({ success: true, updatedAt });
    }
    catch (error) {
        console.error("Failed to save poster editor state:", error);
        res.status(500).json({ success: false, error: "تعذر حفظ التصميم على الخادم" });
    }
});

app.get(/^\/match\/.+$/, (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get(/^\/(?!api\/).*$/, (req, res) => {
    const pathname = req.path || "/";
    if (pathname === "/" || pathname.startsWith("/match/")) {
        return res.sendFile(path.join(__dirname, "index.html"));
    }
    return res.sendFile(path.join(__dirname, "index.html"));
});

// =============================================
// START SERVER
// =============================================

app.listen(

    PORT,

    () => {


        console.log("");
        console.log("==============================================");
        console.log("        ⚽ FOOTBALL LIVE SERVER");
        console.log("==============================================");

        console.log(
            `🌐 Website: http://localhost:${PORT}`
        );

        console.log(
            `🧪 Test: http://localhost:${PORT}/api/test`
        );

        console.log("");

        console.log(

            HAS_API_KEY

            ?

            "🔑 API Key: موجودة ✅"

            :

            "🔑 API Key: غير موجودة ❌"

        );


        console.log("");

        console.log(
            `⚽ Teams: ${
                Object.keys(
                    translations.teams
                ).length
            }`
        );


        console.log(
            `🏆 League IDs: ${
                Object.keys(
                    translations.leagueIds
                ).length
            }`
        );


        console.log(
            `🌍 League Countries: ${
                Object.keys(
                    translations.leagueCountry
                ).length
            }`
        );


        console.log(
            `📦 Cache: النتائج 20 ثانية، الترتيب 45 ثانية، الهدافون 10 دقائق`
        );


        console.log("==============================================");
        console.log("");

    }

);