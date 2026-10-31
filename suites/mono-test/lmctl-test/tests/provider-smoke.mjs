// Provider smoke test: for every provider with the "smoke" tier in live-config.json, start a FRESH agent, seed it,
// ping it, then run a three-turn conversation that needs memory of earlier turns:
//     (a provider with model "" in live-config.json runs on its own default model)
//     turn 1: "The first number is 3."   turn 2: "The second number is 7."   turn 3: "What is the total?"  -> 10
// Standalone:   node tests/provider-smoke.mjs [--providers codex,qwen] [--tier smoke|periodic] [--model id=model]... [--list]
// In the gate:  runs as the step lmctl-test-provider-smoke of --live / --full (overrides arrive in
//               LMCTL_LIVE_OVERRIDES_B64). Spends real quota: three tiny turns per provider.
// A provider that is enabled but cannot run (binary missing, key not set, not logged in) FAILS; it is never skipped.
// Credentials are never printed. LMCTL_BIN selects the lmctl under test (default: lmctl on PATH).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from '../../live-config.mjs';
import { classifyProviderFailure, extractJudgedTexts } from './rate-limit-classifier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.env.LMCTL_BIN || 'lmctl';
const args = process.argv.slice(2);
let tier = process.env.LMCTL_SMOKE_TIER || 'smoke';

const overrides = process.env.LMCTL_LIVE_OVERRIDES_B64
  ? JSON.parse(Buffer.from(process.env.LMCTL_LIVE_OVERRIDES_B64, 'base64').toString('utf8')) : {};
overrides.models = { ...(overrides.models ?? {}) };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--providers') overrides.providers = args[++i];
  else if (args[i] === '--model') { const kv = args[++i]; const k = kv.indexOf('='); overrides.models[kv.slice(0, k)] = kv.slice(k + 1); }
  else if (args[i] === '--tier') tier = args[++i];
  else if (args[i] !== '--list') { console.error(`unknown argument ${args[i]}`); process.exit(2); }
}
const config = JSON.parse(readFileSync(process.env.LMCTL_LIVE_CONFIG || join(here, '..', '..', 'live-config.json'), 'utf8'));
let all;
try { all = resolve(config, overrides); } catch (error) { console.error(`provider-smoke: ${error.message}`); process.exit(2); }
// An explicit --providers selects regardless of tier (that is the standalone use); otherwise enabled smoke-tier ones.
const chosen = all.filter(p => p.enabled && (overrides.providers || p.tiers.includes(tier)));
if (args.includes('--list')) { for (const p of chosen) console.log(`${p.id}\t${p.model || '(default)'}`); process.exit(0); }
if (chosen.length === 0) { console.log(`SKIP provider smoke: no provider with the ${tier} tier is enabled`); console.log('0 providers: 0 pass, 0 fail'); process.exit(0); }

// Never let an outer agent's identity leak into the agents under test.
const env = { ...process.env, LMCTL_NON_INTERACTIVE: '1', LMCTL_NO_UPDATE_NOTIFIER: '1' };
for (const name of Object.keys(env)) if (/^(LMCTL_SELF_SESSIONID|LMCTL_INVOCATION_ID|LMCTL_LAUNCH_SOURCE|LMCTL_DB|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT)$/.test(name)) delete env[name];

const root = mkdtempSync(join(tmpdir(), 'lmctl-smoke-'));
let runNo = 0;
const run = (argv, cwd, timeout) => {
  const r = spawnSync(bin, argv, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '', err: (r.stderr || '') + (r.error ? ` [spawn error: ${r.error.code || r.error.message}]` : ''), signal: r.signal };
};
const tail = (s, n = 300) => String(s).replace(/\s+/g, ' ').trim().slice(-n);

const turnStalled = x => x.status === 'stalled' || extractJudgedTexts(x.error).texts.some(s => /stalled/i.test(s) || (!x.reply && /timeout|timed out/i.test(s)));
const formatTurn = x => {
  let s = x.status + ':' + (x.error || 'null');
  if (turnStalled(x)) s += ' (stalled before first token)';
  return s;
};

