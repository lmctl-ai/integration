// Quota helpers shared by the live suites and pinned by tests/live-service-controls.mjs. The lmbee service fixtures that used to live here
// (isolated `lmbee serve`, the escalation CLI, native-session HTTP) were retired with the lmbee package; see
// durable-memory/lmbee-removal-test-ledger-2026-10-27.md (B11, B12).

export function quotaSkipReason(provider, payload) {
  const reading = payload?.readings?.find(row => row?.provider === provider);
  if (!reading) throw new Error('rate-limit response has no reading for ' + provider);
  const reason = typeof reading.reason === 'string' ? reading.reason : '';
  const detail = typeof reading.detail === 'string' ? reading.detail : '';
  if (reading.status !== 'ok') {
    if (['credentials_missing', 'agy_not_found'].includes(reason)) return 'provider credentials or binary are unavailable';
    if (isQuotaMessage(reason) || isQuotaMessage(detail)) return 'provider quota is exhausted';
    throw new Error(`rate-limit reader status is ${String(reading.status)} for ${provider}`);
  }
  if (reading.ordinary_usage_allowed === false) return 'ordinary usage is disallowed';
  if (reading.spend_control?.reached === true) return 'spend control is reached';
  for (const bucket of Array.isArray(reading.buckets) ? reading.buckets : []) {
    const id = String(bucket?.bucket_id ?? '');
    // Operator rule 2026-10-07: automated tests never consume or gate on Agy's 3p bucket.
    if (provider === 'agy' && (id.startsWith('3p') || id.startsWith('agy-3p'))) continue;
    const used = typeof bucket?.used_fraction === 'number' ? bucket.used_fraction : null;
    if (bucket?.is_exhausted === true || bucket?.limit_reached === true || bucket?.allowed === false || (used !== null && used >= 1)) {
      return `quota bucket exhausted: ${id || 'unknown'}`;
    }
  }
  return null;
}

export function isQuotaMessage(value) {
  return typeof value === 'string' && /rate[ -]?limit|too many requests|\b429\b|resource exhausted|quota.{0,24}(exhaust|reached|limit)|usage limit reached|spend control.{0,24}(reach|exhaust)/i.test(value);
}
