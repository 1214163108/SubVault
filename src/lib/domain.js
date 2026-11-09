/**
 * Host / subdomain helpers shared by the background, popup and options page.
 *
 * SubVault's default isolation unit is the FULL hostname, so
 * `mail.example.com` and `drive.example.com` never share credentials.
 * An entry can opt into `scope: "domain"`, which then matches the stored
 * registrable domain and every subdomain below it.
 */

import { PSL_RULES } from './psl-data.js';

const PSL_EXACT = new Set();
const PSL_WILDCARD = new Set();
const PSL_EXCEPTION = new Set();
for (const rule of PSL_RULES) {
  if (rule.startsWith('!')) PSL_EXCEPTION.add(rule.slice(1));
  else if (rule.startsWith('*.')) PSL_WILDCARD.add(rule.slice(2));
  else PSL_EXACT.add(rule);
}

const SECOND_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.tw', 'net.tw', 'org.tw', 'idv.tw',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.za', 'org.za', 'net.za', 'gov.za',
  'com.mx', 'net.mx', 'org.mx', 'gob.mx',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr',
  'com.ru', 'net.ru', 'org.ru',
  'com.ua', 'net.ua', 'org.ua',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar',
  'com.co', 'net.co', 'org.co',
  'com.pe', 'net.pe', 'org.pe',
  'com.vn', 'net.vn', 'org.vn',
  'co.th', 'in.th', 'or.th', 'ac.th', 'go.th',
  'com.my', 'net.my', 'org.my', 'edu.my', 'gov.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph',
  'co.id', 'or.id', 'web.id', 'ac.id', 'go.id',
  'com.pk', 'net.pk', 'org.pk', 'gov.pk',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa',
  // Common private suffixes (multi-tenant hosting). Treat the project label as
  // the registrable domain so tenants never share credentials with each other.
  'github.io', 'gitlab.io', 'githubusercontent.com',
  'herokuapp.com', 'appspot.com', 'web.app', 'firebaseapp.com',
  'azurewebsites.net', 'cloudfront.net', 's3.amazonaws.com',
  'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev',
  'onrender.com', 'fly.dev', 'railway.app', 'glitch.me', 'repl.co', 'surge.sh',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'weebly.com', 'wixsite.com',
  'notion.site', 'readthedocs.io',
]);

/** Lowercase, strip a trailing dot, and reject anything that is not a host. */
export function normalizeHost(input) {
  if (!input) return '';
  let value = String(input).trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/^\/\//, '');
  const slash = value.indexOf('/');
  if (slash !== -1) value = value.slice(0, slash);
  const at = value.lastIndexOf('@');
  if (at !== -1) value = value.slice(at + 1);
  value = value.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!value) return '';
  if (value.startsWith('[') && value.endsWith(']')) return value;
  if (!/^[a-z0-9.-]+$/.test(value)) return '';
  if (value.includes('..')) return '';
  if (!value.split('.').every((label) => label.length > 0 && label.length <= 63)) return '';
  return value;
}

