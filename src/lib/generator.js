/** Cryptographically random password generator (no dependencies). */

const CLASSES = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
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

/**
 * @param {{length?: number, lower?: boolean, upper?: boolean, digits?: boolean, symbols?: boolean}} [options]
 */
export function generatePassword(options = {}) {
  const length = Math.min(128, Math.max(8, Number(options.length) || 20));
  const selected = ['lower', 'upper', 'digits', 'symbols'].filter(
    (key) => options[key] !== false,
  );
  const active = selected.length > 0 ? selected : ['lower'];
  const pools = active.map((key) => CLASSES[key]);
  const all = pools.join('');
  const chars = pools.map((pool) => pool[randomInt(pool.length)]);

  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, length).join('');
}
