import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatReconciliationPercentage,
  normalizeCustodyAddressLists,
  normalizeReconciliationAlertPercent,
  resolveWalletEffectiveState,
  selectDesiredState,
  truncateApiCrypto,
  truncateApiFiat,
  truncateApiPercentage,
} from '../wallet-core.policy.js';

const healthy = {
  completedDelist: false,
  globalDesiredState: 'ON', chainDesiredState: 'ON',
  currencyDesiredState: 'ON', bindingDesiredState: 'ON',
  listingState: 'LISTED', providerState: 'ACTIVATED', providerPinned: false,
  priceReadiness: 'HEALTHY',
} as const;

describe('Wallet Core effective-state policy', () => {
  it('applies the approved facet precedence without mutating saved desired states', () => {
    const cases = [
      ['completed delist', { completedDelist: true }, 'DELISTED'],
      ['global OFF over lower ON', { globalDesiredState: 'OFF' }, 'OFF'],
      ['global MAINTAIN over lower OFF', { globalDesiredState: 'MAINTAIN', chainDesiredState: 'OFF' }, 'MAINTAIN'],
      ['chain OFF after global recovery', { chainDesiredState: 'OFF' }, 'OFF'],
      ['whole-currency MAINTAIN after chain recovery', { currencyDesiredState: 'MAINTAIN' }, 'MAINTAIN'],
      ['binding OFF after whole-currency recovery', { bindingDesiredState: 'OFF' }, 'OFF'],
      ['future visible listing', { listingState: 'UPCOMING_VISIBLE' }, 'UPCOMING'],
      ['provider pin', { providerPinned: true }, 'MAINTAIN'],
      ['price unavailable', { priceReadiness: 'UNAVAILABLE' }, 'MAINTAIN'],
      ['listed, desired ON, healthy', {}, 'ON'],
    ] as const;
    for (const [name, changes, expected] of cases) {
      const input = { ...healthy, ...changes };
      const before = structuredClone(input);
      assert.equal(resolveWalletEffectiveState(input), expected, name);
      assert.deepEqual(input, before, `${name} mutated input`);
    }
    assert.equal(resolveWalletEffectiveState({ ...healthy, providerState: 'DISABLED' }), 'MAINTAIN');
    assert.equal(resolveWalletEffectiveState({ ...healthy, providerState: 'MAINTENANCE' }), 'MAINTAIN');
    assert.equal(resolveWalletEffectiveState({ ...healthy, providerState: 'UNAVAILABLE' }), 'MAINTAIN');
  });

  it('stops at the first Global to Chain to Currency to Binding desired-state gate', () => {
    assert.equal(selectDesiredState(['MAINTAIN', 'OFF', 'OFF', 'OFF']), 'MAINTAIN');
    assert.equal(selectDesiredState(['ON', 'OFF', 'MAINTAIN', 'OFF']), 'OFF');
    assert.equal(selectDesiredState(['ON', 'ON', 'MAINTAIN', 'OFF']), 'MAINTAIN');
    assert.equal(selectDesiredState(['ON', 'ON', 'ON', 'OFF']), 'OFF');
    assert.equal(selectDesiredState(['ON', 'ON', 'ON', 'ON']), 'ON');
  });
});

