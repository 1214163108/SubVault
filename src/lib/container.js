/**
 * SubVault private export container.
 *
 * Every non-interoperable export (backups, pre-import / pre-merge /
 * pre-restore snapshots) is written as this binary container instead of a
 * readable JSON file. Renaming the file to .txt therefore shows binary
 * garbage: the payload is gzip-compressed JSON that itself holds an
 * AES-256-GCM ciphertext box, never plaintext account data.
 *
 * Layout:
 *   bytes 0..4   magic "SVBAK"
 *   byte  5      container version (1)
 *   byte  6      flags (bit 0 = gzip payload)
 *   byte  7      reserved (0)
 *   bytes 8..    payload
 */

export const CONTAINER_MAGIC = 'SVBAK';
export const CONTAINER_VERSION = 1;
export const CONTAINER_EXTENSION = 'svbak';
const HEADER_BYTES = 8;
const MAGIC_BYTES = [0x53, 0x56, 0x42, 0x41, 0x4b]; // S V B A K

function gzipSupported() {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function pipeThrough(bytes, stream) {
  const source = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

/** Serialize a value into the private binary container. */
export async function packContainer(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const raw = new TextEncoder().encode(json);
  const useGzip = gzipSupported();
  const payload = useGzip ? await pipeThrough(raw, new CompressionStream('gzip')) : raw;
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out.set(MAGIC_BYTES, 0);
  out[5] = CONTAINER_VERSION;
  out[6] = useGzip ? 1 : 0;
  out[7] = 0;
  out.set(payload, HEADER_BYTES);
  return out;
}

export function isContainerBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_BYTES) return false;
  return MAGIC_BYTES.every((byte, index) => bytes[index] === byte);
}

/** True when the buffer looks like a legacy plain-JSON export. */
export function isLegacyJson(bytes) {
  if (!(bytes instanceof Uint8Array)) return false;
  let index = 0;
  // Skip a UTF-8 BOM so files saved by Notepad still count as JSON.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3;
  for (; index < Math.min(bytes.length, 64); index += 1) {
    const byte = bytes[index];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b || byte === 0x5b; // { or [
  }
  return false;
}

/**
 * Read the container back into a parsed object.
 * Legacy plain-JSON exports are still accepted so old backups keep working.
 */
export async function unpackContainer(input) {
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else throw new Error('无法读取该文件');

  if (isContainerBytes(bytes)) {
    if (bytes[5] !== CONTAINER_VERSION) throw new Error('导出文件版本不受支持');
    const gzipped = (bytes[6] & 1) === 1;
    let payload = bytes.subarray(HEADER_BYTES);
    if (gzipped) {
      if (typeof DecompressionStream !== 'function') throw new Error('当前环境不支持解压该文件');
      payload = await pipeThrough(payload, new DecompressionStream('gzip'));
    }
    const text = new TextDecoder().decode(payload);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('导出文件已损坏');
    }
  }

  if (isLegacyJson(bytes)) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('文件不是有效的 SubVault 导出');
    }
  }
  throw new Error('不是 SubVault 私有导出文件');
}

/** Best-effort label for file pickers and status lines. */
export function containerLabel() {
  return `.${CONTAINER_EXTENSION}`;
}
