import test from 'node:test';
import assert from 'node:assert/strict';

import {
  base32Decode,
  generateTotp,
  isValidTotpSecret,
  normalizeTotpSecret,
} from '../src/lib/totp.js';

test('Base32 normalization and validation', () => {
  assert.equal(normalizeTotpSecret('jbsw y3dp ehpk 3pxp'), 'JBSWY3DPEHPK3PXP');
  assert.equal(isValidTotpSecret('JBSWY3DPEHPK3PXP'), true);
  assert.equal(isValidTotpSecret('not base32!'), false);
  assert.equal(base32Decode('JBSWY3DPEHPK3PXP').length, 10);
});

test('RFC 6238 SHA-1 test vector', async () => {
  // Secret "12345678901234567890", 8 digits, T=59 -> 94287082
  const result = await generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', {
    now: 59_000,
    digits: 8,
    period: 30,
  });
  assert.equal(result.code, '94287082');
  assert.equal(result.remaining, 1);
});

test('six-digit code has correct shape and countdown', async () => {
  const result = await generateTotp('JBSWY3DPEHPK3PXP', { now: 1_700_000_000_000 });
  assert.equal(result.code.length, 6);
  assert.equal(/^\d{6}$/.test(result.code), true);
  assert.equal(result.remaining >= 1 && result.remaining <= 30, true);
});
