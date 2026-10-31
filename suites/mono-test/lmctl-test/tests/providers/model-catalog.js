// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------
/**
 * Vendor version strings disagree across sources on `.` vs `-`
 * (`claude-opus-4.6` on OpenRouter vs `claude-opus-4-6` first-party,
 * `deepseek-v3.2` vs `deepseek-v3-2`). Identity keys collapse digit-dot-digit
 * to digit-dash-digit so the two spellings group as one identity. `:batch`
 * and other variant suffixes are preserved -- batch rows stay distinct.
 */
function identityNorm(id) {
    return id.toLowerCase().replace(/(\d)\.(\d)/g, "$1-$2");
}
/** Identity key of one catalog row: normalized LAST `/`-segment. */
function recordIdentity(record) {
    const id = record.source_model_id.toLowerCase();
    const last = id.slice(id.lastIndexOf("/") + 1);
    return identityNorm(last);
}
/**
 * Candidate fields of one row (design section 1, step 2): the full
 * source_model_id, EVERY path suffix of it (stripping LiteLLM route
 * prefixes like `openrouter/`, `azure_ai/`, `bedrock/<region>/` is a
 * special case of taking suffixes), and gateway_id (+ its suffixes) where
 * present. All identity-normalized.
 */
function rowCandidateFields(record) {
    const fields = new Set();
    const addPath = (raw) => {
        const segments = raw.toLowerCase().split("/");
        for (let i = 0; i < segments.length; i += 1) {
            fields.add(identityNorm(segments.slice(i).join("/")));
        }
    };
    addPath(record.source_model_id);
    if (record.gateway_id)
        addPath(record.gateway_id);
    return fields;
}
/**
 * Shared declared-name normalization: lowercase, split a hermes-style
 * `route:model` colon prefix (only when the prefix is path-free), and emit
 * the bare id, the vendor-prefixed forms this adapter's vendor uses across
 * sources, and the colon route rewritten as a path. Everything passes
 * through identityNorm so `.`/`-` version spellings both match.
 */
function normalizeDeclared(declared, vendorPrefixes) {
    const out = new Set();
    const add = (id) => {
        out.add(identityNorm(id));
    };
    let id = declared.trim().toLowerCase();
    let colonPrefix = null;
    const colon = id.indexOf(":");
    if (colon > 0 && !id.slice(0, colon).includes("/")) {
        colonPrefix = id.slice(0, colon);
        add(id); // keep the full colon form too -- exact-id rows may carry it
        id = id.slice(colon + 1);
    }
    add(id);
    const bare = id.slice(id.lastIndexOf("/") + 1);
    add(bare);
    for (const prefix of vendorPrefixes)
        add(`${prefix}/${bare}`);
    if (colonPrefix !== null)
        add(`${colonPrefix}/${bare}`);
    return [...out];
}
function makeAdapter(spec) {
    const isChatModel = (record) => {
        if (record.mode !== undefined && record.mode !== null && record.mode !== "chat")
            return false;
        if (spec.nonChatName && spec.nonChatName.test(record.source_model_id.toLowerCase()))
            return false;
        return true;
    };
    const coversRecord = (record) => isChatModel(record) && spec.family.test(record.source_model_id.toLowerCase());
    return {
        firstPartyProviders: spec.firstPartyProviders,
        isChatModel,
        coversRecord,
        normalize: (declared) => normalizeDeclared(declared, spec.vendorPrefixes),
        matchRow(record, candidates) {
            if (!coversRecord(record))
                return false;
            const fields = rowCandidateFields(record);
            return candidates.some((candidate) => fields.has(candidate));
        },
    };
}
// ---------------------------------------------------------------------------
// Adapters (design section 1 -- grounded against the real 4,783-record
// dataset; see tests/providers/model-catalog.test.ts for the fixtures that
// prove each family/mode claim made here)
// ---------------------------------------------------------------------------
/**
 * claude (Anthropic first-party). Real rows: bare `claude-opus-4-6`
 * (provider anthropic), `openrouter/anthropic/claude-*` LiteLLM route rows,
 * OpenRouter `anthropic/claude-*` gateway rows (incl. `:batch`), and
 * bedrock/azure/vertex route variants -- the family name `claude` appears
 * in every one of them.
 */
