// Rate-limit, usage-limit, and credit-exhaustion classifier.
// Shared by provider-smoke.mjs, models-validity.mjs, and live-probe.mjs.
// Operator rule (2026-10-20): "ratelimit is never a gate, at most warning".

import { spawnSync } from 'node:child_process';

// REJECT FIRST (before any rate_limit or model_refused decision):
// Infrastructure, filesystem, process, authentication, syntax, and timeout markers.
// If any of these matches, the message is ALWAYS classified as `error`, even if 429 or model is mentioned.
export const REJECT_FIRST_PATTERNS = [
  /permission denied/i,
  /no such file/i,
  /\bfile\s+(?:not\s+found|does\s+not\s+exist)\b/i,
  /\b(?:cannot|failed\s+to|could\s+not)\s+(?:open|read|write)\s+file\b/i,
  /\bENOENT\b/i,
  /\b(?:EACCES|EPERM)\b/i,
  /command not found/i,
  /not found in PATH/i,
  /syntax error/i,
  /\b(?:TypeError|ReferenceError|AssertionError)\b/i,
  /authentication failed/i,
  /\bunauthorized\b/i,
  /\b401\b/i,
  /\b403\b/i,
  /\bforbidden\b/i,
  /invalid api key|api key not valid/i,
  /timed? ?out/i,
  /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT)\b/i,
  /\bstalled\b/i,
  /idleTimeout/i,
  /(?:model\s+)?config(?:uration)?.*(?:not found|does not exist|missing|failed to load)/i,
  /failed to load.*(?:model\s+)?config(?:uration)?/i,
  /(?:model\s+)?cache.*(?:not found|does not exist|missing)/i,
  /invalid\s+model\s+configuration/i,
];

export function isRejectFirst(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  // Evaluate infrastructure/filesystem/auth evidence across the WHOLE message (every line).
  // One infrastructure line anywhere makes the result `error`.
  return s.split('\n').some(line => line.trim() && REJECT_FIRST_PATTERNS.some(re => re.test(line.trim()))) || REJECT_FIRST_PATTERNS.some(re => re.test(s));
}

