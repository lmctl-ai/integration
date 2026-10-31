// Real binary preflight/session reader/resolver; never prompts a model.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyProviderFailure } from './rate-limit-classifier.mjs';

const requestedBinary = process.env.LMCTL_BIN;
const resolvedBin = (requestedBinary && (requestedBinary.includes('/') || existsSync(requestedBinary)))
  ? requestedBinary
  : execFileSync('which', [requestedBinary || 'lmctl'], { encoding: 'utf8' }).trim();
const executable = realpathSync(resolvedBin);
const distCandidates = [
  resolve(dirname(executable), '../dist/providers'),
  resolve(dirname(fileURLToPath(import.meta.url)), 'providers'),
];
const dist = distCandidates.find(d => existsSync(d)) || distCandidates[0];
const load = name => import(pathToFileURL(join(dist, name + '.js')));
const [mode, payload] = process.argv.slice(2);
const input = payload ? JSON.parse(payload) : {};
let output;

if (mode === 'preflight') {
  if (process.env.LMCTL_SKIP_BINARY_CHECK === '1') throw new Error('Real binary checks are required');
  const { checkProviderBinaries } = await load('binary-check');
  output = checkProviderBinaries(input);
} else if (mode === 'observe') {
  let loadSessionDetail = null;
  try {
    const resumeMod = await load('resume');
    loadSessionDetail = resumeMod.loadSessionDetail;
  } catch {
    // If resume.js is unavailable in standalone dist, session model will be read via lmctl status
  }
  const { loadCatalogSnapshot } = await load('pricing');
  const { resolveModel, resolveOfferForCost } = await load('model-catalog');
  // Deliberately pass no declaration to the session reader.
  let detail = null;
  if (loadSessionDetail) {
    detail = await loadSessionDetail(input.sessionid, input.provider);
  }
  let observed = detail?.model ?? null;
  const directory = mkdtempSync(join(tmpdir(), 'lmctl-live-status-'));
  let status;
  try {
    const file = join(directory, 'probe.lmctl');
    const model = input.model == null ? '' : ' model=' + JSON.stringify(input.model);
    writeFileSync(file, `_MEMBER_ alias=Probe provider=${input.provider} sessionid=${input.sessionid}${model}\n`);
    status = JSON.parse(execFileSync(executable, ['status', file, '--details', '--json'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const memberStatus = status.members.find(member => member.alias === 'Probe');
  if (observed === null && memberStatus?.observed_model && memberStatus.observed_model !== '(unknown)') {
    observed = memberStatus.observed_model;
  }
  const snapshot = observed ? await loadCatalogSnapshot() : null;
  const resolution = observed ? resolveModel(input.provider, observed, snapshot.catalog, snapshot.aliases) : null;
  const selected = observed ? resolveOfferForCost(input.provider, observed, snapshot.catalog, snapshot.aliases) : null;
  output = {
    observed, scope: 'session', status: memberStatus,
    resolution, selected_route: selected?.offer?.route ?? null,
    catalog_source: snapshot?.source ?? null, generated_at: snapshot?.generatedAt ?? null,
  };
} else if (mode === 'catalog') {
  const { loadCatalogSnapshot } = await load('pricing');
  const { resolveModel, resolveOfferForCost } = await load('model-catalog');
  const snapshot = await loadCatalogSnapshot({ pinDir: input.catalogPath });
  if (!snapshot.catalog || !snapshot.aliases) throw new Error('fixture catalog could not be loaded as a pinned snapshot');
  const state = resolveModel(input.provider, input.model, snapshot.catalog, snapshot.aliases);
  const selected = resolveOfferForCost(input.provider, input.model, snapshot.catalog, snapshot.aliases);
  output = { state, selected_route: selected.offer?.route ?? null, catalog_source: snapshot.source, generated_at: snapshot.generatedAt };
} else if (mode === 'classify') {
  const errText = String(input?.error || '');
  const res = classifyProviderFailure(errText, input?.provider);
  output = { isRateLimit: Boolean(res?.isRateLimit) };
} else {
  throw new Error('Unknown mode: ' + mode);
}
process.stdout.write(JSON.stringify(output));