const claudeAdapter = makeAdapter({
    vendorPrefixes: ["anthropic"],
    family: /claude/,
    firstPartyProviders: ["anthropic"],
});
/**
 * codex (OpenAI). Chat/reasoning families ONLY -- the catalog's openai rows
 * also cover tts / transcription / realtime / search / image modes, and
 * some excluded families hide inside mode "chat" (`gpt-4o-mini-search-preview`,
 * `gpt-5-search-api`, `gpt-4o-audio-preview`), so the name filter is as
 * load-bearing as the mode filter.
 */
const codexAdapter = makeAdapter({
    vendorPrefixes: ["openai"],
    family: /(^|\/)(gpt-|o\d|chatgpt|ft:gpt)|openai\//,
    firstPartyProviders: ["openai"],
    nonChatName: /(^|[-/])(tts|transcribe(?:-\w+)?|realtime(?:-\w+)?|search(?:-\w+)*|image(?:-\w+)?|audio(?:-\w+)?|whisper(?:-\w+)?|dall-e(?:-\w+)?|embedding|moderation)(-|$)/,
});
/**
 * gemini (Google). Chat only: the first-party-style `gemini/gemini-*` block
 * also contains embedding / image_generation / audio_speech /
 * audio_transcription / realtime / video_generation modes, plus chat-mode
 * impostors (`gemini-2.5-pro-preview-tts`, OpenRouter's
 * `google/gemini-2.5-flash-image`).
 */
const geminiAdapter = makeAdapter({
    vendorPrefixes: ["google", "gemini"],
    family: /gemini|gemma/,
    firstPartyProviders: ["gemini", "google", "vertex_ai-language-models"],
    nonChatName: /embedding|imagen|-image|tts|audio|veo|lyria|live|realtime|video/,
});
/**
 * kimi (Moonshot). Bare `kimi-*` rows (moonshot first-party source),
 * `moonshot/*` LiteLLM rows (incl. legacy `moonshot-v1-*`), and the many
 * third-party route rows that carry `moonshotai/` in the path. The review
 * found the naive `/^kimi/` regex matched 1/109 relevant rows precisely
 * because it ignored the `moonshot/` forms.
 */
const kimiAdapter = makeAdapter({
    vendorPrefixes: ["moonshot", "moonshotai"],
    family: /kimi|moonshot/,
    firstPartyProviders: ["moonshot"],
});
/**
 * qwen (Alibaba). Bare names, first-party `dashscope/*` rows, and gateway
 * `qwen/*` rows. Family match is on `qwen` ONLY -- `dashscope/` also hosts
 * other vendors' models (e.g. `dashscope/kimi-k2.7-code`), so the route
 * prefix must not confer family membership.
 */
const qwenAdapter = makeAdapter({
    vendorPrefixes: ["dashscope", "qwen"],
    family: /qwen/,
    firstPartyProviders: ["dashscope"],
});
/**
 * hermes: declared ids are Hermes's encoded `<provider>:<model>` form
 * (`deepseek:deepseek-v4.1-flash`); normalize splits the colon. Families
 * per the Hermes deployments lmctl actually runs: deepseek + Nous Research
 * (`nousresearch/hermes-*`, `NousResearch/Hermes-*`).
 */
