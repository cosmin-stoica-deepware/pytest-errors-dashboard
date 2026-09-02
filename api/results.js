const REDIS_KEY = 'test_results';
const MAX_ENTRIES = 5000;

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
  const data = await res.json();
  return data;
}

function normalizeEntry(raw, fallbackTimestamp) {
  return {
    test_name: String(raw.test_name || 'unknown'),
    outcome: ['passed', 'failed', 'error', 'skipped'].includes(raw.outcome) ? raw.outcome : 'unknown',
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    build_number: raw.build_number != null ? String(raw.build_number) : null,
    build_url: raw.build_url || null,
    node_name: raw.node_name || null,
    job_name: raw.job_name || null,
    category: raw.category || null,
    message: raw.message ? String(raw.message).slice(0, 500) : null,
    timestamp: raw.timestamp || fallbackTimestamp,
  };
}

function computeAggregates(entries) {
  const byTest = new Map();
  for (const e of entries) {
    if (!byTest.has(e.test_name)) {
      byTest.set(e.test_name, {
        test_name: e.test_name,
        total: 0,
        passed: 0,
        failed: 0,
        error: 0,
        skipped: 0,
        categories: {},
        last_outcome: null,
        last_build: null,
        last_build_url: null,
        last_timestamp: null,
      });
    }
    const agg = byTest.get(e.test_name);
    agg.total += 1;
    if (agg[e.outcome] !== undefined) agg[e.outcome] += 1;
    if (e.category) agg.categories[e.category] = (agg.categories[e.category] || 0) + 1;
    if (agg.last_timestamp === null) {
      agg.last_outcome = e.outcome;
      agg.last_build = e.build_number;
      agg.last_build_url = e.build_url;
      agg.last_timestamp = e.timestamp;
    }
  }
  const list = Array.from(byTest.values()).map((agg) => {
    const nonSkipped = agg.total - agg.skipped;
    const failCount = agg.failed + agg.error;
    const failRate = nonSkipped > 0 ? failCount / nonSkipped : 0;
    return { ...agg, fail_rate: Math.round(failRate * 1000) / 1000 };
  });
  list.sort((a, b) => b.fail_rate - a.fail_rate || b.total - a.total);
  return list;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'POST') {
      const apiKey = req.headers['x-api-key'];
      if (!process.env.INGEST_TOKEN || apiKey !== process.env.INGEST_TOKEN) {
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

    if (req.method === 'GET') {
      const limitParam = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), MAX_ENTRIES) : 2000;

      const raw = await upstashCommand(['LRANGE', REDIS_KEY, '0', String(limit - 1)]);
      const entries = (raw || [])
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

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
