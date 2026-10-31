#!/usr/bin/env node
// Resolves the live-tier provider/model configuration (live-config.json + command-line overrides).
//   node live-config.mjs env      [--overrides-b64 <b64>]   shell `export` lines for the suites
//   node live-config.mjs summary  [--overrides-b64 <b64>]   one human-readable line per provider
//   node live-config.mjs ids      [--tier live|smoke] [--overrides-b64 <b64>]   enabled provider ids, one per line
//   node live-config.mjs show <id> [--overrides-b64 <b64>]  key=value lines for one provider
// Overrides (JSON, base64): { "providers": "codex,lmplayer" | null, "models": { "agy": "Gemini 3.8 Flash (High)" } }
// LMCTL_LIVE_CONFIG points at another config file. Credentials are never read or printed here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.LMCTL_LIVE_CONFIG || join(here, 'live-config.json');

export function deriveCronModel(id, model) {
  if (id === 'codex') return model;
  if (id === 'agy') {
    if (/high/i.test(model)) return 'gemini-3.8-flash-high';
    if (/low/i.test(model)) return 'gemini-3.8-flash-low';
    if (/^[a-z0-9-]+$/.test(model)) return model;
    return 'gemini-3.8-flash-medium';
  }
  return null;
}

export function resolve(config, overrides = {}) {
  const known = Object.keys(config.providers);
  const requested = overrides.providers !== undefined && overrides.providers !== null
    ? String(overrides.providers).split(',').map(s => s.trim()).filter(Boolean)
    : null;
  for (const id of requested ?? []) if (!known.includes(id)) throw new Error(`unknown provider "${id}" (known: ${known.join(', ')})`);
  for (const id of Object.keys(overrides.models ?? {})) if (!known.includes(id)) throw new Error(`unknown provider "${id}" in --model (known: ${known.join(', ')})`);
  return known.map(id => {
    const c = config.providers[id];
    const overriddenModel = overrides.models?.[id];
    const model = overriddenModel ?? c.model;
    if (model === undefined || model === null) throw new Error(`provider "${id}" has no model (use "" for the provider default)`);
    return {
      id, model,
      enabled: requested ? requested.includes(id) : c.enabled !== false,
      modelOverridden: overriddenModel !== undefined,
      cronModel: overriddenModel !== undefined ? deriveCronModel(id, model) : (c.cron_model ?? deriveCronModel(id, model)),
      requiresBin: c.requires_bin ?? id,
      requiresEnv: c.requires_env ?? [],
      quotaCheck: c.quota_check ?? 'none',
      tiers: c.tiers ?? ['live', 'smoke'],
      multiTurn: c.multi_turn !== false,
      anonymous: c.anonymous === true,
      observedModel: c.observed_model ?? null,
      billing: c.billing ?? null,
    };
  });
}

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const bi = rest.indexOf('--overrides-b64');
  const overrides = bi >= 0 ? JSON.parse(Buffer.from(rest[bi + 1], 'base64').toString('utf8')) : {};
  const list = resolve(JSON.parse(readFileSync(configPath, 'utf8')), overrides);
  const enabled = list.filter(p => p.enabled);
  const ti = rest.indexOf('--tier');
  const tier = ti >= 0 ? rest[ti + 1] : null;
  if (cmd === 'env') {
    if (enabled.length === 0) throw new Error('no provider is enabled');
    // LMCTL_LIVE_PROVIDERS feeds the live suites; smoke-only providers (claude, qwen, dsh) are not in it.
    const out = [`export LMCTL_LIVE_PROVIDERS=${q(enabled.filter(p => p.tiers.includes('live')).map(p => p.id).join(','))}`];
    for (const p of list) out.push(`export LMCTL_LIVE_${p.id.toUpperCase()}_MODEL=${q(p.model)}`);
    for (const p of list) if (p.observedModel) out.push(`export LMCTL_LIVE_${p.id.toUpperCase()}_OBSERVED=${q(p.observedModel)}`);
    for (const p of list) if (p.billing) out.push(`export LMCTL_LIVE_${p.id.toUpperCase()}_BILLING=${q(p.billing)}`);
    for (const p of list) if (p.cronModel) out.push(`export LMCTL_CRON_${p.id.toUpperCase()}_MODEL=${q(p.cronModel)}`);
    console.log(out.join('\n'));
  } else if (cmd === 'summary') {
    for (const p of list) {
      console.log(`${p.id}: ${p.enabled ? 'ENABLED ' : 'disabled'} model=${p.model === '' ? '(provider default)' : JSON.stringify(p.model)} (${p.modelOverridden ? 'overridden' : 'config'})`
        + `${p.requiresEnv.length ? ' needs-env=' + p.requiresEnv.join(',') : ''} needs-bin=${p.requiresBin} tiers=${p.tiers.join('+')}${p.anonymous ? ' anonymous' : p.multiTurn ? '' : ' single-turn'}`
        + `${p.observedModel ? ` observed=${JSON.stringify(p.observedModel)}` : ''}${p.billing ? ` billing=${p.billing}` : ''}`);
    }
  } else if (cmd === 'ids') {
    console.log(enabled.filter(p => !tier || p.tiers.includes(tier)).map(p => p.id).join('\n'));
  } else if (cmd === 'show') {
    const p = list.find(x => x.id === rest[0]);
    if (!p) throw new Error(`unknown provider ${rest[0]}`);
    console.log([`id=${p.id}`, `enabled=${p.enabled ? 1 : 0}`, `model=${p.model}`, `bin=${p.requiresBin}`, `quota=${p.quotaCheck}`,
      ...p.requiresEnv.map(e => `env=${e}`)].join('\n'));
  } else {
    throw new Error('usage: live-config.mjs env|summary|ids|show <id> [--overrides-b64 <b64>]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) { console.error(`live-config: ${error.message}`); process.exit(2); }
}