const hermesAdapter = makeAdapter({
    vendorPrefixes: ["deepseek", "nousresearch"],
    family: /deepseek|nous|hermes-\d/,
    firstPartyProviders: ["deepseek", "nousresearch"],
});
/**
 * agy (Antigravity). Explicit lookup table, NOT pattern matching -- unlike
 * every other adapter here, no vendor-prefix/family regex can work for agy,
 * because agy exposes Google's Gemini models under ITS OWN display-label
 * strings with a reasoning-effort tier baked directly into the name
 * (`"Gemini 3.8 Flash (High)"`), and no upstream catalog source will ever
 * carry that exact string verbatim (operator decision, 2026-09-29,
 * math.lmctl findings 002/003: "nothing but an explicit row can fix it").
 *
 * Ruling (operator, 2026-09-29, finding 005): "(High) or (Medium) are
 * effort, not model. agy provider side (in lmctl) need to do this." Effort
 * is NOT part of the catalog identity and never enters lmprice's table --
 * this adapter splits the declared string into model + effort itself
 * (splitAgyEffort below) and looks up ONLY the model part. This is a
 * refactor of the original table (which had one entry PER effort-tier
 * string), not a behavior change for any of the 11 strings already
 * covered -- but it means a NEW effort value agy adds later for an
 * ALREADY-KNOWN model (e.g. a hypothetical "Gemini 3.8 Flash (Ultra)")
 * resolves for free, with no new table entry needed. A genuinely new base
 * model still resolves `unknown` regardless of its effort suffix -- per
 * the same ruling ("for the new model, lint just assume the default, all
 * possible values"), lctl-src doesn't validate effort values against a
 * fixed list either way, so this needs no separate enforcement.
 *
 * Verified live against `agy models` (2026-09-29) -- raw output recorded in
 * durable-memory/model_selection.md's Antigravity section. Every effort-tier
 * variant of one base model maps to that base model's own catalog identity:
 * the effort/thinking-budget knob changes how many tokens a turn generates,
 * not the per-token rate -- true of every major vendor's reasoning-effort
 * parameter (OpenAI, Claude, Gemini alike), not something agy does
 * differently. Independently corroborated, finding 005: models.dev
 * (opencode's own model dataset, ~/.cache/opencode/models.json) lists
 * these same 4 Gemini models under `google/*`, with no effort dimension at
 * all -- the same "effort isn't a model" conclusion, from a third source.
 *
 * lmprice's OWN aliases.json already independently covers 4 of these 11
 * strings this way (established evidence, sourced from
 * antigravity.google/docs/models, added 2026-09-24 -- predates this table):
 * "gemini 3.8 flash (high/medium)" and "gemini 3.1 pro (high)". Those
 * resolve via the alias-table step (checked FIRST, terminal) and never
 * reach this table at all -- confirmed live via resolveOfferForCost's
 * provenance field ("alias-pin" for those 4, "route-preference" -- this
 * table -- for the other 7). No conflict: this table exists purely to
 * cover the remaining 7 lmprice hasn't published yet (all of 3.7-flash and
 * 3.6-flash had zero coverage), the fleet's largest unpriced population
 * (86 members, math.lmctl finding, 2026-09-29). The 3 non-Gemini agy
 * models (claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium)
 * are NOT covered here yet -- 2 of those 3 already have SOME alias
 * coverage under a different (dashed-slug) spelling that doesn't match
 * agy's actual display-label declarations, so they're likely still gaps.
 */
const AGY_EFFORT_SUFFIX_RE = /\s*\(([^()]+)\)\s*$/;
/** Splits an agy declared string into its model and effort parts --
 *  "Gemini 3.8 Flash (High)" -> { model: "Gemini 3.8 Flash", effort: "High" }.
 *  No suffix -> effort null, model unchanged (agy's 3 non-tiered models,
 *  e.g. a bare "GPT-OSS 120B" with no parenthetical, would pass through
 *  as-is). Display only, not a validation -- an unrecognized model still
 *  resolves `unknown` regardless of what (if anything) follows it. */
