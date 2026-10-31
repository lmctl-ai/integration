/**
 * lmctl ecosystem program #3175 (math.lmctl) -- Phase 1 of `lmctl cost`:
 * price lookup backed by lmprice's published model catalog
 * (https://lmctl.com/dataset/model_list.json), online-first with a
 * bundled-at-build-time fallback so cost works offline / with no network.
 *
 * Extended for the lmprice <-> lmctl integration (approved design v2,
 * section 3): the loader now manages TWO published resources --
 * `model_list.json` and `aliases.json` -- each with its own
 * etag/last_checked in the cache's `meta.json`, a TTL gate (default 6h;
 * `LMCTL_PRICE_TTL` in seconds, `0` forces a refresh; inside the TTL there
 * is NO network at all), coherent snapshot promotion (both payloads are
 * validated before the cache swap; a payload that fails validation keeps
 * the last valid generation), and `LMCTL_PRICE_DATA=<dir>` snapshot pinning
 * (a directory containing both files; DISABLES network refresh entirely --
 * the reproducibility/test seam). One snapshot load per process invocation:
 * the no-argument call is memoized module-wide.
 *
 * Sourcing policy (design approved by math.lmctl before this was built):
 *   1. Outside the TTL, try a plain HEAD request against the live URL with a
 *      strict, short timeout -- headers only, so a large/slow BODY download
 *      can never blow this budget. A matching ETag (compared client-side; no
 *      conditional GET/If-None-Match involved) means the on-disk cache is
 *      already current; a changed ETag issues a separate full GET (its own
 *      longer timeout budget) to download the new body and refresh the cache.
 *   2. ANY failure (offline, DNS, timeout, non-ok status, malformed JSON,
 *      payload failing validation) falls through SILENTLY to the on-disk
 *      cache if one exists.
 *   3. If there is no cache either, fall through to the bundled files shipped
 *      inside the npm package (written by `scripts/fetch-price-data.mjs` at
 *      build time -- see that script's own doc comment).
 *   4. If NONE of the three exist (fresh checkout, never built, offline, no
 *      cache yet -- only realistic in local dev), price data is simply
 *      unavailable; callers must treat that as "no price," never an error
 *      that fails the whole command.
 * This module never throws for a sourcing failure -- the whole point is that
 * a `lmctl cost` call must never block or fail because of network state.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const PRICE_DATA_URL = "https://lmctl.com/dataset/model_list.json";
export const PRICE_ALIASES_URL = "https://lmctl.com/dataset/aliases.json";
const VERSION_CHECK_TIMEOUT_MS = 1_000;
const DOWNLOAD_TIMEOUT_MS = 10_000;
/** Design section 3: default 6h; LMCTL_PRICE_TTL (seconds) overrides, 0 forces. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
function defaultCacheDir() {
    return join(homedir(), ".lmctl", "cache", "lmprice");
}
const MODEL_LIST_FILE = "model_list.json";
const ALIASES_FILE = "aliases.json";
const META_FILE = "meta.json";
const LEGACY_META_FILE = "model_list.meta.json";
function cacheFilePath(cacheDirPath, fileName) {
    return join(cacheDirPath, fileName);
}
function readJsonFile(path) {
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    }
    catch {
        return null;
    }
}
function writeFileAtomic(path, contents) {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
}
// ---------------------------------------------------------------------------
// Payload validation (design section 3: schema_version pin on both,
// record/alias structure sanity, numeric-or-null rate fields). Used on
// network payloads BEFORE cache promotion AND on cached payloads before
// use -- a corrupt cache is treated as absent, never served.
// ---------------------------------------------------------------------------
function isNumberOrNull(value) {
    return value === null || typeof value === "number";
}
export function isValidCatalog(payload) {
    if (typeof payload !== "object" || payload === null)
        return false;
    const catalog = payload;
    if (catalog.schema_version !== 1)
        return false;
    if (!Array.isArray(catalog.records) || catalog.records.length === 0)
        return false;
    return catalog.records.every((record) => {
        if (typeof record !== "object" || record === null)
            return false;
        const r = record;
        if (typeof r.source !== "string" || typeof r.source_model_id !== "string")
            return false;
        if (typeof r.pricing !== "object" || r.pricing === null)
            return false;
        const p = r.pricing;
        return (isNumberOrNull(p.input_per_1m_tokens) &&
            isNumberOrNull(p.output_per_1m_tokens) &&
            isNumberOrNull(p.input_cache_read_per_1m_tokens));
    });
}
const ALIAS_EVIDENCE_STATES = new Set(["established", "asserted", "unresolved"]);
export function isValidAliases(payload) {
    if (typeof payload !== "object" || payload === null)
        return false;
    const table = payload;
    if (table.schema_version !== 1)
        return false;
    if (!Array.isArray(table.standards) || !Array.isArray(table.aliases))
        return false;
    const standardsOk = table.standards.every((standard) => {
        if (typeof standard !== "object" || standard === null)
            return false;
        const s = standard;
        return (typeof s.standard_slug === "string" &&
            (s.catalog_record_id === null || typeof s.catalog_record_id === "string"));
    });
    const aliasesOk = table.aliases.every((entry) => {
        if (typeof entry !== "object" || entry === null)
            return false;
        const a = entry;
        return (typeof a.alias === "string" &&
            (a.standard_slug === null || typeof a.standard_slug === "string") &&
            typeof a.evidence === "string" &&
            ALIAS_EVIDENCE_STATES.has(a.evidence));
    });
    return standardsOk && aliasesOk;
}
const EMPTY_META = { etag: null, last_checked: null };
function readCacheMeta(cacheDirPath) {
    const parsed = readJsonFile(cacheFilePath(cacheDirPath, META_FILE));
    const modelList = {
        etag: typeof parsed?.model_list?.etag === "string" ? parsed.model_list.etag : null,
        last_checked: typeof parsed?.model_list?.last_checked === "string" ? parsed.model_list.last_checked : null,
    };
    const aliases = {
        etag: typeof parsed?.aliases?.etag === "string" ? parsed.aliases.etag : null,
        last_checked: typeof parsed?.aliases?.last_checked === "string" ? parsed.aliases.last_checked : null,
    };
    if (parsed === null) {
        // Migration path: the pre-two-resource cache kept a per-file sidecar.
        const legacy = readJsonFile(cacheFilePath(cacheDirPath, LEGACY_META_FILE));
        if (legacy) {
            modelList.etag = typeof legacy.etag === "string" ? legacy.etag : null;
            modelList.last_checked = typeof legacy.fetchedAt === "string" ? legacy.fetchedAt : null;
        }
    }
    return { model_list: modelList, aliases };
}
function readCache(cacheDirPath) {
    const meta = readCacheMeta(cacheDirPath);
    const catalogRaw = readJsonFile(cacheFilePath(cacheDirPath, MODEL_LIST_FILE));
    const aliasesRaw = readJsonFile(cacheFilePath(cacheDirPath, ALIASES_FILE));
    return {
        catalog: isValidCatalog(catalogRaw) ? catalogRaw : null,
        aliases: isValidAliases(aliasesRaw) ? aliasesRaw : null,
        meta,
    };
}
function writeCacheMeta(cacheDirPath, meta) {
    try {
        mkdirSync(cacheDirPath, { recursive: true });
        writeFileAtomic(cacheFilePath(cacheDirPath, META_FILE), JSON.stringify(meta));
    }
    catch {
        // Best-effort, same rationale as the payload write below.
    }
}
function writeCacheResource(cacheDirPath, fileName, payload) {
    try {
        mkdirSync(cacheDirPath, { recursive: true });
        writeFileAtomic(cacheFilePath(cacheDirPath, fileName), JSON.stringify(payload));
    }
    catch {
        // Best-effort. A failed cache write just means the next call re-checks
        // the network (or re-uses the bundled fallback) -- never fatal.
    }
}
// ---------------------------------------------------------------------------
// Bundled fallback
// ---------------------------------------------------------------------------
function bundledDataPath(here, fileName) {
    const root = nearestPackageRoot(here);
    const candidates = root
        ? [resolve(root, "data", fileName)]
        : [
            // Bundled package layout: <pkg>/dist/providers/pricing.js.
            resolve(here, "..", "..", "data", fileName),
        ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
function nearestPackageRoot(start) {
    let current = resolve(start);
    for (;;) {
        if (existsSync(resolve(current, "package.json")))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
function loadBundled(here, fileName, overridePath) {
    const path = overridePath !== undefined ? overridePath : bundledDataPath(here, fileName);
    if (path === null)
        return null;
    return readJsonFile(path);
}
// ---------------------------------------------------------------------------
// TTL + pin env
// ---------------------------------------------------------------------------
function ttlMsFromEnv() {
    const raw = process.env.LMCTL_PRICE_TTL;
    if (raw === undefined || raw === "")
        return DEFAULT_TTL_MS;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0)
        return DEFAULT_TTL_MS;
    return seconds * 1000;
}
function pinDirFromEnv() {
    const raw = process.env.LMCTL_PRICE_DATA;
    return raw !== undefined && raw !== "" ? raw : null;
}
async function refreshResource(doFetch, url, cachedPayload, cachedEtag) {
    try {
        const headResponse = await doFetch(url, {
            method: "HEAD",
            signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
        });
        if (!headResponse.ok)
            return { kind: "failed" };
        const etag = headResponse.headers.get("etag");
        if (cachedPayload !== null && etag !== null && etag === cachedEtag) {
            return { kind: "match" };
        }
        const response = await doFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok)
            return { kind: "failed" };
        return { kind: "payload", payload: await response.json(), etag: response.headers.get("etag") ?? etag };
    }
    catch {
        // Offline, DNS failure, timeout, malformed JSON -- fall through silently.
        return { kind: "failed" };
    }
}
let lastGeneratedAt = null;
/** Dataset generated_at of the most recently loaded snapshot, for --debug surfaces. */
export function datasetGeneratedAt() {
    return lastGeneratedAt;
}
let memoizedSnapshot = null;
/** Test seam: drop the memoized no-argument snapshot (process-level memo). */
export function _resetCatalogSnapshotMemoForTests() {
    memoizedSnapshot = null;
}
/**
 * The one snapshot loader for the lmprice integration. Never throws. One
 * snapshot load per process invocation: the no-argument call (the normal
 * command path) is memoized module-wide, so lint/seed/cost members never
 * trigger per-member re-downloads; calls with explicit options (tests,
 * seams) always execute.
 */
