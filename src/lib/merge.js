/**
 * Timestamp-aware merge for imported credentials.
 *
 * Conflict scope follows the current subdomain policy:
 *  - default: one record per registrable domain + account (subdomains share)
 *  - configured isolated main domain: one record per full hostname + account
 *
 * When several passwords exist for the same group, the newest
 * `passwordChangedAt` wins; older rows are folded into it.
 */

import { randomId } from './crypto.js';
import { normalizeHost, normalizePort, siteKeyFor } from './domain.js';

/** Effective "password changed at" time, with fallbacks for legacy entries. */
export function entryTime(entry) {
  const explicit = Number(entry?.passwordChangedAt);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const updated = Number(entry?.updatedAt);
  if (Number.isFinite(updated) && updated > 0) return updated;
  const created = Number(entry?.createdAt);
  if (Number.isFinite(created) && created > 0) return created;
  return 0;
}

/**
 * Conflict key: effective site bucket + lowercased username.
 * Without a username (password-only records) the exact host is used so that
 * unrelated records are not merged together.
 */
export function conflictGroupKey(
  host,
  username,
  isolatedDomains = [],
  options = {},
) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return '';
  const user = String(username || '').trim();
  const port = normalizePort(options.port);
  const bucket = user
    ? siteKeyFor(normalizedHost, isolatedDomains, options)
    : `${normalizedHost}${port ? `:${port}` : ''}`;
  return `${bucket}\u0000${user.toLowerCase()}`;
}

/**
 * @param {object[]} existingEntries full vault entries (not mutated)
 * @param {object[]} incomingEntries normalized entries with passwordChangedAt
 * @param {{now?: number, source?: string, isolatedDomains?: string[]}} [options]
 * @returns {{entries: object[], imported: number, updated: number, merged: number, groups: number}}
 */
export function mergeEntries(existingEntries, incomingEntries, options = {}) {
  const now = Number(options.now) || Date.now();
  const source = options.source || 'import';
  const isolatedDomains = Array.isArray(options.isolatedDomains)
    ? options.isolatedDomains
    : [];
  const portIsolation = Boolean(options.portIsolation);
  const entries = existingEntries.map((entry) => ({ ...entry }));
  const groups = new Map();

  for (const raw of incomingEntries) {
    const host = normalizeHost(raw.host);
    const username = String(raw.username || '').trim();
    const password = String(raw.password ?? '');
    if (!host || !password) continue;

    const key = conflictGroupKey(host, username, isolatedDomains, {
      port: raw.port,
      portIsolation,
    });
    if (!key) continue;

    const time = Number(raw.passwordChangedAt) > 0 ? Number(raw.passwordChangedAt) : now;
    const row = {
      ...raw,
      host,
      port: normalizePort(raw.port),
      username,
      password,
      passwordChangedAt: time,
    };

    let group = groups.get(key);
    if (!group) {
      group = { key, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  let imported = 0;
  let updated = 0;
  let consumed = 0;

  for (const group of groups.values()) {
    consumed += group.rows.length;
    const existingGroup = entries.filter(
      (entry) =>
        conflictGroupKey(entry.host, entry.username, isolatedDomains, {
          port: entry.port,
          portIsolation,
        }) === group.key,
    );

    let winner = group.rows[0];
    for (const row of group.rows) {
      if (row.passwordChangedAt >= winner.passwordChangedAt) winner = row;
    }
    let winnerTime = winner.passwordChangedAt;

    for (const entry of existingGroup) {
      const time = entryTime(entry);
      if (time > winnerTime) {
        winner = { ...entry, passwordChangedAt: time };
        winnerTime = time;
      }
    }

    for (const entry of existingGroup) {
      const time = entryTime(entry);
      if (entry.password !== winner.password || time !== winnerTime) {
        if (entry.password !== winner.password) {
          entry.history = [
            { password: entry.password, changedAt: time },
            ...(Array.isArray(entry.history) ? entry.history : []),
          ].slice(0, 5);
        }
        entry.password = winner.password;
        entry.passwordChangedAt = winnerTime;
        entry.updatedAt = now;
        entry.source = source;
        if (winner.favorite !== undefined) entry.favorite = Boolean(winner.favorite);
        if (Array.isArray(winner.tags) && winner.tags.length) entry.tags = winner.tags;
        if (winner.folder) entry.folder = winner.folder;
        if (winner.totpSecret) {
          entry.totpSecret = winner.totpSecret;
          entry.totpDigits = winner.totpDigits || 6;
          entry.totpPeriod = winner.totpPeriod || 30;
          entry.totpAlgorithm = winner.totpAlgorithm || 'SHA1';
        }
        updated += 1;
      }
    }

    // One record per effective site bucket. Existing entries already cover it.
    if (existingGroup.length === 0) {
      const host = normalizeHost(winner.host);
      entries.push({
        id: randomId(),
        title: winner.title || host,
        host,
        port: normalizePort(winner.port),
        username: winner.username || '',
        password: winner.password,
        notes: winner.notes || '',
        url: winner.url || `https://${host}/`,
        totpSecret: winner.totpSecret || '',
        totpDigits: winner.totpDigits || 6,
        totpPeriod: winner.totpPeriod || 30,
        totpAlgorithm: winner.totpAlgorithm || 'SHA1',
        favorite: Boolean(winner.favorite),
        tags: Array.isArray(winner.tags) ? winner.tags : [],
        folder: winner.folder || '',
        source,
        createdAt: now,
        updatedAt: now,
        passwordChangedAt: winnerTime,
        lastUsedAt: 0,
        history: Array.isArray(winner.history)
          ? winner.history
              .filter((item) => item && typeof item.password === 'string')
              .slice(0, 5)
          : [],
      });
      imported += 1;
    }
  }

  return {
    entries,
    imported,
    updated,
    merged: Math.max(0, consumed - imported),
    groups: groups.size,
  };
}
