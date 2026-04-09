const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let schemaEnsured = false;

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

function parseJsonSafely(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

async function ensureSchema() {
  if (schemaEnsured) return;

  const statements = [
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS site_score INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS h2_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS h3_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS h4_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS h5_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS h6_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS image_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS images_missing_alt_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS images_with_alt_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS broken_internal_links_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS broken_external_links_count INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS heading_structure_score INTEGER DEFAULT 0`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_type TEXT`,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS crawl_attempts INTEGER DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_pages_session_status ON pages(session_id, crawl_status)`,
    `CREATE INDEX IF NOT EXISTS idx_pages_session_score ON pages(session_id, score)`,
    `CREATE INDEX IF NOT EXISTS idx_pages_session_status_code ON pages(session_id, status_code)`,
    `CREATE INDEX IF NOT EXISTS idx_pages_session_domain ON pages(session_id, domain)`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }

  schemaEnsured = true;
}

async function getDbPromise() {
  try {
    console.log('Connecting to database...');
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is missing. Set it in Railway or your local environment before starting the app.');
    }
    const client = await pool.connect();
    client.release();
    await ensureSchema();
    console.log('Connected to PostgreSQL');
    return pool;
  } catch (err) {
    console.error('DB connection error:', err.message);
    throw err;
  }
}

async function createSession(sessionId, targetUrl) {
  try {
    await pool.query(
      'INSERT INTO sessions (id, target_url, status) VALUES ($1, $2, $3)',
      [sessionId, targetUrl, 'running']
    );
  } catch (e) {
    console.error('createSession error:', e.message);
  }
}

async function insertPage(sessionId, originalUrl, domain, subdomain) {
  try {
    await pool.query(
      `INSERT INTO pages (session_id, original_url, domain, subdomain, crawl_status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, original_url) DO NOTHING`,
      [sessionId, originalUrl, domain, subdomain, 'pending']
    );
  } catch (e) {
    console.error('insertPage error:', e.message);
  }
}

async function updateSession(sessionId, updates) {
  try {
    const keys = Object.keys(updates);
    if (keys.length === 0) return;

    const values = [sessionId];
    const setQuery = keys.map((key, index) => {
      values.push(updates[key]);
      return `${key} = $${index + 2}`;
    }).join(', ');

    await pool.query(`UPDATE sessions SET ${setQuery} WHERE id = $1`, values);
  } catch (e) {
    console.error('updateSession error:', e.message);
  }
}

async function claimPendingPages(sessionId, limit = 1) {
  try {
    const { rows } = await pool.query(
      `WITH claimed AS (
         SELECT id
         FROM pages
         WHERE session_id = $1 AND crawl_status = 'pending'
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE pages p
       SET crawl_status = 'processing',
           crawl_attempts = COALESCE(crawl_attempts, 0) + 1
       FROM claimed
       WHERE p.id = claimed.id
       RETURNING p.*`,
      [sessionId, limit]
    );

    return rows;
  } catch (e) {
    console.error('claimPendingPages error:', e.message);
    return [];
  }
}

async function getPendingPages(sessionId, limit = 10) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM pages WHERE session_id = $1 AND crawl_status = $2 ORDER BY id LIMIT $3`,
      [sessionId, 'pending', limit]
    );
    return rows;
  } catch (e) {
    console.error('getPendingPages error:', e.message);
    return [];
  }
}

async function updatePage(sessionId, originalUrl, updates) {
  try {
    const keys = Object.keys(updates);
    if (keys.length === 0) return;

    const values = [sessionId, originalUrl];
    const setQuery = keys.map((key, index) => {
      values.push(updates[key]);
      return `${key} = $${index + 3}`;
    }).join(', ');

    await pool.query(
      `UPDATE pages SET ${setQuery} WHERE session_id = $1 AND original_url = $2`,
      values
    );
  } catch (e) {
    console.error('updatePage error:', e.message);
  }
}

async function getAllSessions() {
  try {
    const { rows } = await pool.query('SELECT * FROM sessions ORDER BY created_at DESC');
    return rows;
  } catch (err) {
    console.error('getAllSessions error:', err.message);
    return [];
  }
}

async function getLatestSession() {
  try {
    const { rows } = await pool.query('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1');
    return rows[0] || null;
  } catch (err) {
    console.error('getLatestSession error:', err.message);
    return null;
  }
}

async function getSession(sessionId) {
  try {
    const { rows } = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    return rows[0] || null;
  } catch (err) {
    console.error('getSession error:', err.message);
    return null;
  }
}

async function getIssueSummary(sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT issues FROM pages WHERE session_id = $1 AND issues IS NOT NULL AND crawl_status = 'done'`,
      [sessionId]
    );

    const summary = new Map();

    for (const row of rows) {
      const issues = parseJsonSafely(row.issues, []);
      const issueList = Array.isArray(issues) ? issues : Object.values(issues || {});

      for (const issue of issueList) {
        if (!issue || !issue.type) continue;
        const existing = summary.get(issue.type) || {
          type: issue.type,
          count: 0,
          severity: issue.severity || 'warning',
          field: issue.field || null
        };
        existing.count += 1;
        summary.set(issue.type, existing);
      }
    }

    return [...summary.values()].sort((a, b) => b.count - a.count);
  } catch (err) {
    console.error('getIssueSummary error:', err.message);
    return [];
  }
}

async function getSessionStats(sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) AS total_pages,
         COUNT(*) FILTER (WHERE crawl_status = 'done') AS crawled_pages,
         COUNT(*) FILTER (WHERE crawl_status = 'processing') AS processing_pages,
         COUNT(*) FILTER (WHERE crawl_status = 'pending') AS pending_pages,
         COUNT(*) FILTER (WHERE crawl_status = 'error') AS error_pages,
         AVG(score) FILTER (WHERE crawl_status = 'done') AS avg_score,
         AVG(load_time_ms) FILTER (WHERE crawl_status = 'done') AS avg_load_time,
         COUNT(*) FILTER (WHERE crawl_status = 'done' AND score < 60) AS weak_pages,
         COUNT(*) FILTER (WHERE crawl_status = 'done' AND score >= 60 AND score < 80) AS average_pages,
         COUNT(*) FILTER (WHERE crawl_status = 'done' AND score >= 80) AS strong_pages,
         COUNT(*) FILTER (WHERE is_redirect = 1) AS redirects,
         COUNT(DISTINCT domain) FILTER (WHERE domain IS NOT NULL) AS domains,
         COUNT(DISTINCT subdomain) FILTER (WHERE subdomain IS NOT NULL) AS subdomains,
         SUM(image_count) FILTER (WHERE crawl_status = 'done') AS total_images,
         SUM(images_missing_alt_count) FILTER (WHERE crawl_status = 'done') AS images_missing_alt,
         SUM(broken_internal_links_count) FILTER (WHERE crawl_status = 'done') AS broken_internal_links,
         SUM(broken_external_links_count) FILTER (WHERE crawl_status = 'done') AS broken_external_links
       FROM pages
       WHERE session_id = $1`,
      [sessionId]
    );

    const issueSummary = await getIssueSummary(sessionId);
    const issueCounts = issueSummary.reduce((acc, issue) => {
      acc[issue.type] = issue.count;
      return acc;
    }, {});

    const row = rows[0] || {};
    return {
      total_pages: Number(row.total_pages) || 0,
      crawled: Number(row.crawled_pages) || 0,
      processing: Number(row.processing_pages) || 0,
      pending: Number(row.pending_pages) || 0,
      errors: Number(row.error_pages) || 0,
      avg_score: Math.round(Number(row.avg_score) || 0),
      avg_load_time: Math.round(Number(row.avg_load_time) || 0),
      weak_pages: Number(row.weak_pages) || 0,
      average_pages: Number(row.average_pages) || 0,
      strong_pages: Number(row.strong_pages) || 0,
      redirects: Number(row.redirects) || 0,
      domains: Number(row.domains) || 0,
      subdomains: Number(row.subdomains) || 0,
      total_images: Number(row.total_images) || 0,
      images_missing_alt: Number(row.images_missing_alt) || 0,
      broken_internal_links: Number(row.broken_internal_links) || 0,
      broken_external_links: Number(row.broken_external_links) || 0,
      issue_counts: issueCounts,
      ...issueCounts
    };
  } catch (err) {
    console.error('getSessionStats error:', err.message);
    return {};
  }
}

