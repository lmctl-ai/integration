// Transport only: call the installed lmctl's real resolver and cost calculation.
// No candidate selection, normalization, fallback price, or synthesized priced flag.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [catalogPath, aliasesPath, requestsJson] = process.argv.slice(2);
const executable = realpathSync(execFileSync('which', ['lmctl'], { encoding: 'utf8' }).trim());
const distCandidates = [
  resolve(dirname(executable), '../dist/providers'),
  resolve(dirname(fileURLToPath(import.meta.url)), 'providers'),
];
const dist = distCandidates.find(d => existsSync(d)) || distCandidates[0];
const resolverPath = resolve(dist, 'model-catalog.js');
const { resolveModel, resolveOfferForCost } = await import(pathToFileURL(resolverPath));
const { isValidCatalog, isValidAliases, computeCostUsd } =
  await import(pathToFileURL(resolve(dist, 'pricing.js')));
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const aliases = JSON.parse(readFileSync(aliasesPath, 'utf8'));
if (!isValidCatalog(catalog) || !isValidAliases(aliases)) {
  throw new Error('Published catalog or alias table failed production validation');
}

const requests = JSON.parse(requestsJson);
const results = requests.map(({ provider, name }) => {
  const orders = [catalog, { ...catalog, records: [...catalog.records].reverse() }];
  return {
    provider,
    name,
    orders: orders.map(data => {
      const state = resolveModel(provider, name, data, aliases);
      const resolution = resolveOfferForCost(provider, name, data, aliases);
      const pricing = resolution.offer?.pricing ?? null;
      return {
        state,
        resolution,
        cost: computeCostUsd({ input: 1_000_000, output: 1_000_000, cachedInput: 0 }, pricing),
        zeroUsageCost: computeCostUsd({ input: 0, output: 0, cachedInput: 0 }, pricing),
      };
    }),
  };
});
process.stdout.write(JSON.stringify({ executable, resolverPath, results }));
