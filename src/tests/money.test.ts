import assert from 'node:assert/strict';
import { fallbackMinorUnits, fromMinorUnits, toMinorUnits } from '../lib/money.js';

assert.equal(toMinorUnits('1'), 100_000_000);
assert.equal(toMinorUnits('0.00000001'), 1);
assert.equal(fromMinorUnits(1), 0.00000001);
assert.equal(fallbackMinorUnits(undefined, 0.005), 500_000);
assert.throws(() => toMinorUnits('0.000000001'), /at most 8 decimal/);

assert.equal(toMinorUnits('0.02', 'USDC'), 20_000);
assert.equal(toMinorUnits('1240.50', 'USDC'), 1_240_500_000);
assert.equal(fromMinorUnits(20_000, 'USDC'), 0.02);
assert.equal(fallbackMinorUnits(undefined, 0.005, 'USDC'), 5_000);
assert.throws(() => toMinorUnits('0.0000001', 'USDC'), /at most 6 decimal/);