describe('Wallet Core exact reconciliation policy', () => {
  it('truncates projection decimals toward zero without Number, rounding, or exponent output', () => {
    const cases = [
      [truncateApiFiat, '123.456789', '123.45'],
      [truncateApiFiat, '-123.456789', '-123.45'],
      [truncateApiFiat, '0.009', '0'],
      [truncateApiCrypto, '0.123456789123456789', '0.12345678'],
      [truncateApiCrypto, '-0.000000009', '0'],
      [truncateApiPercentage, '99.9999', '99.999'],
      [truncateApiPercentage, '5.1000', '5.1'],
      [truncateApiFiat, '999999999999999999999999.999', '999999999999999999999999.99'],
    ] as const;
    for (const [format, input, expected] of cases) assert.equal(format(input), expected, input);
    for (const invalid of ['1e3', 'NaN', 'Infinity', '+1', '.5', '1.', ' 1.5 ', '01.5']) {
      assert.throws(() => truncateApiCrypto(invalid), /decimal/i, invalid);
    }
  });

  it('derives distribution percentages exactly and returns null for a zero denominator', () => {
    assert.equal(formatReconciliationPercentage('1', '3'), '33.333');
    assert.equal(formatReconciliationPercentage('2', '3'), '66.666');
    assert.equal(formatReconciliationPercentage('1', '8'), '12.5');
    assert.equal(formatReconciliationPercentage('0.000000000000000001', '1'), '0');
    assert.equal(formatReconciliationPercentage('999999999999999999.99', '1000000000000000000'), '99.999');
    assert.equal(formatReconciliationPercentage('1', '0.000000000000000000'), null);
    for (const invalid of ['-1', '1e3', ' 1']) {
      assert.throws(() => formatReconciliationPercentage(invalid, '1'), /decimal/i);
    }
  });

  it('canonicalizes thresholds and exposes exact thousandths of a percent', () => {
    assert.deepEqual(normalizeReconciliationAlertPercent('0.000'), {
      reconciliationAlertPercent: '0', thresholdMilliPercent: 0,
    });
    assert.deepEqual(normalizeReconciliationAlertPercent('5.010'), {
      reconciliationAlertPercent: '5.01', thresholdMilliPercent: 5010,
    });
    assert.deepEqual(normalizeReconciliationAlertPercent('50.000'), {
      reconciliationAlertPercent: '50', thresholdMilliPercent: 50_000,
    });
    for (const invalid of ['-1', '50.001', '1.2345', '1e1', ' 5 ']) {
      assert.throws(() => normalizeReconciliationAlertPercent(invalid), /threshold/i);
    }
  });

});

describe('Wallet Core custody address policy', () => {
  it('uses chain-aware identity, enforces HOT/COLD disjointness, and permits staking overlap', () => {
    assert.throws(() => normalizeCustodyAddressLists({
      isEvm: true, isToken: false, hotWalletAddresses: ['0xAbC'],
      coldWalletAddresses: [' 0xaBc '], stakingWalletAddresses: [],
    }), /HOT.*COLD/i);
    assert.deepEqual(normalizeCustodyAddressLists({
      isEvm: false, isToken: false, hotWalletAddresses: [' Case '],
      coldWalletAddresses: ['case'], stakingWalletAddresses: ['Case', 'case'],
    }), {
      hotWalletAddresses: ['Case'], coldWalletAddresses: ['case'],
      stakingWalletAddresses: ['Case', 'case'],
    });
    assert.deepEqual(normalizeCustodyAddressLists({
      isEvm: true, isToken: false, hotWalletAddresses: ['0xHot'],
      coldWalletAddresses: ['0xCold'], stakingWalletAddresses: ['0xhot', '0xcold'],
    }).stakingWalletAddresses, ['0xhot', '0xcold']);
  });

  it('accepts exactly 10,000 and rejects 10,001 independently for every address kind', () => {
    const addresses = Array.from({ length: 10_000 }, (_, index) => `address-${index}`);
    for (const [property, resultProperty] of [
      ['hotWalletAddresses', 'hotWalletAddresses'],
      ['coldWalletAddresses', 'coldWalletAddresses'],
      ['stakingWalletAddresses', 'stakingWalletAddresses'],
    ] as const) {
      const input = {
        isEvm: false, isToken: false, hotWalletAddresses: [],
        coldWalletAddresses: [], stakingWalletAddresses: [],
        [property]: addresses,
      };
      assert.equal(normalizeCustodyAddressLists(input)[resultProperty].length, 10_000, property);
      assert.throws(() => normalizeCustodyAddressLists({
        ...input, [property]: [...addresses, 'overflow'],
      }), /10,000/, property);
    }
  });

  it('rejects staking addresses on token bindings independently of list size', () => {
    assert.throws(() => normalizeCustodyAddressLists({
      isEvm: false, isToken: true, hotWalletAddresses: [],
      coldWalletAddresses: [], stakingWalletAddresses: ['stake'],
    }), /token/i);
  });
});
