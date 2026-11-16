/**
 * Local-only master-password strength evaluation.
 *
 * The zxcvbn build in `src/vendor/zxcvbn.js` is bundled with the extension so
 * that estimating a password never touches the network. It is a ~820 KB UMD
 * bundle, therefore it is loaded lazily and only when a password is typed.
 */

export const MASTER_MIN_BITS = 60;
export const MASTER_BLOCK_BITS = 50;
export const MASTER_MIN_LENGTH = 10;

let engine = null;
let loading = null;

async function loadEngine() {
  if (engine) return engine;
  // MV3 service workers forbid dynamic import(); the background script loads
  // the bundle with a static side-effect import, so it is already on the
  // global object by the time a password is validated there.
  const present = globalThis.zxcvbn;
  if (typeof present === 'function') {
    engine = present;
    return engine;
  }
  if (!loading) {
    loading = (async () => {
      await import('../vendor/zxcvbn.js');
      const candidate = globalThis.zxcvbn;
      if (typeof candidate !== 'function') {
        throw new Error('zxcvbn unavailable');
      }
      engine = candidate;
      return engine;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

export function strengthLabel(bits) {
  if (bits < 30) return '很弱';
  if (bits < 50) return '弱';
  if (bits < 60) return '一般';
  if (bits < 80) return '强';
  return '很强';
}

export function strengthPercent(bits) {
  if (bits <= 0) return 0;
  if (bits < 30) return 18;
  if (bits < 50) return 38;
  if (bits < 60) return 58;
  if (bits < 80) return 80;
  return 100;
}

/**
 * @param {string} password
 * @returns {Promise<{
 *   bits: number,
 *   score: number,
 *   label: string,
 *   percent: number,
 *   blocked: boolean,
 *   needsConfirm: boolean,
 *   message: string,
 *   suggestions: string[],
 * }>}
 */
export async function evaluateMasterPassword(password) {
  const value = String(password || '');
  if (!value) {
    return {
      bits: 0,
      score: 0,
      label: '未输入',
      percent: 0,
      blocked: true,
      needsConfirm: false,
      message: '',
      suggestions: [],
    };
  }

  let result = null;
  try {
    const zxcvbn = await loadEngine();
    result = zxcvbn(value);
  } catch {
    // Fail closed: never let an unavailable estimator wave a weak password
    // through. The engine ships with the extension, so this is an error path.
    return {
      bits: 0,
      score: 0,
      label: '无法评估',
      percent: 0,
      blocked: true,
      needsConfirm: false,
      message: '主密码强度评估不可用，请刷新页面后重试',
      suggestions: [],
    };
  }

  const bits = Math.max(0, Math.log2(Math.max(1, Number(result.guesses) || 1)));
  const tooShort = value.length < MASTER_MIN_LENGTH;
  const blocked = tooShort || bits < MASTER_BLOCK_BITS;
  const needsConfirm = !blocked && bits < MASTER_MIN_BITS;

  let message = '';
  if (tooShort) {
    message = `主密码至少需要 ${MASTER_MIN_LENGTH} 个字符`;
  } else if (blocked) {
    message = `强度过低（约 ${bits.toFixed(0)} bits），请更换更长的随机密码`;
  } else if (needsConfirm) {
    message = `强度一般（约 ${bits.toFixed(0)} bits，建议 ≥ ${MASTER_MIN_BITS} bits），请勾选下方确认后继续`;
  }

  const feedback = result.feedback || {};
  const suggestions = [
    ...(feedback.warning ? [feedback.warning] : []),
    ...(Array.isArray(feedback.suggestions) ? feedback.suggestions : []),
  ].slice(0, 2);

  return {
    bits,
    score: Number(result.score) || 0,
    label: strengthLabel(bits),
    percent: strengthPercent(bits),
    blocked,
    needsConfirm,
    message,
    suggestions,
  };
}