// Generic refusal-shaped check: refusal phrasing cannot soften to a quota warning.
export function isRefusalShaped(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return /\b(?:no access|do not have access)\b/i.test(s) ||
         /\b(?:unknown|invalid|unsupported)\s+model\b/i.test(s) ||
         /\bmodel\s+(?:is\s+)?(?:unknown|invalid|unsupported|not found|does not exist|is not available|not available|may not exist)\b/i.test(s) ||
         /\bmodel\s+['"]?[a-zA-Z0-9_.-]+['"]?\s+(?:(?:is|was)\s+)?(?:not found|does not exist|is not available|not available|may not exist|not supported|is unsupported)\b/i.test(s) ||
         /\b(?:not found|does not exist|not available|may not exist)\b.*model/i.test(s) ||
         /\bmodel_not_offered\b/i.test(s) ||
         /\b(?:not_found_error|model_not_found|model_not_available)\b/i.test(s) ||
         /(?:The\s+)?model\s+(?:['"]?[a-zA-Z0-9_.-]+['"]?\s+)?may not exist or you may not have access/i.test(s) ||
         /\bissue\s+with\s+the\s+selected\s+model\b.*(?:may not exist or you may not have access)/i.test(s) ||
         /\bis\s+not\s+a\s+valid\s+model\b/i.test(s);
}

// Model refusal: exact anchored grammar where the PROBED modelId is the direct object.
// Positive delimiter set on both sides:
// Character before: start-of-string, whitespace, quote (' " `) or one of ([{<:,;
// Character after: end-of-string, whitespace, quote, or one of )]}>:,;.!? where . / ! / ? count only when followed by whitespace or end of string.
// Quoted ids must have matching quotes.
// No wildcards between id and verb.
export function isModelRefusal(text, modelId = null) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (isRejectFirst(s)) return false;

  const mid = typeof modelId === 'string' && modelId.trim() ? modelId.trim() : null;

  if (mid) {
    const esc = mid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pre = `(?<=^|[\\s(\\[{<:,;])`;
    const post = `(?=$|[\\s)\\]}>:,;]|[.\\!?](?:\\s|$))`;
    const quoted = `(?:'${esc}'|"${esc}"|\`${esc}\`)`;
    const paired = `(?:\\(${esc}\\)|\\[${esc}\\]|\\{${esc}\\}|<${esc}>)`;
    const idToken = `(?:${pre}(?:${quoted}|${paired}|${esc})${post})`;
    const modelRefusalPatterns = [
      // model ['"]?ID['"]? (was )?(not found|does not exist|is not available|may not exist)
      new RegExp(`\\bmodel\\s+${idToken}\\s+(?:(?:is|was)\\s+)?(?:not found|does not exist|is not available|not available|may not exist|not supported|is unsupported)\\b`, 'i'),
      // unknown model:? ['"]?ID
      new RegExp(`\\bunknown\\s+model:?\\s*${idToken}`, 'i'),
      // invalid model:? ['"]?ID
      new RegExp(`\\binvalid\\s+model:?\\s*${idToken}`, 'i'),
      // (no access|do not have access) to (the )?model:? ['"]?ID
      new RegExp(`\\b(?:no access|do not have access)\\s+to\\s+(?:the\\s+)?model:?\\s*${idToken}`, 'i'),
      // ID is not a valid model
      new RegExp(`${idToken}\\s+is\\s+not\\s+a\\s+valid\\s+model\\b`, 'i'),
      new RegExp(`${idToken}\\s+(?:(?:is|was)\\s+)?(?:not available|is not available|not supported|is unsupported|unknown|invalid)\\b`, 'i'),
      new RegExp(`\\b(?:not_found_error|model_not_found|model_not_available):?\\s*${idToken}`, 'i'),
      // issue with the selected model (ID).? It may not exist or you may not have access
      new RegExp(`\\bissue\\s+with\\s+the\\s+selected\\s+model\\s*\\(\\s*${idToken}\\s*\\)\\.?\\s*(?:it\\s+)?may\\s+not\\s+exist\\s+or\\s+you\\s+may\\s+not\\s+have\\s+access`, 'i'),
    ];
    return modelRefusalPatterns.some(re => re.test(s));
  }

  // When modelId is not supplied, require that the error is refusal-shaped
  return isRefusalShaped(s);
}

export function isStallOrTimeout(text) {
  const s = String(text || '');
  return /\bstalled before first token\b|\bstalled\b|ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|idleTimeout/i.test(s);
}

// Canonical rate-limit / usage-limit / credit-exhaustion allowlist
export const RATE_LIMIT_PATTERNS = [
  /\b429\b/i,
  /too many requests/i,
  /\brate[- ]?limit(?:ed)?\b/i,
  /\busage[- ]?limit\b/i,
  /\bout of usage credits\b/i,
  /\bquota\b.*(?:exceeded|exhausted)/i,
  /(?:exceeded|exhausted).*\bquota\b/i,
  /\bquota[-_ ]*(?:exceeded|exhausted)\b/i,
  /\b(?:exceeded|exhausted)[-_ ]*quota\b/i,
  /\binsufficient[- ]*credits?\b/i,
  /\bresource\s*exhausted\b/i,
  /\bupstream_throttled\b/i,
  /\bcredit[- ]?exhaustion\b/i,
];

export function isExplicitRateOrQuotaLimit(text, modelId = null) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (isRejectFirst(s) || isRefusalShaped(s) || isModelRefusal(s, modelId) || isStallOrTimeout(s)) return false;
  return RATE_LIMIT_PATTERNS.some(re => re.test(s));
}

// Limit-shaped text: mentions limit/quota/throttle/capacity/credits/429/busy
// May only turn into WARN if second signal confirms, but NEVER rescues an error from reject-first or refusal.
export function isLimitShaped(text, modelId = null) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (isRejectFirst(s) || isRefusalShaped(s) || isModelRefusal(s, modelId) || isStallOrTimeout(s)) return false;
  return /limit|quota|throttle|credits?|capacity|balance|busy|429/i.test(s);
}

