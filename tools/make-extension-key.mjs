import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const hostDir = path.join(root, 'native-host');
fs.mkdirSync(hostDir, { recursive: true });
const keyPath = path.join(hostDir, 'extension-private-key.pem');
const manifestPath = path.join(root, 'manifest.json');
const idPath = path.join(hostDir, 'extension-id.txt');

let privateKey;
if (fs.existsSync(keyPath)) {
  privateKey = fs.readFileSync(keyPath, 'utf8');
} else {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(keyPath, privateKey, 'utf8');
}

const publicKey = crypto.createPublicKey(privateKey);
const der = publicKey.export({ type: 'spki', format: 'der' });
const base64 = der.toString('base64');
const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
const extensionId = [...hash].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join('');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.key = base64;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
fs.writeFileSync(idPath, extensionId, 'utf8');
console.log(`extension id: ${extensionId}`);
console.log(`public key: ${base64.length} chars`);
