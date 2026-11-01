import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReconciliationLedgerView } from '../reconciliation-ledger-view.js';

test('formats signed and positive Ledger totals without rounding', () => {
  assert.deepEqual(formatReconciliationLedgerView({
    ledgerSignedTotal: '-123.456789019999999999',
    ledgerPositiveTotal: '123.456789019999999999',
    priceUsd: '2.000000000000000000',
    alertBasis: 'SIGNED',
  }), {
    ledgerSignedTotal: '-123.45678901',
    ledgerSignedTotalUsd: '-246.91',
    ledgerPositiveTotal: '123.45678901',
    ledgerPositiveTotalUsd: '246.91',
    alertBasis: 'SIGNED',
  });
});

test('supports native totals wider than numeric(38,18)', () => {
  assert.deepEqual(formatReconciliationLedgerView({
    ledgerSignedTotal: '100000000000000000000000000000000000000',
    ledgerPositiveTotal: '100000000000000000000000000000000000000',
    priceUsd: '2',
    alertBasis: 'POSITIVE_ONLY',
  }), {
    ledgerSignedTotal: '100000000000000000000000000000000000000',
    ledgerSignedTotalUsd: '200000000000000000000000000000000000000',
    ledgerPositiveTotal: '100000000000000000000000000000000000000',
    ledgerPositiveTotalUsd: '200000000000000000000000000000000000000',
    alertBasis: 'POSITIVE_ONLY',
  });
});

test('truncates tiny values toward zero and never rounds', () => {
  assert.deepEqual(formatReconciliationLedgerView({
    ledgerSignedTotal: '-0.000000009999999999',
    ledgerPositiveTotal: '0.000000000000000001',
    priceUsd: '100000000',
    alertBasis: 'SIGNED',
  }), {
    ledgerSignedTotal: '0',
    ledgerSignedTotalUsd: '-0.99',
    ledgerPositiveTotal: '0',
    ledgerPositiveTotalUsd: '0',
    alertBasis: 'SIGNED',
  });
});

test('preserves zero and nullable legacy evidence without fabricating price or basis', () => {
  assert.deepEqual(formatReconciliationLedgerView({
    ledgerSignedTotal: '0.000000000000000000',
    ledgerPositiveTotal: '0',
    priceUsd: '1',
    alertBasis: null,
  }), {
    ledgerSignedTotal: '0', ledgerSignedTotalUsd: '0',
    ledgerPositiveTotal: '0', ledgerPositiveTotalUsd: '0', alertBasis: null,
  });
  assert.deepEqual(formatReconciliationLedgerView({
    ledgerSignedTotal: null,
    ledgerPositiveTotal: '1.250000000000000000',
    priceUsd: null,
    alertBasis: null,
  }), {
    ledgerSignedTotal: null, ledgerSignedTotalUsd: null,
    ledgerPositiveTotal: '1.25', ledgerPositiveTotalUsd: null, alertBasis: null,
  });
});

test('rejects malformed, noncanonical, over-precision, and oversized totals', () => {
  const invalid = ['', '01', '+1', '.1', '1.', '1e2', '-0', '-0.000000000000000000',
    '1.0000000000000000000', '1'.repeat(61)];
  for (const ledgerSignedTotal of invalid) {
    assert.throws(() => formatReconciliationLedgerView({
      ledgerSignedTotal, ledgerPositiveTotal: null, priceUsd: null, alertBasis: null,
    }), TypeError, ledgerSignedTotal);
  }
});

test('rejects negative positive totals and non-positive, malformed, or oversized prices', () => {
  assert.throws(() => formatReconciliationLedgerView({
    ledgerSignedTotal: null, ledgerPositiveTotal: '-1', priceUsd: null, alertBasis: null,
  }), TypeError);
  for (const priceUsd of ['0', '0.000000000000000000', '-1', '1e2',
    '1.0000000000000000000', '1'.repeat(21)]) {
    assert.throws(() => formatReconciliationLedgerView({
      ledgerSignedTotal: '1', ledgerPositiveTotal: '1', priceUsd, alertBasis: null,
    }), TypeError, priceUsd);
  }
});

test('rejects an unknown alert basis at runtime', () => {
  assert.throws(() => formatReconciliationLedgerView({
    ledgerSignedTotal: null, ledgerPositiveTotal: null, priceUsd: null,
    alertBasis: 'OTHER' as 'SIGNED',
  }), TypeError);
});
