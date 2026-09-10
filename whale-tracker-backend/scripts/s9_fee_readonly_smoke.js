'use strict';

/**
 * Read-only trusted-owner fee smoke.
 * Never prints API key / secret / passphrase / full OKX body.
 * Never places orders.
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && process.env[key] == null) process.env[key] = value;
  }
}
const binding = require('../lib/v41UserBinding');
const { getOkxCredentialsForUser } = require('../lib/userExchangeKeys');
const { fetchTrustedOwnerTradeFee } = require('../lib/v41S9Fee');

function redact(err) {
  return {
    code: err && err.code,
    status: err && err.status,
    reason: err && err.reason,
    message: err && err.message ? String(err.message).slice(0, 180) : '',
  };
}

function firstStoredOwnerId() {
  try {
    const { getDb } = require('../lib/db');
    const row = getDb()
      .prepare(
        "SELECT user_id FROM user_exchange_keys WHERE exchange = 'okx' AND enabled = 1 LIMIT 1",
      )
      .get();
    return row && row.user_id ? String(row.user_id).trim() : '';
  } catch {
    return '';
  }
}

async function main() {
  const envOwner = String(process.env.V41_ENGINE_OWNER_USER_ID || '').trim();
  const storedOwner = firstStoredOwnerId();
  const bound = binding.getBoundEngineOwner() || envOwner || storedOwner || '';
  if (bound) binding.bindEngineOwner(bound);
  const creds = bound ? getOkxCredentialsForUser(bound) : null;
  const report = {
    owner_ready: Boolean(bound),
    credential_ready: Boolean(creds && creds.apiKey && creds.secret && creds.passphrase),
    environment: null,
    http_status: null,
    okx_code: null,
    fee_source: null,
    taker_fee_parsed: null,
    fee_ready: false,
    result: null,
    reason: null,
  };
  if (!bound) {
    report.result = 'OWNER_NOT_READY';
    report.reason = 'OWNER_NOT_READY';
    console.log(JSON.stringify(report));
    process.exit(2);
  }
  if (!report.credential_ready) {
    report.result = 'CREDENTIAL_NOT_FOUND';
    report.reason = 'CREDENTIAL_NOT_FOUND';
    console.log(JSON.stringify(report));
    process.exit(2);
  }
  try {
    const out = await fetchTrustedOwnerTradeFee({
      ownerId: bound,
      instId: 'BTC-USDT-SWAP',
    });
    report.environment = out.account_environment;
    report.http_status = out.http_status || 200;
    report.okx_code = out.okx_code || '0';
    report.fee_source = out.source || out.fee_source;
    report.taker_fee_parsed = Number(out.taker_bps);
    report.fee_ready = out.fee_ready === true && Number(out.taker_bps) > 0;
    report.result = report.fee_ready ? 'SUCCESS' : 'FEE_RESPONSE_INVALID';
    report.reason = report.fee_ready ? null : 'FEE_RESPONSE_INVALID';
    console.log(JSON.stringify(report));
    process.exit(report.fee_ready ? 0 : 2);
  } catch (err) {
    report.environment = (err && err.details && err.details.account_environment) || report.environment;
    report.http_status = err && err.status;
    report.okx_code = err && err.details && err.details.okx_code;
    report.result = (err && err.code) || 'FEE_API_ERROR';
    report.reason = (err && err.code) || 'FEE_API_ERROR';
    report.error = redact(err);
    console.log(JSON.stringify(report));
    process.exit(2);
  }
}

main();
