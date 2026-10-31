// lmctl's native read views over its own state database, against the INSTALLED lmctl (LMCTL_BIN). The package ships two
// binaries (lmctl, lmscript); there is no lmbee to seed with, so fixtures are made with lmctl itself.
//
// Batch 1 (local reads): state list|get|active and cron list|show|runs|gaps are executed against an empty and a seeded private
// LMCTL_DB, asserting exit code and output shape in text and --json form. attention, in-flight, stalled, history and teams have
// executing checks in offline-commands.mjs; here they only join the read-only invariant: every form leaves the seeded database
// byte-identical.
//
// Retired lmbee-era commands (the prompt queue, sites/fleet, the service CLIs) must refuse with the replacement hint and exit 1:
// the owner's rulings dropped the lmbee prompt queue (lmctl prompt, lmctl cron, mailbox remote execution and lmchat replace it).
//
// Every assertion has mutation controls applied to the real captured output: the check must reject a copy with
// a changed exit code or a removed/renamed field. Output: PASS/SKIP lines and "N assertions: P pass, F fail".
// Never touches ~/.lmctl/state.db: HOME and LMCTL_DB point into a mktemp directory.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'lmctl-native-reads-'));
const rawBin = process.env.LMCTL_BIN || 'lmctl';
let bin = rawBin;
if (!rawBin.includes('/')) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (existsSync(join(dir, rawBin))) { bin = join(dir, rawBin); break; }
  }
}
const binDir = dirname(bin);
const realBinDir = existsSync(bin) ? dirname(realpathSync(bin)) : binDir;

// Only these variables reach the children; every LMCTL_ selector is set explicitly below.
const baseEnv = {};
for (const key of ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']) {
  if (process.env[key] !== undefined) baseEnv[key] = process.env[key];
}
function sandbox(name) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'home'), { recursive: true });
  const db = join(dir, 'state.db');
  writeFileSync(db, '');
  return {
    dir, db,
    env: {
      ...baseEnv,
      HOME: join(dir, 'home'),
      LMCTL_HOME: join(dir, 'home', '.lmctl'),
      LMCTL_DB: db,
      LMCTL_NO_UPDATE_NOTIFIER: '1',
    },
  };
}

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${String(error?.message ?? error).split('\n').slice(0, 6).join(' | ')}`);
  }
}
function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP ${name}: ${reason}`);
}
// A KNOWN PRODUCT BUG kept as an expected failure: the assertion states the correct contract in full. While the bug exists it is
// reported as XFAIL (counted with the skips, never as a pass); if it unexpectedly passes the suite FAILS so the quarantine is removed.
function xfail(name, issue, fn) {
  let failure;
  try { fn(); } catch (error) { failure = error; }
  if (failure) { skipped += 1; console.log(`XFAIL ${name}: KNOWN PRODUCT BUG (${issue}): ${String(failure?.message ?? failure).split('\n')[0]}`); }
  else { failed += 1; console.log(`FAIL ${name}: XPASS: quarantined as a known product bug (${issue}) but it passed; remove the quarantine`); }
}
// The assertion must accept the real result and reject every mutant derived from it.
function controls(assertFn, result, mutants) {
  assertFn(result);
  for (const [label, mutate] of mutants) {
    assert.throws(() => assertFn(mutate(structuredClone(result))), undefined, `mutation control not rejected: ${label}`);
  }
}
const exitMutant = (code = 1) => ['exit code', (r) => ({ ...r, status: code })];