function splitAgyEffort(declared) {
    const trimmed = declared.trim();
    const match = AGY_EFFORT_SUFFIX_RE.exec(trimmed);
    if (!match)
        return { model: trimmed, effort: null };
    return { model: trimmed.slice(0, match.index).trim(), effort: match[1].trim() };
}
const AGY_MODEL_TO_IDENTITY = {
    "gemini 3.8 flash": "gemini-3.8-flash",
    "gemini 3.7 flash": "gemini-3.7-flash",
    "gemini 3.6 flash": "gemini-3.6-flash",
    "gemini 3.1 pro": "gemini/gemini-3.1-pro-preview",
    // agy fronts Anthropic's Claude too, not just Google's Gemini (math.lmctl,
    // 2026-09-29): 3 members declare "Claude Opus 4.6 (Thinking)", which
    // already resolves via an lmprice alias (added 2026-09-24) that pins ahead
    // of this table entirely, so it needs no row here. "Claude Sonnet 4.6
    // (Thinking)" has no such alias and was a genuine unknown until this row.
    "claude sonnet 4.6": "claude-sonnet-4-6",
    // "GPT-OSS 120B (Medium)" remains unmapped on purpose: unlike Claude/Gemini,
    // OpenAI does not host this open-weight model itself, so there is no single
    // first-party row to prefer among a dozen equally-plausible inference
    // providers (groq, fireworks_ai, cerebras, deepinfra, ...) -- picking one
    // without evidence of which route agy actually uses would be exactly the
    // guess this table exists to avoid.
};
const AGY_FIRST_PARTY_PROVIDERS = ["gemini", "google", "vertex_ai-language-models", "anthropic"];
const agyAdapter = {
    normalize(declared) {
        const { model } = splitAgyEffort(declared);
        const target = AGY_MODEL_TO_IDENTITY[model.toLowerCase()];
        return target === undefined ? [] : [identityNorm(target)];
    },
    // Found while adding the cross-provider "wrong-provider" check (operator,
    // 2026-09-29): this always returned true, unconditionally, and coversRecord
    // never consulted it anyway -- so a non-chat row (an embedding model,
    // say) matching the gemini|claude family regex was wrongly treated as
    // something agy could run. Real gap, not just a new-check false positive:
    // agy is a chat CLI and genuinely cannot run a non-chat row either.
    isChatModel(record) {
        return record.mode === undefined || record.mode === null || record.mode === "chat";
    },
    coversRecord(record) {
        return this.isChatModel(record) && /gemini|claude/.test(record.source_model_id.toLowerCase());
    },
    matchRow(record, candidates) {
        if (!this.coversRecord(record))
            return false;
        const fields = rowCandidateFields(record);
        return candidates.some((candidate) => fields.has(candidate));
    },
};
/**
 * Providers WITHOUT adapters are skipped (`no-catalog`): copilot, opencode,
 * pi, dsh, lmplayer. dsh/opencode models can still resolve via the aliases
 * table, which is consulted BEFORE the adapter check.
 */
export const PROVIDER_ADAPTERS = {
    claude: claudeAdapter,
    codex: codexAdapter,
    gemini: geminiAdapter,
    agy: agyAdapter,
    kimi: kimiAdapter,
    qwen: qwenAdapter,
    hermes: hermesAdapter,
};
const FIRST_PARTY_PROVIDERS = {
    claude: claudeAdapter.firstPartyProviders,
    codex: codexAdapter.firstPartyProviders,
    gemini: geminiAdapter.firstPartyProviders,
    agy: AGY_FIRST_PARTY_PROVIDERS,
    kimi: kimiAdapter.firstPartyProviders,
    qwen: qwenAdapter.firstPartyProviders,
    hermes: hermesAdapter.firstPartyProviders,
};
/** Does this adapter recognize `declared` as belonging to a real catalog
 *  record, anywhere in the dataset? Existence check only (mirrors
 *  resolveInternal's own exact-id + normalized-candidate passes) -- no
 *  offer selection, since the caller only needs yes/no. Safe to call with
 *  any adapter against any declared string: `matchRow` always gates on
 *  `coversRecord`'s family regex first, so an adapter can never claim a
 *  record outside its own vendor family no matter what `candidates`
 *  normalize() happens to produce for an unrelated string. */