// Providers that cannot be seeded or resumed (miniplayer): fresh anonymous lm_agent calls, ping and a one-prompt sum.
function smokeAnonymous(p, dir, note, checks) {
  const spec = `{provider: ${JSON.stringify(p.id)}${p.model === '' ? '' : ', model: ' + JSON.stringify(p.model)}, sessiondir: ${JSON.stringify(dir)}}`;
  const ask = `q=["Reply with exactly: PONG","What is 3 plus 7? Reply with only the number, as digits."]; r=[]; i=0; ` +
    `while (i < len(q)) { x=lm_agent(${spec}, q[i], {idleTimeoutMs:240000}); push(r,{status:x.status,reply:trim(str(get(x,"reply",""))),error:str(get(x,"error",""))}); i=i+1; } println("SMOKE-JSON " + json_stringify(r));`;
  const t = run(['script', '-e', ask], dir, 900000);
  const line = (t.out.split('\n').find(l => l.startsWith('SMOKE-JSON ')) ?? '').slice('SMOKE-JSON '.length);
  let turns = null; try { turns = JSON.parse(line); } catch { /* reported below */ }
  const rep = i => String(turns?.[i]?.reply ?? '');

  let scriptDetail = `exit=${t.code} signal=${t.signal} ${tail(t.out + t.err)}`;
  if (t.signal || /timed? ?out/i.test(scriptDetail)) {
    scriptDetail += ' (stalled before first token)';
  }

  const promptsOk = Array.isArray(turns) && turns.length === 2 && turns.every(x => x.status === 'ok');
  const promptsDetail = turns ? turns.map(formatTurn).join(' | ') : scriptDetail;
  let promptsRateLimit = false, promptsMessage = '';
  if (!promptsOk) {
    if (Array.isArray(turns)) {
      if (turns.length === 2) {
        const failedTurns = turns.filter(x => x.status !== 'ok');
        if (failedTurns.length > 0 && failedTurns.every(x => !turnStalled(x))) {
          const cl = failedTurns.map(x => classifyProviderFailure(x.error, p.id, { bin, env }));
          if (cl.every(c => c.isRateLimit)) {
            promptsRateLimit = true;
            promptsMessage = cl[0].message;
          }
        }
      }
    } else {
      const cl = classifyProviderFailure(t.out + '\n' + t.err, p.id, { bin, env });
      if (cl.isRateLimit && !/stalled/i.test(scriptDetail)) {
        promptsRateLimit = true;
        promptsMessage = cl.message;
      }
    }
  }

  note('2 anonymous prompts completed (fresh agent each, no session)',
    promptsOk, promptsDetail, { attributableToRateLimit: promptsRateLimit, providerMessage: promptsMessage });

  let pingOk = /PONG/i.test(rep(0));
  let pingRateLimit = false;
  if (!pingOk) {
    if (turns && turns[0]) {
      if (turns[0].status !== 'ok') {
        const cl = classifyProviderFailure(turns[0].error, p.id, { bin, env });
        if (cl.isRateLimit) {
          pingRateLimit = true;
          if (!promptsMessage) promptsMessage = cl.message;
        }
      }
    } else if (!turns && promptsRateLimit) {
      pingRateLimit = true;
    }
  }
  note('ping answers PONG', pingOk, JSON.stringify(rep(0).slice(0, 80)),
    { attributableToRateLimit: pingRateLimit, providerMessage: promptsMessage });

  let sumOk = /(^|\D)10(\D|$)/.test(rep(1));
  let sumRateLimit = false;
  if (!sumOk) {
    if (turns && turns.length === 2) {
      if (turns[1]?.status !== 'ok') {
        const cl = classifyProviderFailure(turns[1].error, p.id, { bin, env });
        if (cl.isRateLimit) {
          sumRateLimit = true;
          if (!promptsMessage) promptsMessage = cl.message;
        }
      }
    } else if (!turns && promptsRateLimit) {
      sumRateLimit = true;
    }
  }
  note('one-prompt sum: 3 + 7 = 10', sumOk, JSON.stringify(rep(1).slice(0, 120)),
    { attributableToRateLimit: sumRateLimit, providerMessage: promptsMessage });

  return checks;
}