export function loadCatalogSnapshot(opts = {}) {
    if (Object.keys(opts).length === 0) {
        memoizedSnapshot ??= loadCatalogSnapshotUncached(opts);
        return memoizedSnapshot;
    }
    return loadCatalogSnapshotUncached(opts);
}
async function loadCatalogSnapshotUncached(opts) {
    const here = dirname(fileURLToPath(import.meta.url));
    const pinDir = opts.pinDir !== undefined ? opts.pinDir : pinDirFromEnv();
    // Pinned snapshot: both files from one directory, network DISABLED.
    // Design section 3 -- reproducible project-local use + test seam.
    if (pinDir !== null && pinDir !== "") {
        const catalogRaw = readJsonFile(join(pinDir, MODEL_LIST_FILE));
        const aliasesRaw = readJsonFile(join(pinDir, ALIASES_FILE));
        if (isValidCatalog(catalogRaw) && isValidAliases(aliasesRaw)) {
            const snapshot = {
                catalog: catalogRaw,
                aliases: aliasesRaw,
                source: "pinned",
                generatedAt: catalogRaw.generated_at ?? null,
            };
            lastGeneratedAt = snapshot.generatedAt;
            return snapshot;
        }
        // A broken pin never reaches the network; fall back to bundled only.
        return finishWithBundled(opts, here);
    }
    const doFetch = opts.fetchImpl ?? fetch;
    const cacheDirPath = opts.cacheDir ?? defaultCacheDir();
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? ttlMsFromEnv();
    const cache = readCache(cacheDirPath);
    const isFresh = (payload, meta) => payload !== null &&
        meta.last_checked !== null &&
        now - Date.parse(meta.last_checked) < ttlMs;
    let catalog = cache.catalog;
    let aliases = cache.aliases;
    let usedNetwork = false;
    const newMeta = {
        model_list: { ...cache.meta.model_list },
        aliases: { ...cache.meta.aliases },
    };
    let metaDirty = false;
    // Inside the TTL a resource makes NO network call at all; outside it the
    // HEAD/GET flow runs per resource with independent etags. The stored etag
    // only advances when a payload was VALIDATED and promoted (or the HEAD
    // matched the cached etag) -- a rejected generation is retried next time.
    if (!isFresh(catalog, cache.meta.model_list)) {
        const outcome = await refreshResource(doFetch, PRICE_DATA_URL, catalog, cache.meta.model_list.etag);
        if (outcome.kind === "match") {
            newMeta.model_list.last_checked = new Date(now).toISOString();
            metaDirty = true;
        }
        else if (outcome.kind === "payload") {
            newMeta.model_list.last_checked = new Date(now).toISOString();
            metaDirty = true;
            // Coherent promotion: a payload that fails validation NEVER reaches
            // the cache -- the last valid generation stays on disk.
            if (isValidCatalog(outcome.payload)) {
                catalog = outcome.payload;
                if (outcome.etag !== null)
                    newMeta.model_list.etag = outcome.etag;
                writeCacheResource(cacheDirPath, MODEL_LIST_FILE, catalog);
                usedNetwork = true;
            }
        }
    }
    if (!isFresh(aliases, cache.meta.aliases)) {
        const outcome = await refreshResource(doFetch, PRICE_ALIASES_URL, aliases, cache.meta.aliases.etag);
        if (outcome.kind === "match") {
            newMeta.aliases.last_checked = new Date(now).toISOString();
            metaDirty = true;
        }
        else if (outcome.kind === "payload") {
            newMeta.aliases.last_checked = new Date(now).toISOString();
            metaDirty = true;
            if (isValidAliases(outcome.payload)) {
                aliases = outcome.payload;
                if (outcome.etag !== null)
                    newMeta.aliases.etag = outcome.etag;
                writeCacheResource(cacheDirPath, ALIASES_FILE, aliases);
                usedNetwork = true;
            }
        }
    }
    if (metaDirty || usedNetwork)
        writeCacheMeta(cacheDirPath, newMeta);
    if (catalog !== null || aliases !== null) {
        const snapshot = {
            catalog,
            aliases,
            source: usedNetwork ? "network" : "cache",
            generatedAt: catalog?.generated_at ?? null,
        };
        lastGeneratedAt = snapshot.generatedAt;
        return snapshot;
    }
    return finishWithBundled(opts, here);
}
function finishWithBundled(opts, here) {
    const catalogRaw = loadBundled(here, "price-data.json", opts.bundledPath);
    const aliasesRaw = loadBundled(here, "price-aliases.json", opts.bundledAliasesPath);
    const catalog = isValidCatalog(catalogRaw) ? catalogRaw : null;
    const aliases = isValidAliases(aliasesRaw) ? aliasesRaw : null;
    const snapshot = {
        catalog,
        aliases,
        source: catalog !== null || aliases !== null ? "bundled" : "unavailable",
        generatedAt: catalog?.generated_at ?? null,
    };
    lastGeneratedAt = snapshot.generatedAt;
    return snapshot;
}
/**
 * The one function `lmctl cost`'s Phase 1 callers use. Never throws, never
 * blocks longer than `VERSION_CHECK_TIMEOUT_MS` for the "is there anything
 * new" check regardless of network state (per resource, outside the TTL) --
 * a HEAD request specifically so a slow/large BODY download can never blow
 * that budget. Thin wrapper over loadCatalogSnapshot: the model-list half
 * of the snapshot with the same result shape as before the two-resource
 * extension.
 */
