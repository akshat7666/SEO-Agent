const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

async function getDbPromise() {
  try {
    console.log("Connecting to database...");
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing. Set it in Railway or your local environment before starting the app.");
    }
    const client = await pool.connect();
    console.log("Connected to PostgreSQL");
    client.release();
    return pool;
  } catch (err) {
    console.error("DB connection error:", err.message);
    throw err;
  }
}

// -------------------------------------
// CRAWLER & SESSION WRITERS
// -------------------------------------
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
    const setQuery = keys.map((k, i) => {
      values.push(updates[k]);
      return `${k} = $${i + 2}`;
    }).join(', ');

    await pool.query(`UPDATE sessions SET ${setQuery} WHERE id = $1`, values);
  } catch (e) {
    console.error('updateSession error:', e.message);
  }
}

async function getPendingPages(sessionId, limit = 10) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM pages WHERE session_id = $1 AND crawl_status = $2 LIMIT $3`,
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
    const setQuery = keys.map((k, i) => {
      values.push(updates[k]);
      return `${k} = $${i + 3}`;
    }).join(', ');

    await pool.query(`UPDATE pages SET ${setQuery} WHERE session_id = $1 AND original_url = $2`, values);
  } catch (e) {
    console.error('updatePage error:', e.message);
  }
}

// -------------------------------------
// API ROUTE READERS
// -------------------------------------
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

async function getSessionStats(sessionId) {
  try {
    const { rows } = await pool.query(`
      SELECT 
        COUNT(*) as total_pages,
        AVG(score) as avg_score,
        COUNT(CASE WHEN score < 60 THEN 1 END) as weak_pages,
        COUNT(CASE WHEN score >= 60 AND score < 80 THEN 1 END) as average_pages,
        COUNT(CASE WHEN score >= 80 THEN 1 END) as strong_pages
      FROM pages WHERE session_id = $1 AND crawl_status = 'done'
    `, [sessionId]);

    const r = rows[0] || {};
    return {
      avg_score: Math.round(Number(r.avg_score) || 0),
      total_pages: Number(r.total_pages) || 0,
      weak_pages: Number(r.weak_pages) || 0,
      average_pages: Number(r.average_pages) || 0,
      strong_pages: Number(r.strong_pages) || 0
    };
  } catch (err) {
    console.error('getSessionStats error:', err.message);
    return {};
  }
}

async function getIssueSummary(sessionId) {
  try {
    const { rows } = await pool.query(`SELECT issues FROM pages WHERE session_id = $1 AND issues IS NOT NULL`, [sessionId]);
    const summary = {};
    
    rows.forEach(r => {
      try {
        const issues = typeof r.issues === 'string' ? JSON.parse(r.issues) : r.issues;
        for (const [key, details] of Object.entries(issues || {})) {
          if (!summary[key]) summary[key] = { count: 0, severity: details.severity || 'low' };
          summary[key].count++;
        }
      } catch (e) {}
    });
    
    return Object.entries(summary).map(([key, data]) => ({ type: key, ...data }));
  } catch (err) {
    console.error('getIssueSummary error:', err.message);
    return [];
  }
}

async function getPagesBySession(sessionId, filters = {}) {
  try {
    const { rows } = await pool.query(`SELECT * FROM pages WHERE session_id = $1`, [sessionId]);
    return rows;
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