async function getPagesBySession(sessionId, filters = {}) {
  try {
    const where = ['session_id = $1'];
    const values = [sessionId];

    if (filters.domain) {
      values.push(filters.domain);
      where.push(`domain = $${values.length}`);
    }
    if (filters.subdomain) {
      values.push(filters.subdomain);
      where.push(`subdomain = $${values.length}`);
    }
    if (filters.minScore !== undefined) {
      values.push(filters.minScore);
      where.push(`score >= $${values.length}`);
    }
    if (filters.maxScore !== undefined) {
      values.push(filters.maxScore);
      where.push(`score <= $${values.length}`);
    }
    if (filters.statusCode !== undefined) {
      values.push(filters.statusCode);
      where.push(`status_code = $${values.length}`);
    }
    if (filters.crawlStatus) {
      values.push(filters.crawlStatus);
      where.push(`crawl_status = $${values.length}`);
    }

    const query = `
      SELECT *
      FROM pages
      WHERE ${where.join(' AND ')}
      ORDER BY score ASC NULLS LAST, original_url ASC
      ${filters.limit ? `LIMIT ${Math.max(1, Number(filters.limit) || 100)}` : ''}
    `;

    const { rows } = await pool.query(query, values);
    let filteredRows = rows;

    if (filters.issueType) {
      filteredRows = rows.filter((page) => {
        const issues = parseJsonSafely(page.issues, []);
        const issueList = Array.isArray(issues) ? issues : Object.values(issues || {});
        return issueList.some((issue) => issue.type === filters.issueType);
      });
    }

    return filteredRows;
  } catch (err) {
    console.error('getPagesBySession error:', err.message);
    return [];
  }
}

async function getPageById(pageId) {
  try {
    const { rows } = await pool.query('SELECT * FROM pages WHERE id = $1', [pageId]);
    return rows[0] || null;
  } catch (err) {
    console.error('getPageById error:', err.message);
    return null;
  }
}

module.exports = {
  pool,
  getDbPromise,
  createSession,
  insertPage,
  updateSession,
  claimPendingPages,
  getPendingPages,
  updatePage,
  getAllSessions,
  getLatestSession,
  getSession,
  getSessionStats,
  getIssueSummary,
  getPagesBySession,
  getPageById
};
