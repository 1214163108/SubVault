import test from 'node:test';
import assert from 'node:assert/strict';

import {
  base32Decode,
  generateHotp,
  generateOtpForEntry,
  generateTotp,
  isValidTotpSecret,
  normalizeTotpSecret,
  parseOtpAuthUri,
  STEAM_ALPHABET,
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

test('otpauth URI carries digits, period and algorithm', () => {
  const otp = parseOtpAuthUri(
    'otpauth://totp/ACME:alice?secret=JBSWY3DPEHPK3PXP&issuer=ACME&digits=8&period=60&algorithm=SHA256',
  );
  assert.equal(otp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(otp.digits, 8);
  assert.equal(otp.period, 60);
  assert.equal(otp.algorithm, 'SHA256');
  assert.equal(otp.issuer, 'ACME');
  assert.equal(otp.account, 'alice');
  assert.equal(parseOtpAuthUri('JBSWY3DPEHPK3PXP'), null);
});

test('RFC 4226 HOTP test vectors (counters 0-9)', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  for (let counter = 0; counter < expected.length; counter += 1) {
    const result = await generateHotp(secret, { counter });
    assert.equal(result.code, expected[counter], `counter ${counter}`);
    assert.equal(result.counter, counter);
  }
});

test('otpauth://hotp carries the counter and stays stable', async () => {
  const otp = parseOtpAuthUri(
    'otpauth://hotp/ACME:bob?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=3',
  );
  assert.equal(otp.type, 'hotp');
  assert.equal(otp.counter, 3);
  const result = await generateHotp(otp.secret, { counter: otp.counter });
  assert.equal(result.code, '969429');
});

test('Steam Guard uses 5 chars from its own alphabet', async () => {
  const steam = parseOtpAuthUri('steam://JBSWY3DPEHPK3PXP');
  assert.equal(steam.type, 'steam');
  assert.equal(steam.digits, 5);
  const first = await generateTotp(steam.secret, { type: 'steam', now: 1_700_000_000_000 });
  const second = await generateTotp(steam.secret, { type: 'steam', now: 1_700_000_000_000 });
  assert.equal(first.code.length, 5);
  assert.equal(first.code, second.code);
  assert.equal([...first.code].every((char) => STEAM_ALPHABET.includes(char)), true);
  assert.equal(first.type, 'steam');
  assert.equal(first.remaining >= 1 && first.remaining <= 30, true);
});

test('otpauth://totp with issuer=Steam and no digits is treated as Steam', () => {
  const otp = parseOtpAuthUri('otpauth://totp/Steam:alice?secret=JBSWY3DPEHPK3PXP&issuer=Steam');
  assert.equal(otp.type, 'steam');
  assert.equal(otp.digits, 5);
  const plain = parseOtpAuthUri('otpauth://totp/ACME:alice?secret=JBSWY3DPEHPK3PXP&issuer=ACME');
  assert.equal(plain.type, 'totp');
  assert.equal(plain.digits, 6);
});

test('generateOtpForEntry dispatches by stored type', async () => {
  const base = { totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', totpDigits: 6 };
  const hotp = await generateOtpForEntry({ ...base, totpType: 'hotp', totpCounter: 1 });
  assert.equal(hotp.code, '287082');
  assert.equal(hotp.period, 0);
  const totp = await generateOtpForEntry(
    { ...base, totpType: 'totp' },
    { now: 59_000 },
  );
  assert.equal(totp.code.length, 6);
  const steam = await generateOtpForEntry({
    ...base,
    totpType: 'steam',
    totpSecret: 'JBSWY3DPEHPK3PXP',
  });
  assert.equal(steam.code.length, 5);
  await assert.rejects(() => generateOtpForEntry({ totpSecret: '' }));
});