function adapterRecognizes(adapter, declared, data) {
    const needle = declared.trim().toLowerCase();
    const exactNeedle = identityNorm(needle);
    if (data.records.some((r) => r.source_model_id.toLowerCase() === needle && adapter.matchRow(r, [exactNeedle]))) {
        return true;
    }
    const candidates = adapter.normalize(declared);
    return candidates.length > 0 && data.records.some((r) => adapter.matchRow(r, candidates));
}
/** Which OTHER providers' adapters recognize `declared` as a real model, when
 *  `excludeProvider`'s own adapter does not. Operator, 2026-09-29 ("the lint
 *  has three outcomes"): this is what distinguishes a confirmed "this
 *  provider cannot run it" (lint error) from a genuinely ambiguous "not in
 *  the catalog at all" (lint warning). */
function findOtherProvidersServing(declared, data, excludeProvider) {
    const found = [];
    for (const [name, adapter] of Object.entries(PROVIDER_ADAPTERS)) {
        if (name === excludeProvider)
            continue;
        if (adapterRecognizes(adapter, declared, data))
            found.push(name);
    }
    return found;
}
// ---------------------------------------------------------------------------
// Offer selection
// ---------------------------------------------------------------------------
/** Route preference (design section 1): first-party > litellm > openrouter > manual. */
function sourceRank(source) {
    if (source === "moonshot")
        return 0; // the only first-party source in the dataset
    if (source === "litellm")
        return 1;
    if (source === "openrouter")
        return 2;
    if (source === "manual")
        return 3;
    return 4;
}
/** The 3 pricing fields the type contract actually declares (PriceRecord in
 * pricing.ts) -- the fields cost.ts's calculations and hasRates() key off
 * of. Deliberately narrower than a raw deep-equal over the whole pricing
 * object, which also carries source-specific extras (source_cost_fields,
 * audio/image/reasoning rates, ...) that can differ in shape between two
 * upstream entries without the two entries meaning a different price. */
function corePricingEquals(a, b) {
    return (a.input_per_1m_tokens === b.input_per_1m_tokens
        && a.output_per_1m_tokens === b.output_per_1m_tokens
        && a.input_cache_read_per_1m_tokens === b.input_cache_read_per_1m_tokens);
}
/**
 * Two catalog records from the SAME source, under the SAME route (identical
 * source_model_id up to the last path segment), differing only by a
 * dot-vs-dash spelling of that segment's version number, are one real slot
 * listed twice -- not two independent offers (finding 014, math.lmctl,
 * 2026-09-29: `litellm:vercel_ai_gateway/anthropic/claude-3.5-sonnet` and
 * `litellm:vercel_ai_gateway/anthropic/claude-3-5-sonnet` both existed as
 * literal rows, so `recordIdentity`'s dot/dash fold -- needed for
 * legitimate cross-SOURCE reconciliation, e.g. OpenRouter's dotted spelling
 * vs LiteLLM's dashed one for the same real model -- silently doubled this
 * one route's vote in the broader cross-route tie-break, letting an
 * unrelated third route win by alphabetical accident instead of either
 * vercel_ai_gateway row). Collapse the pair to one, preferring the dashed
 * spelling (LiteLLM's own modern convention, see identityNorm's doc
 * comment) -- but ONLY when their prices agree. A genuine price
 * disagreement between the two spellings is exactly the ambiguity this
 * dedup must never paper over, so it is left untouched for the ordinary
 * tie-break to handle precisely as before this fix.
 */
