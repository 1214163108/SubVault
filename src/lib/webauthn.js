/* Platform-authenticator (Windows Hello) gate for device quick unlock.
 *
 * WebAuthn is only available from extension pages, and every call must be
 * triggered by a user gesture.  The credential is an interaction gate: the
 * actual VaultKey stays wrapped by DPAPI on the native host.  No secret is
 * derived from the WebAuthn assertion, and nothing is synced.
 */

function toBase64Url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function deviceVerificationSupported() {
  return Boolean(
    typeof PublicKeyCredential !== 'undefined'
    && navigator.credentials
    && typeof navigator.credentials.create === 'function'
    && typeof navigator.credentials.get === 'function',
  );
}

export async function platformVerifierAvailable() {
  if (!deviceVerificationSupported()) return false;
  try {
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function createDeviceCredential() {
  if (!deviceVerificationSupported()) throw new Error('当前浏览器不支持 Windows Hello 验证');
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'SubVault' },
      user: {
        id: randomBytes(16),
        name: 'subvault-device',
        displayName: 'SubVault 本机设备',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'discouraged',
      },
      timeout: 60000,
      attestation: 'none',
    },
  });
  if (!credential?.rawId) throw new Error('Windows Hello 未返回可用凭据');
  return toBase64Url(new Uint8Array(credential.rawId));
}

export async function assertDeviceCredential(credentialId) {
  if (!credentialId) return true;
  if (!deviceVerificationSupported()) throw new Error('当前浏览器不支持 Windows Hello 验证');
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  return Boolean(assertion);
}

export function describeVerificationError(error) {
  const name = String(error?.name || '');
  if (name === 'NotAllowedError') return 'Windows Hello 验证已取消或超时';
  if (name === 'NotSupportedError' || name === 'SecurityError') {
    return '当前设备无法使用 Windows Hello，请改用主密码解锁';
  }
  if (name === 'InvalidStateError') return 'Windows Hello 凭据已失效，请重新启用设备快速解锁';
  return error?.message || 'Windows Hello 验证失败';
}
