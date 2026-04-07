const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'audit.db');

let db = null;
let dbReady = null;

function getDbPromise() {
  if (!dbReady) {
    dbReady = initSqlJs().then(SQL => {
      let data = null;
      if (fs.existsSync(DB_PATH)) {
        data = fs.readFileSync(DB_PATH);
      }
      db = data ? new SQL.Database(data) : new SQL.Database();
      db.run('PRAGMA foreign_keys = ON;');
      initSchema();
      return db;
    });
  }
  return dbReady;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call await getDbPromise() first.');
  return db;
}

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

function initSchema() {
  const d = getDb();

  d.run(`
    CREATE TABLE IF NOT EXISTS crawl_sessions (
      id TEXT PRIMARY KEY,
      target_url TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      total_discovered INTEGER DEFAULT 0,
      total_crawled INTEGER DEFAULT 0,
      total_errors INTEGER DEFAULT 0,
      avg_score REAL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.run(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      original_url TEXT NOT NULL,
      final_url TEXT,
      domain TEXT,
      subdomain TEXT,
      status_code INTEGER,
      is_redirect INTEGER DEFAULT 0,
      redirect_chain TEXT,
      title TEXT,
      title_length INTEGER DEFAULT 0,
      meta_description TEXT,
      meta_description_length INTEGER DEFAULT 0,
      h1_text TEXT,
      h1_count INTEGER DEFAULT 0,
      canonical_url TEXT,
      word_count INTEGER DEFAULT 0,
      schema_json TEXT,
      og_tags TEXT,
      internal_links_count INTEGER DEFAULT 0,
      external_links_count INTEGER DEFAULT 0,
      load_time_ms INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      score_breakdown TEXT,
      issues TEXT DEFAULT '[]',
      crawl_status TEXT DEFAULT 'pending',
      error_message TEXT,
      last_crawled TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES crawl_sessions(id),
      UNIQUE(session_id, original_url)
    )
  `);

  // Create indices
  try { d.run('CREATE INDEX IF NOT EXISTS idx_pages_session ON pages(session_id)'); } catch(e) {}
  try { d.run('CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain)'); } catch(e) {}
  try { d.run('CREATE INDEX IF NOT EXISTS idx_pages_score ON pages(score)'); } catch(e) {}
  try { d.run('CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(crawl_status)'); } catch(e) {}

  saveDb();
}

// Helper: run query and return rows as array of objects
function queryAll(sql, params = []) {
  const d = getDb();
  const stmt = d.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Helper: run query and return first row as object
function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// Helper: run statement (INSERT/UPDATE/DELETE)
function execute(sql, params = []) {
  const d = getDb();
  d.run(sql, params);
  saveDb();
}

// -- Crawl Sessions --
function createSession(id, targetUrl) {
  execute(
    `INSERT INTO crawl_sessions (id, target_url, status, started_at) VALUES (?, ?, 'running', datetime('now'))`,
    [id, targetUrl]
  );
  return id;
}

function updateSession(id, data) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  execute(`UPDATE crawl_sessions SET ${sets.join(', ')} WHERE id = ?`, vals);
}

function getSession(id) {
  return queryOne('SELECT * FROM crawl_sessions WHERE id = ?', [id]);
}

function getLatestSession() {
  return queryOne('SELECT * FROM crawl_sessions ORDER BY created_at DESC LIMIT 1');
}

function getAllSessions() {
  return queryAll('SELECT * FROM crawl_sessions ORDER BY created_at DESC');
}

// -- Pages --
function insertPage(sessionId, originalUrl, domain, subdomain) {
  try {
    execute(
      `INSERT OR IGNORE INTO pages (session_id, original_url, domain, subdomain) VALUES (?, ?, ?, ?)`,
      [sessionId, originalUrl, domain, subdomain || null]
    );
    return true;
  } catch (e) {
    return false;
  }
}

function updatePage(sessionId, originalUrl, data) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    sets.push(`${k} = ?`);
    vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  }
  vals.push(sessionId, originalUrl);
  execute(`UPDATE pages SET ${sets.join(', ')} WHERE session_id = ? AND original_url = ?`, vals);
}