export async function loadPriceData(opts = {}) {
    const snapshot = await loadCatalogSnapshot(opts);
    return { catalog: snapshot.catalog, source: snapshot.source, generatedAt: snapshot.generatedAt };
}
/**
 * Records are source-specific and NOT reconciled across sources (lmprice's
 * own documented behavior) -- the same model can appear many times (bare id,
 * `vendor/id`, `region/vendor/id`, ...) with the litellm and openrouter
 * sources potentially disagreeing. `records` is already sorted by
 * (source, provider, source_model_id) -- "litellm" sorts before "openrouter"
 * -- so preferring the first exact-bare-id match, then the first
 * suffix (`/<modelId>`) match, is a deterministic, if arbitrary, tie-break
 * rather than an average/reconciliation across disagreeing sources.
 *
 * Superseded for provider-aware resolution by model-catalog.ts's
 * resolveModel(); kept for `lmctl cost` Phase 1 compatibility.
 */
export function findModelPrice(catalog, modelId) {
    const needle = modelId.toLowerCase();
    const exact = catalog.records.find((r) => r.source_model_id.toLowerCase() === needle);
    if (exact)
        return exact.pricing;
    const suffixed = catalog.records.find((r) => r.source_model_id.toLowerCase().endsWith(`/${needle}`));
    return suffixed ? suffixed.pricing : null;
}
/**
 * Phase 1 cost model (approved design): the session's existing AGGREGATE
 * token totals x one model's rate -- not a true per-model breakdown (see
 * `runCost`'s `approximate` flag for when a session touched more than one
 * model; that's a separate, later sub-task). `cachedInput` is priced at the
 * cache-READ rate only -- lmprice's `input_cache_write_per_1m_tokens` isn't
 * consumed here because lctl-src's own token accounting
 * (`totalCachedInputTokens`) has never distinguished cache-write from
 * cache-read tokens; conflating them into the (usually cheaper) read rate
 * would UNDERSTATE cost for a cache-write-heavy session, but overstating via
 * the (usually pricier) write rate for every cache hit is worse on average.
 * Returns `null` when any needed price is missing -- never a partial/guessed
 * number.
 */
export function computeCostUsd(tokens, pricing) {
    if (pricing === null)
        return null;
    const { input_per_1m_tokens, output_per_1m_tokens, input_cache_read_per_1m_tokens } = pricing;
    if (input_per_1m_tokens === null || output_per_1m_tokens === null)
        return null;
    const cacheRate = input_cache_read_per_1m_tokens ?? input_per_1m_tokens;
    const cost = (tokens.input / 1_000_000) * input_per_1m_tokens +
        (tokens.output / 1_000_000) * output_per_1m_tokens +
        (tokens.cachedInput / 1_000_000) * cacheRate;
    return Number(cost.toPrecision(10));
}
//# sourceMappingURL=pricing.js.map