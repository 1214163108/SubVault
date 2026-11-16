import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MASTER_MIN_BITS,
  evaluateMasterPassword,
  strengthLabel,
  strengthPercent,
} from '../src/lib/strength.js';

test('short master passwords are blocked', async () => {
  const result = await evaluateMasterPassword('Ab1!x');
  assert.equal(result.blocked, true);
  assert.match(result.message, /10/);
});

test('common and low-entropy master passwords are blocked', async () => {
  const weak = await evaluateMasterPassword('password123');
  assert.equal(weak.blocked, true);
  assert.ok(weak.bits < 50);

  const dictionary = await evaluateMasterPassword('Tr0ub4dor&3');
  assert.equal(dictionary.blocked, true);
});

test('medium strength requires an explicit confirmation', async () => {
  const result = await evaluateMasterPassword('Xk9#mQ2vLp7@Rt4z');
  assert.equal(result.blocked, false);
  assert.equal(result.needsConfirm, true);
  assert.ok(result.bits >= 50 && result.bits < MASTER_MIN_BITS);
  assert.match(result.message, /勾选/);
});

test('strong random master passwords pass without confirmation', async () => {
  const result = await evaluateMasterPassword('SubVault-Test-2026!Qm7#');
  assert.equal(result.blocked, false);
  assert.equal(result.needsConfirm, false);
  assert.ok(result.bits >= MASTER_MIN_BITS);
  assert.equal(result.message, '');
});

test('labels and percentages increase with entropy', () => {
  assert.equal(strengthLabel(10), '很弱');
  assert.equal(strengthLabel(45), '弱');
  assert.equal(strengthLabel(55), '一般');
  assert.equal(strengthLabel(70), '强');
  assert.equal(strengthLabel(120), '很强');
  assert.ok(strengthPercent(40) < strengthPercent(65));
  assert.equal(strengthPercent(200), 100);
});