function dedupeSameRouteSpellingVariants(records) {
    const bySlot = new Map();
    const passthrough = [];
    for (const record of records) {
        const id = record.source_model_id.toLowerCase();
        const slashIndex = id.lastIndexOf("/");
        const routePrefix = slashIndex === -1 ? "" : id.slice(0, slashIndex + 1);
        const lastSegment = slashIndex === -1 ? id : id.slice(slashIndex + 1);
        // identityNorm is a no-op on an already-dashed segment, so this key
        // applies uniformly -- gating on "does THIS record's own spelling have
        // a dot" would only ever catch the dotted half of a pair (the dashed
        // sibling has no dot to test), which is exactly the bug this fixes.
        const slotKey = `${record.source}:${routePrefix}${identityNorm(lastSegment)}`;
        const existing = bySlot.get(slotKey);
        if (existing === undefined) {
            bySlot.set(slotKey, record);
            continue;
        }
        if (!corePricingEquals(existing.pricing, record.pricing)) {
            passthrough.push(record);
            continue;
        }
        if (/\d\.\d/.test(existing.source_model_id) && !/\d\.\d/.test(record.source_model_id)) {
            bySlot.set(slotKey, record);
        }
        // else: keep whichever was seen first -- either existing is already the
        // dashed spelling, or both spellings tie (identical dots), in which case
        // there's no preference to apply.
    }
    return [...bySlot.values(), ...passthrough];
}
function offerFor(record) {
    return {
        route: record.record_id ?? `${record.source}:${record.source_model_id}`,
        source: record.source,
        sourceModelId: record.source_model_id,
        provider: record.provider ?? null,
        pricing: record.pricing,
        estimated: record.source === "manual",
    };
}
function sortOffers(records, firstPartyProviders) {
    return records
        .map(offerFor)
        .sort((a, b) => {
        const bySource = sourceRank(a.source) - sourceRank(b.source);
        if (bySource !== 0)
            return bySource;
        const aFirst = a.provider !== null && firstPartyProviders.includes(a.provider) ? 0 : 1;
        const bFirst = b.provider !== null && firstPartyProviders.includes(b.provider) ? 0 : 1;
        if (aFirst !== bFirst)
            return aFirst - bFirst;
        return a.sourceModelId.localeCompare(b.sourceModelId);
    });
}
function hasRates(offer) {
    return offer.pricing.input_per_1m_tokens !== null && offer.pricing.output_per_1m_tokens !== null;
}
function modelFromRecords(records, identity, firstPartyProviders) {
    const deduped = dedupeSameRouteSpellingVariants(records);
    const offers = sortOffers(deduped, firstPartyProviders);
    const winning = deduped.find((r) => (r.record_id ?? `${r.source}:${r.source_model_id}`) === offers[0].route);
    const contextWindow = winning?.context_window?.input_tokens ?? undefined;
    return {
        id: offers[0].sourceModelId,
        normalizedId: identity,
        offers,
        ...(contextWindow !== null && contextWindow !== undefined ? { contextWindow } : {}),
    };
}
function stateForRecords(records, identity, firstPartyProviders) {
    // Defensive empty-offer guard: an established identity with no priceable
    // rows is known-unpriced, never a crash (see resolveAliasPin).
    if (records.length === 0)
        return { kind: "known-unpriced", id: identity };
    const model = modelFromRecords(records, identity, firstPartyProviders);
    const pricedOffer = model.offers.find(hasRates);
    if (pricedOffer === undefined)
        return { kind: "known-unpriced", id: identity };
    if (pricedOffer.estimated)
        return { kind: "estimated", model };
    return { kind: "priced", model };
}
// ---------------------------------------------------------------------------
// Alias path
// ---------------------------------------------------------------------------
const NO_PROVIDERS = [];
function standardPin(aliases, slug) {
    return aliases.standards.find((s) => s.standard_slug.toLowerCase() === slug.toLowerCase()) ?? null;
}
function resolveAliasPin(entry, standard, data) {
    const slug = entry.standard_slug;
    if (standard === null || standard.catalog_record_id === null) {
        // Identity established; lmprice publishes no catalog row (e.g.
        // moonshot/kimi-k2.8-preview -- subscription-billed, no first-party price).
        return { kind: "known-unpriced", id: slug };
    }
    const pin = standard.catalog_record_id.toLowerCase();
    const pinned = data.records.find((r) => (r.record_id ?? `${r.source}:${r.source_model_id}`).toLowerCase() === pin);
    if (!pinned) {
        // Pin points at a record absent from this snapshot -- identity still
        // established by the standard, but no price row here.
        return { kind: "known-unpriced", id: slug };
    }
    const identity = recordIdentity(pinned);
    const offers = data.records.filter((r) => {
        if (recordIdentity(r) !== identity)
            return false;
        return r.mode === undefined || r.mode === null || r.mode === "chat";
    });
    if (offers.length === 0) {
        // The pin resolves to a record whose rows carry no priceable chat
        // offer (real case, lmprice batch 2: litellm:chatgpt/gpt-5.3-codex-spark
        // is mode "responses" + null-priced -- a subscription-only preview
        // SKU). The identity IS established; there is simply no applicable
        // rate -- known-unpriced, NOT a crash and NOT a guessed price.
        return { kind: "known-unpriced", id: slug };
    }
    return stateForRecords(offers, identity, NO_PROVIDERS);
}
function resolveInternal(provider, declared, data, aliases) {
    if (data === null || !Array.isArray(data.records)) {
        return { state: { kind: "no-catalog" }, viaAlias: false, pinRoute: null };
    }
    // 1. aliases.json exact hit FIRST -- the identity mechanism for harness
    //    providers, consulted even when the provider has no adapter. Probe
    //    both the declared string itself AND its provider-qualified form in
    //    ALL cases: batch-2 alias keys are harness-qualified even when the
    //    declared model itself contains `/` (`lmplayer/ollama-cloud/kimi-k3`
    //    for declared `ollama-cloud/kimi-k3`, `opencode/qwen/qwen3-coder-plus`
    //    for declared `qwen/qwen3-coder-plus`). Declared-exact is probed
    //    first, so a declared string that IS the alias key
    //    (`qwen/qwen3.6-plus` under provider qwen) wins over the
    //    double-prefixed probe.
    if (aliases !== null) {
        const keys = [declared.trim().toLowerCase()];
        keys.push(`${provider.toLowerCase()}/${keys[0]}`);
        const entry = aliases.aliases.find((a) => keys.includes(a.alias.toLowerCase()));
        if (entry) {
            if (entry.evidence === "unresolved" || entry.standard_slug === null) {
                return { state: { kind: "unresolved", alias: entry.alias }, viaAlias: true, pinRoute: null };
            }
            const standard = standardPin(aliases, entry.standard_slug);
            return {
                state: resolveAliasPin(entry, standard, data),
                viaAlias: true,
                pinRoute: standard?.catalog_record_id?.toLowerCase() ?? null,
            };
        }
    }
    // 2. Adapter path.
    const adapter = PROVIDER_ADAPTERS[provider];
    if (!adapter)
        return { state: { kind: "no-catalog" }, viaAlias: false, pinRoute: null };
    const needle = declared.trim().toLowerCase();
    const candidates = adapter.normalize(declared);
    const done = (state) => ({ state, viaAlias: false, pinRoute: null });
    // 2a. Exact-id pass (incl. `:batch` variants) BEFORE normalized matching:
    //     the exact row pins the identity; offers are then ALL family rows
    //     sharing that identity (so `kimi-k3` still sees its moonshot/litellm/
    //     openrouter offers, while a `:batch` id pins the batch-only identity).
    const exactNeedle = identityNorm(needle);
    const exact = data.records.filter((r) => r.source_model_id.toLowerCase() === needle && adapter.matchRow(r, [exactNeedle]));
    if (exact.length > 0) {
        const identity = recordIdentity(exact[0]);
        const group = data.records.filter((r) => adapter.matchRow(r, [identity]) && recordIdentity(r) === identity);
        return done(stateForRecords(group.length > 0 ? group : exact, identity, FIRST_PARTY_PROVIDERS[provider] ?? NO_PROVIDERS));
    }
    // 2b. Normalized candidate-field matching, grouped by identity.
    const matched = data.records.filter((r) => adapter.matchRow(r, candidates));
    if (matched.length === 0) {
        // Operator, 2026-09-29 ("the lint has three outcomes"): a miss under
        // THIS provider's adapter is only genuinely ambiguous ("unknown") if no
        // OTHER provider's adapter recognizes it either. If some other adapter's
        // family DOES match a real record, the identity is established -- this
        // provider's own column for it is simply empty, a confirmed mismatch
        // ("cannot possibly work"), not a maybe-just-unpublished-yet guess.
        const otherProviders = findOtherProvidersServing(declared, data, provider);
        if (otherProviders.length > 0)
            return done({ kind: "wrong-provider", declared, otherProviders });
        return done({ kind: "unknown", declared });
    }
    const byIdentity = new Map();
    for (const record of matched) {
        const identity = recordIdentity(record);
        const group = byIdentity.get(identity);
        if (group)
            group.push(record);
        else
            byIdentity.set(identity, [record]);
    }
    // Deterministic winner: the identity group containing the
    // route-preference-best row.
    const firstParty = FIRST_PARTY_PROVIDERS[provider] ?? NO_PROVIDERS;
    let bestGroup = null;
    let bestOffers = null;
    for (const group of byIdentity.values()) {
        const offers = sortOffers(group, firstParty);
        if (bestOffers === null || compareOffers(offers[0], bestOffers[0], firstParty) < 0) {
            bestGroup = group;
            bestOffers = offers;
        }
    }
    return done(stateForRecords(bestGroup, recordIdentity(bestGroup[0]), firstParty));
}
/**
 * Resolve one declared model string for one provider against a loaded
 * catalog snapshot + alias table. Pure; never throws; no I/O.
 */