/** @returns {URL|null} only for http(s) URLs */
export function parseHttpUrl(input) {
  if (!input) return null;
  let value = String(input).trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value.replace(/^\/\//, '')}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

export function hostFromUrl(input) {
  const url = parseHttpUrl(input);
  return url ? normalizeHost(url.hostname) : '';
}

export function originFromUrl(input) {
  const url = parseHttpUrl(input);
  return url ? url.origin : '';
}

export function isIpHost(host) {
  const value = normalizeHost(host);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.startsWith('[');
}

/** How many trailing labels form the public suffix (PSL rules). */
function pslPublicSuffixLabels(labels) {
  for (let i = 0; i < labels.length; i += 1) {
    const suffix = labels.slice(i).join('.');
    if (PSL_EXCEPTION.has(suffix)) {
      return Math.max(1, labels.length - i - 1);
    }
  }

  let count = 1; // PSL default rule: "*"
  for (let i = 0; i < labels.length; i += 1) {
    const suffix = labels.slice(i).join('.');
    const suffixLabels = labels.length - i;
    if (PSL_EXACT.has(suffix)) count = Math.max(count, suffixLabels);
    if (i + 1 < labels.length) {
      const wildcardBase = labels.slice(i + 1).join('.');
      if (PSL_WILDCARD.has(wildcardBase)) count = Math.max(count, suffixLabels);
    }
  }
  return count;
}

/**
 * Best-effort registrable domain (eTLD+1) for the "include subdomains" scope.
 * Uses the bundled full Public Suffix List, with the compact list as a fallback
 * if a build ever ships without PSL data.
 */
export function suggestBaseDomain(input) {
  const host = normalizeHost(input);
  if (!host || isIpHost(host) || host === 'localhost') return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');

  if (PSL_RULES.size > 0) {
    const suffixLabels = pslPublicSuffixLabels(labels);
    if (suffixLabels >= labels.length) return host;
    return labels.slice(-(suffixLabels + 1)).join('.');
  }

  const lastThree = labels.slice(-3).join('.');
  if (SECOND_LEVEL_SUFFIXES.has(lastThree)) return labels.slice(-4).join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (SECOND_LEVEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/** True when `host` is exactly `domain` or a subdomain of it. */
export function isSameOrSubdomain(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/** Normalize and de-duplicate the user's "isolated main domains" setting. */
export function normalizeDomainList(list) {
  const result = [];
  for (const item of Array.isArray(list) ? list : []) {
    const host = normalizeHost(item);
    if (!host || !isValidHost(host)) continue;
    if (!result.includes(host)) result.push(host);
  }
  return result.slice(0, 200);
}

/** True when every subdomain below one of these domains must be isolated. */
export function isHostIsolated(host, isolatedDomains = []) {
  const target = normalizeHost(host);
  if (!target) return false;
  return isolatedDomains.some((item) => {
    const domain = normalizeHost(item);
    return Boolean(domain) && (target === domain || target.endsWith(`.${domain}`));
  });
}

/**
 * The bucket used for storage / matching.
 *
 * Default rule: the registrable domain, so mail.example.com and
 * drive.example.com share credentials.
 * Isolated rule: if the host belongs to a configured main domain, the full
 * hostname becomes the bucket, so every subdomain is independent.
 * Port rule: when `portIsolation` is on, localhost/IP buckets include the port;
 * normal DNS names keep ignoring ports.
 */
export function normalizePort(input) {
  const value = Number(String(input ?? '').replace(/[^\d]/g, ''));
  return Number.isInteger(value) && value > 0 && value <= 65535 ? String(value) : '';
}

export function isPortScopedHost(host) {
  const target = normalizeHost(host);
  return target === 'localhost' || isIpHost(target);
}

export function siteKeyFor(host, isolatedDomains = [], options = {}) {
  const target = normalizeHost(host);
  if (!target) return '';
  const key = isHostIsolated(target, isolatedDomains)
    ? target
    : suggestBaseDomain(target);
  if (options.portIsolation && isPortScopedHost(target)) {
    const port = normalizePort(options.port);
    if (port) return `${key}:${port}`;
  }
  return key;
}

/**
 * Credentials match when their effective site buckets are identical.
 * @param {{host: string, port?: string}} entry
 * @param {string} host
 * @param {string[]} [isolatedDomains]
 * @param {{port?: string, portIsolation?: boolean}} [options]
 */
export function matchesHost(entry, host, isolatedDomains = [], options = {}) {
  if (!entry || !entry.host) return false;
  const entryKey = siteKeyFor(entry.host, isolatedDomains, {
    port: entry.port,
    portIsolation: options.portIsolation,
  });
  const targetKey = siteKeyFor(host, isolatedDomains, options);
  return Boolean(entryKey) && entryKey === targetKey;
}

export function isValidHost(value) {
  const host = normalizeHost(value);
  if (!host) return false;
  if (host === 'localhost' || isIpHost(host)) return true;
  return host.includes('.');
}

/** Human-friendly host for display (keeps punycode, strips brackets on IPv6). */
export function displayHost(value) {
  const host = normalizeHost(value);
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}