// Check second signal: lmctl ratelimit <provider> --json
export function checkProviderRatelimitSignal(provider, { bin = process.env.LMCTL_BIN || 'lmctl', env = process.env } = {}) {
  if (!provider) return false;
  try {
    const res = spawnSync(bin, ['ratelimit', provider, '--json'], { env, encoding: 'utf8', timeout: 15000 });
    if (res.status !== 0 || !res.stdout) return false;
    const jsonStart = res.stdout.indexOf('{');
    if (jsonStart < 0) return false;
    const data = JSON.parse(res.stdout.slice(jsonStart));
    const readings = Array.isArray(data?.readings) ? data.readings : [];
    const r = readings.find(x => x.provider === provider);
    if (!r) return false;
    if (r.ordinary_usage_allowed === false) return true;
    if (r.credits && r.credits.has_credits === false) return true;
    if (r.spend_control && r.spend_control.reached === true) return true;
    if (Array.isArray(r.buckets)) {
      for (const b of r.buckets) {
        if (b.is_exhausted === true || b.limit_reached === true || b.allowed === false || b.remaining_fraction === 0) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function extractProviderMessage(text) {
  const raw = String(text || '').trim();
  try {
    const parsed = JSON.parse(raw);
    const m = parsed?.result ?? parsed?.error?.message ?? parsed?.error ?? parsed?.message;
    if (typeof m === 'string' && m.trim()) return m.trim().split('\n')[0].slice(0, 160);
  } catch {}
  const errMatch = /(?:Turn errored:|ERROR:)\s*([^\n]+)/.exec(raw);
  if (errMatch) return errMatch[1].trim().slice(0, 160);
  const line = raw.split('\n').find(l => l.trim().length > 0) || '';
  return line.slice(0, 160);
}

export function collectDecodedStrings(val, out = []) {
  if (typeof val === 'string') {
    out.push(val);
  } else if (Array.isArray(val)) {
    for (const item of val) collectDecodedStrings(item, out);
  } else if (val && typeof val === 'object') {
    for (const v of Object.values(val)) collectDecodedStrings(v, out);
  }
  return out;
}

export function extractJudgedTexts(text, err = '') {
  const raw = typeof text === 'string' ? text : String(text?.out ?? text ?? '');
  const rawErr = typeof text === 'object' && text?.err ? String(text.err) : String(err ?? '');
  const rawCombined = [raw, rawErr].filter(Boolean).join('\n');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try { parsed = JSON.parse(trimmed); break; } catch {}
      }
    }
  }
  const decodedStrings = parsed ? collectDecodedStrings(parsed) : [];
  const decodedCombined = [...decodedStrings, rawErr].filter(Boolean).join('\n');
  const texts = [rawCombined];
  if (decodedCombined && decodedCombined !== rawCombined) {
    texts.push(decodedCombined);
  }
  return { raw: rawCombined, decoded: decodedCombined, texts };
}

// Master classifier function
export function classifyProviderFailure(text, provider = null, options = {}) {
  const { raw, texts } = extractJudgedTexts(text);
  if (texts.some(s => isRejectFirst(s) || isStallOrTimeout(s))) {
    return {
      isRateLimit: false,
      class: 'error',
      message: extractProviderMessage(raw),
    };
  }
  if (texts.some(s => isRefusalShaped(s) || isModelRefusal(s, options.modelId))) {
    return {
      isRateLimit: false,
      class: 'error',
      message: extractProviderMessage(raw),
    };
  }
  if (texts.some(s => isExplicitRateOrQuotaLimit(s, options.modelId))) {
    const isQuota = texts.some(s => /out of usage credits|\bquota\b.*(?:exceeded|exhausted)|(?:exceeded|exhausted).*\bquota\b|\bquota[-_ ]*(?:exceeded|exhausted)\b|\b(?:exceeded|exhausted)[-_ ]*quota\b|usage[- ]?limit|insufficient[- ]*credits?|credit[- ]?exhaustion/i.test(s));
    return {
      isRateLimit: true,
      class: isQuota ? 'quota_exhausted' : 'upstream_throttled',
      message: extractProviderMessage(raw),
    };
  }
  if (provider && texts.some(s => isLimitShaped(s, options.modelId))) {
    if (checkProviderRatelimitSignal(provider, options)) {
      return {
        isRateLimit: true,
        class: 'upstream_throttled',
        message: extractProviderMessage(raw),
      };
    }
  }
  return {
    isRateLimit: false,
    class: 'error',
    message: extractProviderMessage(raw),
  };
}

// Adapter for models-validity.mjs INCONCLUSIVE_CLASSES
export function classifyTextForModelsValidity(text, modelId = null) {
  const { texts } = extractJudgedTexts(text);
  if (texts.some(s => isRejectFirst(s) || isStallOrTimeout(s) || isRefusalShaped(s) || isModelRefusal(s, modelId))) return null;
  for (const s of texts) {
    if (/out of usage credits|\bquota\b.*(?:exceeded|exhausted)|(?:exceeded|exhausted).*\bquota\b|\bquota[-_ ]*(?:exceeded|exhausted)\b|\b(?:exceeded|exhausted)[-_ ]*quota\b|usage[- ]?limit|insufficient[- ]*credits?|credit[- ]?exhaustion/i.test(s)) {
      return 'quota_exhausted';
    }
    if (/\b429\b|too many requests|\brate[- ]?limit(?:ed)?\b|\bupstream_throttled\b|\bresource\s*exhausted\b/i.test(s)) {
      return 'upstream_throttled';
    }
  }
  return null;
}
