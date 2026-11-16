/** Cryptographically random password generator (no dependencies). */

const READABLE = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '~!@#$%^&*()-_=+[]{};:,.?/|',
};

const FULL = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '~!@#$%^&*()-_=+[]{};:,.?/|',
};

function randomInt(max) {
  if (max <= 0) throw new Error('max must be positive');
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);
  return value % max;
}

function clampLength(value, fallback) {
  return Math.min(128, Math.max(8, Number(value) || fallback));
}

/**
 * Pure-digit PIN / numeric password.
 * @param {number} [length]
 */
export function generatePin(length = 6) {
  const size = Math.min(64, Math.max(4, Number(length) || 6));
  let value = '';
  for (let index = 0; index < size; index += 1) value += String(randomInt(10));
  return value;
}

/**
 * @param {{length?: number, lower?: boolean, upper?: boolean, digits?: boolean, symbols?: boolean, readable?: boolean}} [options]
 */
export function generatePassword(options = {}) {
  const length = clampLength(options.length, 20);
  const classes = options.readable === false ? FULL : READABLE;
  const selected = ['lower', 'upper', 'digits', 'symbols'].filter(
    (key) => options[key] !== false,
  );
  const active = selected.length > 0 ? selected : ['lower'];
  const pools = active.map((key) => classes[key]);
  const all = pools.join('');
  const chars = pools.map((pool) => pool[randomInt(pool.length)]);

  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, length).join('');
}