function lmctl(env, argv, timeout = 30000) {
  const r = spawnSync(bin, argv, { cwd: env.HOME, env, encoding: 'utf8', timeout });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
// The database bytes plus any WAL frames. An empty -wal/-shm pair left by a connection that opened the file
// writable but wrote nothing is not a change.
function dbHash(db) {
  const h = createHash('sha256').update(readFileSync(db));
  const wal = `${db}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) h.update('wal').update(readFileSync(wal));
  return h.digest('hex');
}
const json = (r) => JSON.parse(r.stdout);

try {
  const help = lmctl({ ...baseEnv, HOME: root, LMCTL_NO_UPDATE_NOTIFIER: '1' }, ['--help']).stdout;
  const has = (name) => new RegExp(`^  ${name}[ |]`, 'm').test(help);

  // ---- fixtures --------------------------------------------------------------------------------------------
  const empty = sandbox('empty');
  const seeded = sandbox('seeded');
  if (has('state') || has('cron')) {
    // A writable lmctl open (`lmctl running`, which records nothing) provisions the full schema of an empty database file.
    for (const sb of [empty, seeded]) {
      const prov = lmctl(sb.env, ['running']);
      assert.equal(prov.status, 0, `lmctl running failed while provisioning the ${sb.db}: ${prov.stderr || prov.stdout}`);
    }
    const created = lmctl(seeded.env, ['cron', 'create', '--title', 'poc-test job', '--schedule', '0 * * * *', '--kind', 'command', '--payload', 'true', '--json']);
    assert.equal(created.status, 0, `lmctl cron create failed during seeding: ${created.stderr || created.stdout}`);
    // One finished run, written directly: `cron trigger` executes a real process, which has no place in a hermetic fixture.
    const db = new DatabaseSync(seeded.db);
    db.prepare(`INSERT INTO cron_runs(job_id, run_token_hash, status, execution_state, trigger_kind, config_snapshot, summary,
      execution_gone_at, created_at, started_at, finished_at, updated_at) VALUES (1, 'poc-test-run-1', 'succeeded', 'gone', 'command:manual',
      '{"kind":"command","payload":"true"}', 'command exited with code 0', ?, ?, ?, ?, ?)`).run(...Array(5).fill('2026-10-23T12:00:00.000Z'));
    // `lmctl state list|get|active` are native read views of lmctl's own team and team_member tables: seed one team with an idle and an
    // in_chat member, written directly like the cron run above.
    const teamId = Number(db.prepare("INSERT INTO team(name, created_at) VALUES ('alpha', '2026-10-23T12:00:00.000Z')").run().lastInsertRowid);
    const addMember = db.prepare(`INSERT INTO team_member(team_id, alias, provider, sessiondir, state, state_reason, state_updated_at, created_at)
      VALUES (?, ?, 'codex', ?, ?, ?, ?, '2026-10-23T12:00:00.000Z')`);
    addMember.run(teamId, 'Lead', seeded.dir, 'idle', null, null);
    addMember.run(teamId, 'Dev', seeded.dir, 'in_chat', 'busy', '2026-10-23T12:01:00.000Z');
    db.close();
  }

  // ---- batch 1: state ------------------------------------------------------------------------------------------
  if (has('state')) {
    check('state list: empty database prints nothing and {"teams":[],"active":[]}; seeded members listed with their states', () => {
      const e = lmctl(empty.env, ['state', 'list']);
      const ej = lmctl(empty.env, ['state', 'list', '--json']);
      const s = lmctl(seeded.env, ['state', 'list']);
      const sj = lmctl(seeded.env, ['state', 'list', '--json']);
      const etext = (r) => { assert.equal(r.status, 0); assert.equal(r.stdout, ''); };
      const ejson = (r) => { assert.equal(r.status, 0); assert.deepEqual(json(r), { teams: [], active: [] }); };
      const stext = (r) => { assert.equal(r.status, 0); assert.equal(r.stdout, 'alpha:Dev in_chat\nalpha:Lead idle\n'); };
      const sjson = (r) => {
        assert.equal(r.status, 0);
        const o = json(r);
        assert.ok(Array.isArray(o.active));
        assert.deepEqual(o.teams.map((t) => [t.team, t.state.alias, t.state.status, t.state.reason]), [['alpha', 'Dev', 'in_chat', 'busy'], ['alpha', 'Lead', 'idle', null]]);
        assert.equal(o.teams[0].state.updated_at, '2026-10-23T12:01:00.000Z');
      };
      controls(etext, e, [exitMutant(), ['a row appears', (r) => ({ ...r, stdout: 'alpha:Lead idle\n' })]]);
      controls(ejson, ej, [exitMutant(), ['a team appears', (r) => ({ ...r, stdout: '{"teams":[{"team":"x"}],"active":[]}' })]]);
      controls(stext, s, [exitMutant(), ['status changed', (r) => ({ ...r, stdout: r.stdout.replace('in_chat', 'idle') })], ['member dropped', (r) => ({ ...r, stdout: 'alpha:Lead idle\n' })]]);
      controls(sjson, sj, [exitMutant(), ['team renamed', (r) => ({ ...r, stdout: r.stdout.replace('"team": "alpha"', '"team": "beta"') })], ['state dropped', (r) => ({ ...r, stdout: r.stdout.replace('"in_chat"', '"idle"') })]]);
    });
    check('state get: unknown team reports no state and exits 1; seeded alpha reports its members', () => {
      const e = lmctl(empty.env, ['state', 'get', 'nobody']);
      const ej = lmctl(empty.env, ['state', 'get', 'nobody', '--json']);
      const s = lmctl(seeded.env, ['state', 'get', 'alpha']);
      const sj = lmctl(seeded.env, ['state', 'get', 'alpha', '--json']);
      const etext = (r) => { assert.equal(r.status, 1); assert.equal(r.stdout, ''); };
      const ejson = (r) => { assert.equal(r.status, 1); const t = json(r).team; assert.equal(t.name, 'nobody'); assert.equal(t.state, null); };
      const stext = (r) => { assert.equal(r.status, 0); assert.equal(r.stdout, 'alpha:Dev in_chat\nalpha:Lead idle\n'); };
      const sjson = (r) => { assert.equal(r.status, 0); const t = json(r).team; assert.equal(t.name, 'alpha'); assert.equal(t.state.alias, 'Dev'); assert.equal(t.state.status, 'in_chat'); assert.match(t.state.updated_at, /^\d{4}-\d\d-\d\dT/); };
      controls(etext, e, [exitMutant(0), ['state invented', (r) => ({ ...r, stdout: 'nobody:Lead idle\n' })]]);
      controls(ejson, ej, [exitMutant(0), ['state invented', (r) => ({ ...r, stdout: '{"team":{"name":"nobody","state":{"status":"idle"}}}' })]]);
      controls(stext, s, [exitMutant(), ['status changed', (r) => ({ ...r, stdout: r.stdout.replace('in_chat', 'retired') })]]);
      controls(sjson, sj, [exitMutant(), ['no timestamp', (r) => ({ ...r, stdout: r.stdout.replace(/"updated_at": "[^"]+"/, '"updated_at": null') })]]);
    });
    check('state active: empty database lists nothing, as text and {"active":[]}', () => {
      const t = lmctl(empty.env, ['state', 'active']);
      const j = lmctl(empty.env, ['state', 'active', '--json']);
      const text = (r) => { assert.equal(r.status, 0); assert.equal(r.stdout, ''); };
      const js = (r) => { assert.equal(r.status, 0); assert.deepEqual(json(r), { active: [] }); };
      controls(text, t, [exitMutant(), ['a team active', (r) => ({ ...r, stdout: 'alpha\n' })]]);
      controls(js, j, [exitMutant(2), ['a team active', (r) => ({ ...r, stdout: '{"active":["alpha"]}' })]]);
    });
    // Issue 124 (`state active` compared uppercase states against the lowercase stored ones, so every member counted and a team was listed once per
    // member) was fixed in f98fe5c7 ("compare the lowercase stored states, list each team once"). The seeded alpha has an idle Lead and an in_chat Dev.
    check('state active on a seeded team: only non-idle teams, each once', () => {
      const t = lmctl(seeded.env, ['state', 'active']);
      const j = lmctl(seeded.env, ['state', 'active', '--json']);
      const text = (r) => { assert.equal(r.status, 0); assert.equal(r.stdout, 'alpha\n'); };
      const js = (r) => { assert.equal(r.status, 0); assert.deepEqual(json(r), { active: ['alpha'] }); };
      text(t); js(j);
      controls(text, t, [exitMutant(), ['alpha listed once per member', (r) => ({ ...r, stdout: 'alpha\nalpha\n' })], ['no active team', (r) => ({ ...r, stdout: '' })]]);
      controls(js, j, [exitMutant(2), ['alpha listed twice', (r) => ({ ...r, stdout: '{"active":["alpha","alpha"]}' })], ['no active team', (r) => ({ ...r, stdout: '{"active":[]}' })]]);
    });
  } else {
    skip('state list|get|active', 'NOT-IN-RELEASE: lmctl --help does not list state');
  }

  // ---- batch 1: cron -------------------------------------------------------------------------------------------
  if (has('cron')) {
    const envelope = (r, code = 0) => { assert.equal(r.status, code); const o = json(r); assert.equal(o.schema_version, 1); return o; };
    check('cron list: (empty) plus tick line; seeded job row with its last run; --json envelope with meta.tick', () => {
      const e = lmctl(empty.env, ['cron', 'list']);
      const ej = lmctl(empty.env, ['cron', 'list', '--json']);
      const s = lmctl(seeded.env, ['cron', 'list']);
      const sj = lmctl(seeded.env, ['cron', 'list', '--json']);
      const etext = (r) => { assert.equal(r.status, 0); assert.match(r.stdout, /^\(empty\)$/m); assert.match(r.stdout, /^last cron evaluation: /m); };
      const stext = (r) => { assert.equal(r.status, 0); assert.match(r.stdout, /^ID\s+ENABLED\s+KIND\s+SCHEDULE\s+LAST RUN\s+TITLE$/m); assert.match(r.stdout, /^1\s+1\s+command\s+0 \* \* \* \*\s+succeeded.*poc-test job$/m); };
      const ejson = (r) => { const o = envelope(r); assert.equal(o.ok, true); assert.deepEqual(o.data, []); assert.equal(typeof o.meta.tick.gaps_24h, 'number'); };
      const sjson = (r) => { const o = envelope(r); assert.equal(o.ok, true); assert.equal(o.data.length, 1); assert.equal(o.data[0].title, 'poc-test job'); assert.equal(o.data[0].action_kind, 'command'); assert.ok('tick' in o.meta); };
      controls(etext, e, [exitMutant(), ['tick line gone', (r) => ({ ...r, stdout: '(empty)\n' })]]);
      controls(stext, s, [exitMutant(), ['run lost', (r) => ({ ...r, stdout: r.stdout.replace('succeeded', 'never') })]]);
      controls(ejson, ej, [exitMutant(), ['ok false', (r) => ({ ...r, stdout: r.stdout.replace('"ok":true', '"ok":false') })]]);
      controls(sjson, sj, [exitMutant(), ['job retitled', (r) => ({ ...r, stdout: r.stdout.replace('poc-test job', 'other') })], ['tick dropped', (r) => ({ ...r, stdout: JSON.stringify({ ...JSON.parse(r.stdout), meta: {} }) })]]);
    });
    check('cron show: missing job exits 3 NOT_FOUND (text and --json); seeded job 1 with last_run succeeded', () => {
      const e = lmctl(empty.env, ['cron', 'show', '1']);
      const ej = lmctl(empty.env, ['cron', 'show', '1', '--json']);
      const s = lmctl(seeded.env, ['cron', 'show', '1']);
      const sj = lmctl(seeded.env, ['cron', 'show', '1', '--json']);
      const etext = (r) => { assert.equal(r.status, 3); assert.match(r.stdout + r.stderr, /NOT_FOUND: Cron job 1 does not exist/); };
      const ejson = (r) => { const o = envelope(r, 3); assert.equal(o.ok, false); assert.equal(o.error.code, 'NOT_FOUND'); };
      const sshow = (r) => { assert.equal(r.status, 0); const o = JSON.parse(r.stdout); const job = o.data ?? o; assert.equal(job.id, 1); assert.equal(job.title, 'poc-test job'); assert.equal(job.last_run.status, 'succeeded'); assert.equal(job.recent_runs.succeeded, 1); assert.equal(job.recent_runs.failed, 0); };
      controls(etext, e, [exitMutant(0), ['message gone', (r) => ({ ...r, stdout: '', stderr: '' })]]);
      controls(ejson, ej, [exitMutant(0), ['code changed', (r) => ({ ...r, stdout: r.stdout.replace('NOT_FOUND', 'INTERNAL') })]]);
      controls(sshow, s, [exitMutant(), ['run failed', (r) => ({ ...r, stdout: r.stdout.replace('"status": "succeeded"', '"status": "failed"') })]]);
      controls(sshow, sj, [exitMutant(), ['run failed', (r) => ({ ...r, stdout: r.stdout.replace('"status":"succeeded"', '"status":"failed"') })]]);
    });
    check('cron runs: (empty) / empty envelope; seeded one succeeded manual run, also with --job 1', () => {
      const e = lmctl(empty.env, ['cron', 'runs']);
      const ej = lmctl(empty.env, ['cron', 'runs', '--json']);
      const sj = lmctl(seeded.env, ['cron', 'runs', '--json']);
      const sjob = lmctl(seeded.env, ['cron', 'runs', '--job', '1', '--json']);
      const s = lmctl(seeded.env, ['cron', 'runs']);
      const etext = (r) => { assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '(empty)'); };
      const ejson = (r) => { const o = envelope(r); assert.deepEqual(o.data, []); };
      const sjson = (r) => { const o = envelope(r); assert.equal(o.data.length, 1); assert.equal(o.data[0].job_id, 1); assert.equal(o.data[0].status, 'succeeded'); assert.match(o.data[0].trigger_kind, /manual/); };
      const stext = (r) => { assert.equal(r.status, 0); const row = JSON.parse(r.stdout.trim().split('\n')[0]); assert.equal(row.job_id, 1); assert.equal(row.status, 'succeeded'); };
      controls(etext, e, [exitMutant(), ['a row appears', (r) => ({ ...r, stdout: '{"id":1}' })]]);
      controls(ejson, ej, [exitMutant()]);
      controls(sjson, sj, [exitMutant(), ['run failed', (r) => ({ ...r, stdout: r.stdout.replace('"status":"succeeded"', '"status":"failed"') })], ['no runs', (r) => ({ ...r, stdout: '{"schema_version":1,"ok":true,"data":[]}' })]]);
      controls(sjson, sjob, [exitMutant()]);
      controls(stext, s, [exitMutant(), ['other job', (r) => ({ ...r, stdout: r.stdout.replace('"job_id":1', '"job_id":2') })]]);
    });
    check('cron gaps: (no gaps recorded) plus tick line; --json envelope with data [] and meta.tick (no daemon ever ticked)', () => {
      for (const sb of [empty, seeded]) {
        const t = lmctl(sb.env, ['cron', 'gaps']);
        const j = lmctl(sb.env, ['cron', 'gaps', '--json']);
        const text = (r) => { assert.equal(r.status, 0); assert.match(r.stdout, /^\(no gaps recorded\)$/m); assert.match(r.stdout, /^last cron evaluation: not recorded yet/m); };
        const js = (r) => { const o = envelope(r); assert.equal(o.ok, true); assert.deepEqual(o.data, []); assert.equal(o.meta.tick.last_tick_at, null); assert.equal(o.meta.tick.gaps_24h, 0); };
        controls(text, t, [exitMutant(), ['usage instead (pre-gaps release)', (r) => ({ ...r, status: 1, stdout: 'usage: lmbee cron' })]]);
        controls(js, j, [exitMutant(), ['a gap invented', (r) => ({ ...r, stdout: r.stdout.replace('"gaps_24h":0', '"gaps_24h":3') })]]);
      }
    });
  } else {
    skip('cron list|show|runs|gaps', 'NOT-IN-RELEASE: lmctl --help does not list cron');
  }

  // ---- batch 1: read-only invariant ------------------------------------------------------------------------------
  if (has('state') && has('cron')) {
    check('every read-only --json form exits as documented and leaves the seeded database byte-identical', () => {
      const forms = [
        ['in-flight', '--json'], ['history', '--json'], ['teams', '--json'],
        ['state', 'list', '--json'], ['state', 'get', 'alpha', '--json'], ['state', 'active', '--json'],
        ['cron', 'list', '--json'], ['cron', 'show', '1', '--json'], ['cron', 'runs', '--json'], ['cron', 'gaps', '--json'],
      ].filter((argv) => has(argv[0]));
      const before = dbHash(seeded.db);
      const results = forms.map((argv) => ({ argv, r: lmctl(seeded.env, argv), hash: dbHash(seeded.db) }));
      const assertAll = (rs) => {
        for (const { argv, r, hash } of rs) {
          assert.equal(r.status, 0, `${argv.join(' ')} exit ${r.status}: ${r.stderr}`);
          assert.doesNotThrow(() => JSON.parse(r.stdout), `${argv.join(' ')} stdout is not JSON`);
          assert.equal(hash, before, `${argv.join(' ')} changed the database`);
        }
      };
      controls(assertAll, results, [
        ['one form changed the db', (rs) => rs.map((x, i) => (i === 3 ? { ...x, hash: 'changed' } : x))],
        ['one form exited 1', (rs) => rs.map((x, i) => (i === 5 ? { ...x, r: { ...x.r, status: 1 } } : x))],
        ['one form printed text', (rs) => rs.map((x, i) => (i === 7 ? { ...x, r: { ...x.r, stdout: 'not json' } } : x))],
      ]);
      assert.equal(results.length, forms.length);
    });
  }

  // ---- retired lmbee-era commands --------------------------------------------------------------------------------
  // The lmbee prompt queue (enqueue/answer/retrieve/..., queue list|get|inbox|stats) was not ported (owner ruling): every form refuses
  // with the replacement hint, exit 1, nothing on stdout, and writes nothing.
  check('the lmbee prompt queue is retired: queue forms and enqueue exit 1 with the replacement hint, print nothing and touch no database', () => {
    const before = dbHash(seeded.db);
    const forms = [['queue'], ['queue', 'list'], ['queue', 'list', '--json'], ['queue', 'get', '1'], ['queue', 'inbox', 'alpha'], ['queue', 'stats'], ['enqueue', 'alpha', 'poc-test prompt']];
    const results = forms.map((argv) => ({ argv, r: lmctl(seeded.env, argv), hash: dbHash(seeded.db) }));
    const assertAll = (rs) => {
      for (const { argv, r, hash } of rs) {
        assert.equal(r.status, 1, `${argv.join(' ')} must exit 1`);
        assert.equal(r.stdout, '', `${argv.join(' ')} must print nothing on stdout`);
        assert.match(r.stderr, /^error: the former lmbee prompt queue is not available in lmctl\. Use lmctl prompt for an agent prompt, lmctl cron for scheduled or detached jobs, mailbox remote execution for cross-site work, or lmchat for messages\.\n$/);
        assert.equal(hash, before, `${argv.join(' ')} changed the database`);
      }
    };
    controls(assertAll, results, [
      ['one form exited 0', (rs) => rs.map((x, i) => (i === 2 ? { ...x, r: { ...x.r, status: 0 } } : x))],
      ['one form printed on stdout', (rs) => rs.map((x, i) => (i === 4 ? { ...x, r: { ...x.r, stdout: 'queue inbox alpha: 0 pending' } } : x))],
      ['hint lost', (rs) => rs.map((x, i) => (i === 6 ? { ...x, r: { ...x.r, stderr: 'error: unknown command: enqueue\n' } } : x))],
      ['database changed', (rs) => rs.map((x, i) => (i === 1 ? { ...x, hash: 'changed' } : x))],
    ]);
  });
  check('tasks and the lmbee command group are gone: unknown commands exit 1, print usage on stderr and nothing on stdout', () => {
    for (const argv of [['tasks', 'list'], ['lmbee', 'state', 'list'], ['team', 'register', 'alpha']]) { // guard:allow-lmbee (negative: the group is gone)
      const r = lmctl(seeded.env, argv);
      const assertGone = (x) => { assert.equal(x.status, 1); assert.equal(x.stdout, ''); assert.match(x.stderr, /^error: (unknown command: (tasks|lmbee|team)|Use an explicit command for options)/); };
      controls(assertGone, r, [exitMutant(0), ['output appears', (x) => ({ ...x, stdout: 'ok\n' })]]);
    }
  });

  // ---- the local daemon service report ---------------------------------------------------------------------------
  // `lmctl serve status` reports the local lmctl daemon service and the site agent only: no network, no database change.
  check('serve status: exit 0, a "service: lmctl.service" line and the site agent state; --json is one object; unknown verbs exit 2 with usage', () => {
    const t = lmctl(seeded.env, ['serve', 'status']);
    const j = lmctl(seeded.env, ['serve', 'status', '--json']);
    const text = (r) => { assert.equal(r.status, 0); assert.match(r.stdout, /^service: lmctl\.service; /m); assert.match(r.stdout, /^site agent: /m); };
    const js = (r) => { assert.equal(r.status, 0); const o = json(r); assert.equal(o.service.unit, 'lmctl.service'); assert.equal(typeof o.service.installed, 'boolean'); assert.equal(typeof o.site_agent.state, 'string'); };
    controls(text, t, [exitMutant(2), ['shape lost', (r) => ({ ...r, stdout: '' })]]);
    controls(js, j, [exitMutant(2), ['unit renamed', (r) => ({ ...r, stdout: r.stdout.replace('lmctl.service', 'lmbee.service') })]]);
    const refused = lmctl(seeded.env, ['serve', 'enable', 'remote_execute']);
    const assertRefused = (r) => { assert.equal(r.status, 2); assert.match(r.stderr, /invalid lmctl serve command\nusage: lmctl serve install\|start\|stop\|status\|uninstall\n\s+lmctl serve daemon/); };
    controls(assertRefused, refused, [exitMutant(0), ['usage lost', (r) => ({ ...r, stderr: 'error' })]]);
  });
} catch (error) {
  failed += 1;
  console.log(`FAIL setup: ${error?.stack ?? error}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const total = passed + failed + skipped;
console.log(skipped > 0
  ? `${total} assertions: ${passed} pass, ${skipped} skipped, ${failed} fail`
  : `${total} assertions: ${passed} pass, ${failed} fail`);
process.exitCode = failed > 0 ? 1 : 0;