function getPendingPages(sessionId, limit = 10) {
  return queryAll(
    `SELECT * FROM pages WHERE session_id = ? AND crawl_status = 'pending' LIMIT ?`,
    [sessionId, limit]
  );
}

function getPagesBySession(sessionId, filters = {}) {
  let query = 'SELECT * FROM pages WHERE session_id = ?';
  const params = [sessionId];

  if (filters.domain) {
    query += ' AND domain = ?';
    params.push(filters.domain);
  }
  if (filters.subdomain) {
    query += ' AND subdomain = ?';
    params.push(filters.subdomain);
  }
  if (filters.minScore !== undefined) {
    query += ' AND score >= ?';
    params.push(filters.minScore);
  }
  if (filters.maxScore !== undefined) {
    query += ' AND score <= ?';
    params.push(filters.maxScore);
  }
  if (filters.issueType) {
    query += ' AND issues LIKE ?';
    params.push(`%${filters.issueType}%`);
  }
  if (filters.statusCode) {
    query += ' AND status_code = ?';
    params.push(filters.statusCode);
  }
  if (filters.crawlStatus) {
    query += ' AND crawl_status = ?';
    params.push(filters.crawlStatus);
  }

  query += ' ORDER BY score ASC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  return queryAll(query, params);
}

function getPageById(id) {
  return queryOne('SELECT * FROM pages WHERE id = ?', [id]);
}

function getSessionStats(sessionId) {
  const stats = queryOne(`
    SELECT 
      COUNT(*) as total_pages,
      COUNT(CASE WHEN crawl_status = 'done' THEN 1 END) as crawled,
      COUNT(CASE WHEN crawl_status = 'error' THEN 1 END) as errors,
      COUNT(CASE WHEN crawl_status = 'pending' THEN 1 END) as pending,
      AVG(CASE WHEN crawl_status = 'done' THEN score END) as avg_score,
      COUNT(DISTINCT domain) as domains,
      COUNT(DISTINCT subdomain) as subdomains,
      COUNT(CASE WHEN is_redirect = 1 THEN 1 END) as redirects,
      COUNT(CASE WHEN status_code >= 400 THEN 1 END) as broken,
      COUNT(CASE WHEN issues LIKE '%missing_meta%' THEN 1 END) as missing_meta,
      COUNT(CASE WHEN issues LIKE '%missing_title%' THEN 1 END) as missing_title,
      COUNT(CASE WHEN issues LIKE '%missing_h1%' THEN 1 END) as missing_h1,
      COUNT(CASE WHEN issues LIKE '%missing_schema%' THEN 1 END) as missing_schema,
      COUNT(CASE WHEN issues LIKE '%weak_content%' OR issues LIKE '%thin_content%' THEN 1 END) as weak_content,
      COUNT(CASE WHEN issues LIKE '%missing_canonical%' THEN 1 END) as missing_canonical,
      AVG(CASE WHEN crawl_status = 'done' THEN load_time_ms END) as avg_load_time
    FROM pages WHERE session_id = ?
  `, [sessionId]);

  return stats;
}

function getIssueSummary(sessionId) {
  const pages = queryAll(
    `SELECT issues FROM pages WHERE session_id = ? AND crawl_status = 'done'`,
    [sessionId]
  );

  const issueCount = {};
  for (const page of pages) {
    try {
      const issues = JSON.parse(page.issues || '[]');
      for (const issue of issues) {
        const type = issue.type || 'unknown';
        issueCount[type] = (issueCount[type] || 0) + 1;
      }
    } catch (e) { /* skip */ }
  }

  return issueCount;
}

module.exports = {
  getDbPromise,
  getDb,
  initSchema,
  createSession,
  updateSession,
  getSession,
  getLatestSession,
  getAllSessions,
  insertPage,
  updatePage,
  getPendingPages,
  getPagesBySession,
  getPageById,
  getSessionStats,
  getIssueSummary
};