export function resolveModel(provider, declared, data, aliases) {
    return resolveInternal(provider, declared, data, aliases).state;
}
export function resolveOfferForCost(provider, declared, data, aliases) {
    const { state, viaAlias, pinRoute } = resolveInternal(provider, declared, data, aliases);
    if (state.kind !== "priced" && state.kind !== "estimated") {
        return { state, offer: null, provenance: null };
    }
    const offers = state.model.offers;
    if (viaAlias && pinRoute !== null) {
        const pinned = offers.find((o) => o.route.toLowerCase() === pinRoute);
        if (pinned !== undefined && hasRates(pinned)) {
            return { state, offer: pinned, provenance: "alias-pin" };
        }
    }
    const offer = offers.find(hasRates) ?? null;
    return { state, offer, provenance: viaAlias && pinRoute !== null ? "alias-pin" : "route-preference" };
}
/**
 * Count of distinct model identities a provider's adapter covers in this
 * catalog -- the "(N known)" in lint/seed's unknown-model warning. `null`
 * when the provider has no adapter.
 */
export function catalogKnownModelCount(data, provider) {
    const adapter = PROVIDER_ADAPTERS[provider];
    if (!adapter)
        return null;
    const identities = new Set();
    for (const record of data.records) {
        if (adapter.coversRecord(record))
            identities.add(recordIdentity(record));
    }
    return identities.size;
}
function compareOffers(a, b, firstParty) {
    const bySource = sourceRank(a.source) - sourceRank(b.source);
    if (bySource !== 0)
        return bySource;
    const aFirst = a.provider !== null && firstParty.includes(a.provider) ? 0 : 1;
    const bFirst = b.provider !== null && firstParty.includes(b.provider) ? 0 : 1;
    if (aFirst !== bFirst)
        return aFirst - bFirst;
    return a.sourceModelId.localeCompare(b.sourceModelId);
}
//# sourceMappingURL=model-catalog.js.map