function smoke(p) {
  if (process.env.LMCTL_SMOKE_INJECT_CRASH === p.id) throw new Error('injected crash (used by provider-smoke-resilience.test.mjs)');
  const checks = [];
  const note = (name, ok, detail = '', extra = {}) => {
    checks.push({ name, ok, detail, ...extra });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${p.id}: ${name}${ok ? '' : ' -- ' + detail}`);
    return ok;
  };
  console.log(`\n== ${p.id} model=${p.model === '' ? '(provider default)' : JSON.stringify(p.model)}`);
  if (spawnSync('which', [p.requiresBin]).status !== 0) {
    note(`binary ${p.requiresBin} on PATH`, false, `not found in PATH`, { attributableToRateLimit: false });
    return checks;
  }
  const missing = p.requiresEnv.filter(e => !process.env[e]);
  if (!note('required environment present (values never shown)', missing.length === 0, `not set: ${missing.join(', ')}`, { attributableToRateLimit: false })) return checks;

  const dir = join(root, `${p.id}-${++runNo}`); mkdirSync(dir);        // a fresh directory per attempt (a retry must not collide with the first)
  if (p.anonymous) return smokeAnonymous(p, dir, note, checks);
  const team = join(dir, 'team.lmctl');
  writeFileSync(team, `_TEAM_ name=smoke-${p.id}\n_MEMBER_ alias=Smoke provider=${p.id}${p.model === '' ? '' : ' model=' + JSON.stringify(p.model)}\n`);
  const seed = run(['--non-interactive', 'seed', team], dir, 300000);
  const sid = /sessionid=(\S+)/.exec(readFileSync(team, 'utf8'))?.[1];
  const seedOk = seed.code === 0 && !!sid;
  const seedErr = tail(seed.out + seed.err);
  const seedClassification = !seedOk ? classifyProviderFailure(seed.out + '\n' + seed.err, p.id, { bin, env }) : { isRateLimit: false };
  if (!note('seed starts a fresh session', seedOk, seedErr, {
    attributableToRateLimit: seedClassification.isRateLimit,
    providerMessage: seedClassification.message,
  })) return checks;

  // Multi-turn providers must remember the first two numbers across turns. A provider without resume/compact
  // (multi_turn: false in live-config.json, e.g. miniplayer) gets the same arithmetic in ONE prompt instead.
  const questions = p.multiTurn
    ? ['Reply with exactly: PONG', 'The first number is 3. Reply with only: OK', 'The second number is 7. Reply with only: OK', 'What is the total of the two numbers I gave you? Reply with only the number, as digits.']
    : ['Reply with exactly: PONG', 'What is 3 plus 7? Reply with only the number, as digits.'];
  const ask = `r=[]; q=${JSON.stringify(questions)}; ` +
    `i=0; while (i < len(q)) { x=lm_prompt(${JSON.stringify(team)},"Smoke",q[i],{idleTimeoutMs:240000}); push(r,{status:x.status,reply:trim(str(get(x,"reply",""))),error:str(get(x,"error",""))}); i=i+1; } println("SMOKE-JSON " + json_stringify(r));`;
  const t = run(['script', '-e', ask], dir, 900000);
  const line = (t.out.split('\n').find(l => l.startsWith('SMOKE-JSON ')) ?? '').slice('SMOKE-JSON '.length);
  let turns = null; try { turns = JSON.parse(line); } catch { /* reported below */ }
  const n = questions.length;
  const rep = i => String(turns?.[i]?.reply ?? '');

  let scriptDetail = tail(t.out + t.err);
  if (t.signal || /timed? ?out/i.test(scriptDetail)) {
    scriptDetail += ' (stalled before first token)';
  }

  const turnsOk = Array.isArray(turns) && turns.length === n && turns.every(x => x.status === 'ok');
  const turnsDetail = turns ? turns.map(formatTurn).join(' | ') : scriptDetail;
  let turnsRateLimit = false, turnsMessage = '';

  if (!turnsOk) {
    if (Array.isArray(turns)) {
      if (turns.length === n) {
        const failedTurns = turns.filter(x => x.status !== 'ok');
        if (failedTurns.length > 0 && failedTurns.every(x => !turnStalled(x))) {
          const cl = failedTurns.map(x => classifyProviderFailure(x.error, p.id, { bin, env }));
          if (cl.every(c => c.isRateLimit)) {
            turnsRateLimit = true;
            turnsMessage = cl[0].message;
          }
        }
      }
    } else {
      const cl = classifyProviderFailure(t.out + '\n' + t.err, p.id, { bin, env });
      if (cl.isRateLimit && !/stalled/i.test(scriptDetail)) {
        turnsRateLimit = true;
        turnsMessage = cl.message;
      }
    }
  }

  // every check below runs even when an earlier one failed (a stalled first turn must not hide the memory result of the later turns)
  note(`${n} turns completed${p.multiTurn ? ' on one session' : ' (single-turn provider)'}`,
    turnsOk, turnsDetail, { attributableToRateLimit: turnsRateLimit, providerMessage: turnsMessage });

  let pingOk = /PONG/i.test(rep(0));
  let pingRateLimit = false;
  if (!pingOk) {
    if (turns && turns[0]) {
      if (turns[0].status !== 'ok') {
        const cl = classifyProviderFailure(turns[0].error, p.id, { bin, env });
        if (cl.isRateLimit) {
          pingRateLimit = true;
          if (!turnsMessage) turnsMessage = cl.message;
        }
      }
    } else if (!turns && turnsRateLimit) {
      pingRateLimit = true;
    }
  }
  note('ping answers PONG', pingOk, JSON.stringify(rep(0).slice(0, 80)),
    { attributableToRateLimit: pingRateLimit, providerMessage: turnsMessage });

  if (p.multiTurn) {
    let ackOk = rep(1).length > 0 && rep(2).length > 0;
    let ackRateLimit = false;
    if (!ackOk) {
      if (turns && turns.length === n) {
        const t1Attributable = rep(1).length > 0 || (turns[1]?.status !== 'ok' && classifyProviderFailure(turns[1]?.error, p.id, { bin, env }).isRateLimit);
        const t2Attributable = rep(2).length > 0 || (turns[2]?.status !== 'ok' && classifyProviderFailure(turns[2]?.error, p.id, { bin, env }).isRateLimit);
        if (t1Attributable && t2Attributable) {
          ackRateLimit = true;
        }
      } else if (!turns && turnsRateLimit) {
        ackRateLimit = true;
      }
    }
    note('turn 2 and 3 acknowledged', ackOk, JSON.stringify([rep(1), rep(2)]),
      { attributableToRateLimit: ackRateLimit, providerMessage: turnsMessage });
  }

  let memoryOk = /(^|\D)10(\D|$)/.test(rep(n - 1));
  let memoryRateLimit = false;
  if (!memoryOk) {
    if (turns && turns.length === n) {
      if (turns[n - 1]?.status !== 'ok') {
        const cl = classifyProviderFailure(turns[n - 1].error, p.id, { bin, env });
        if (cl.isRateLimit) {
          memoryRateLimit = true;
          if (!turnsMessage) turnsMessage = cl.message;
        }
      }
    } else if (!turns && turnsRateLimit) {
      memoryRateLimit = true;
    }
  }
  note(p.multiTurn ? 'multi-turn memory: 3 + 7 = 10' : 'one-prompt sum: 3 + 7 = 10',
    memoryOk, JSON.stringify(rep(n - 1).slice(0, 120)),
    { attributableToRateLimit: memoryRateLimit, providerMessage: turnsMessage });

  return checks;
}

const results = {};
try {
  console.log(`Provider smoke: ${chosen.map(p => p.id).join(', ')}  (fresh agent each; lmctl=${bin})`);
  const retries = Number(process.env.LMCTL_SMOKE_RETRIES || 0);
  // One provider crashing (a thrown error) must not stop the others: the crash is recorded as a failed check and the run goes on.
  const attemptSmoke = p => {
    try {
      return smoke(p);
    } catch (error) {
      console.log(`  FAIL  ${p.id}: unexpected error -- ${error.stack?.split('\n').slice(0, 3).join(' | ')}`);
      return [{ name: 'unexpected error', ok: false, detail: String(error), attributableToRateLimit: false }];
    }
  };
  for (const p of chosen) {
    let checks = attemptSmoke(p), retried = 0, firstFailure = checks.filter(x => !x.ok).map(x => x.name).join('; ');
    while (retried < retries && checks.some(x => !x.ok)) {
      retried++;
      console.log(`  RETRY ${p.id}: attempt ${retried} of ${retries} after a failure (fresh agent)`);
      checks = attemptSmoke(p);
    }
    results[p.id] = checks; results[p.id].retried = retried; results[p.id].firstFailure = firstFailure;
  }
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort: only throwaway teamfiles and session dirs */ }
}

const passed = [];
const warned = [];
const failed = [];
const warnMessages = {};

for (const [id, c] of Object.entries(results)) {
  const failedChecks = c.filter(x => !x.ok);
  if (failedChecks.length === 0) {
    passed.push(id);
  } else if (failedChecks.every(x => x.attributableToRateLimit)) {
    warned.push(id);
    const msg = failedChecks.find(x => x.providerMessage)?.providerMessage || 'rate limit / quota exceeded';
    warnMessages[id] = msg;
  } else {
    failed.push(id);
  }
}

console.log('\nProvider   Result');
for (const [id, c] of Object.entries(results)) {
  const isPass = passed.includes(id);
  const isWarn = warned.includes(id);
  const statusStr = isPass ? 'PASS' : (isWarn ? 'WARN' : 'FAIL');
  const checkCount = `(${c.filter(x => x.ok).length}/${c.length} checks)`;
  const flakyNote = isPass && c.retried ? `  FLAKY: passed on retry ${c.retried}; first attempt failed: ${c.firstFailure}` : '';
  const warnNote = isWarn ? `  ${warnMessages[id]}` : '';
  console.log(`${id.padEnd(10)} ${statusStr.padEnd(6)} ${checkCount}${flakyNote}${warnNote}`);
}

const failedPart = failed.length ? ` (${failed.join(', ')})` : '';
const warnPart = warned.length ? ` [warn: ${warned.map(id => `${id}: ${warnMessages[id]}`).join('; ')}]` : '';
console.log(`${chosen.length} providers: ${passed.length} pass, ${warned.length} warn, ${failed.length} fail${failedPart}${warnPart}`);
process.exit(failed.length ? 1 : 0);
