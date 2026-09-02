const { randomUUID } = require('crypto');

const REDIS_KEY = 'test_results';
const MAX_ENTRIES = 5000;
const MESSAGE_MAX_LEN = 20000;

async function upstashCommand(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Upstash env vars not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function upstashPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Upstash env vars not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
  }
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  return res.json();
}

function normalizeEntry(raw, fallbackTimestamp) {
  return {
    id: raw.id || randomUUID(),
    test_name: String(raw.test_name || 'unknown'),
    outcome: ['passed', 'failed', 'error', 'skipped'].includes(raw.outcome) ? raw.outcome : 'unknown',
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    build_number: raw.build_number != null ? String(raw.build_number) : null,
    build_url: raw.build_url || null,
    node_name: raw.node_name || null,
    job_name: raw.job_name || null,
    category: raw.category || null,
    message: raw.message ? String(raw.message).slice(0, MESSAGE_MAX_LEN) : null,
    timestamp: raw.timestamp || fallbackTimestamp,
  };
}

function fallbackId(rawString) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < rawString.length; i++) {
    hash ^= rawString.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return 'legacy-' + (hash >>> 0).toString(16);
}

function parseStoredEntry(rawString) {
  try {
    const data = JSON.parse(rawString);
    if (!data.id) data.id = fallbackId(rawString);
    return data;
  } catch {
    return null;
  }
}

function computeAggregates(entries) {
  const byTest = new Map();
  for (const e of entries) {
    if (!byTest.has(e.test_name)) {
      byTest.set(e.test_name, {
        test_name: e.test_name,
        total: 0,
        categories: {},
        last_outcome: null,
        last_build: null,
        last_build_url: null,
        last_timestamp: null,
        runs: [],
      });
    }
    const agg = byTest.get(e.test_name);
    agg.total += 1;
    if (e.category) agg.categories[e.category] = (agg.categories[e.category] || 0) + 1;
    if (agg.runs.length < 200) {
      agg.runs.push({
        id: e.id,
        outcome: e.outcome,
        build_number: e.build_number,
        build_url: e.build_url,
        timestamp: e.timestamp,
        category: e.category,
        message: e.message,
      });
    }
    if (agg.last_timestamp === null) {
      agg.last_outcome = e.outcome;
      agg.last_build = e.build_number;
      agg.last_build_url = e.build_url;
      agg.last_timestamp = e.timestamp;
    }
  }
  const list = Array.from(byTest.values());
  list.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return new Date(b.last_timestamp || 0) - new Date(a.last_timestamp || 0);
  });
  return list;
}

function checkAuth(req) {
  const apiKey = req.headers['x-api-key'];
  return Boolean(process.env.INGEST_TOKEN) && apiKey === process.env.INGEST_TOKEN;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'POST') {
      if (!checkAuth(req)) {
        res.status(401).json({ error: 'invalid or missing x-api-key' });
        return;
      }

      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const results = Array.isArray(body.results) ? body.results : null;
      if (!results || results.length === 0) {
        res.status(400).json({ error: 'expected { "results": [ ... ] }' });
        return;
      }

      const now = new Date().toISOString();
      const normalized = results.map((r) => normalizeEntry(r, now));

      const commands = normalized.map((e) => ['LPUSH', REDIS_KEY, JSON.stringify(e)]);
      commands.push(['LTRIM', REDIS_KEY, '0', String(MAX_ENTRIES - 1)]);
      await upstashPipeline(commands);

      res.status(200).json({ ok: true, inserted: normalized.length });
      return;
    }

    if (req.method === 'DELETE') {
      if (!checkAuth(req)) {
        res.status(401).json({ error: 'invalid or missing x-api-key' });
        return;
      }

      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const targetId = body.id || null;
      const targetTestName = body.test_name || null;
      const deleteAll = Boolean(body.all);

      if (!targetId && !(targetTestName && deleteAll)) {
        res.status(400).json({ error: 'expected { "id": "..." } or { "test_name": "...", "all": true }' });
        return;
      }

      const raw = await upstashCommand(['LRANGE', REDIS_KEY, '0', '-1']);
      const rawList = raw || [];

      let deleted = 0;
      const kept = [];
      for (const rawString of rawList) {
        const data = parseStoredEntry(rawString);
        if (!data) continue;
        const matches = targetId ? data.id === targetId : data.test_name === targetTestName;
        if (matches) {
          deleted += 1;
        } else {
          kept.push(rawString);
        }
      }

      const commands = [['DEL', REDIS_KEY]];
      for (const rawString of kept) {
        commands.push(['RPUSH', REDIS_KEY, rawString]);
      }
      await upstashPipeline(commands);

      res.status(200).json({ ok: true, deleted, remaining: kept.length });
      return;
    }

    if (req.method === 'GET') {
      const limitParam = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), MAX_ENTRIES) : 2000;

      const raw = await upstashCommand(['LRANGE', REDIS_KEY, '0', String(limit - 1)]);
      const entries = (raw || []).map(parseStoredEntry).filter(Boolean);

      const tests = computeAggregates(entries);

      res.status(200).json({
        generated_at: new Date().toISOString(),
        total_entries: entries.length,
        tests,
        recent: entries.slice(0, 100),
      });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
