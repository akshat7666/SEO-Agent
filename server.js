const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./src/database');
const { startCrawl, getCrawlState, processOneBatch } = require('./src/crawler');
const { generateCSV, generatePDF } = require('./src/exporter');

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ DB INIT (ONLY ONCE)
let dbInitialized = false;

async function initDatabase() {
  if (!dbInitialized) {
    console.log("⏳ Initializing DB...");
    await db.getDbPromise();
    console.log("✅ DB initialized");
    dbInitialized = true;
  }
}

// ✅ MIDDLEWARE
app.use(cors());
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await initDatabase();
    res.json({
      success: true,
      status: 'ok',
      service: 'seo-agent',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'error',
      error: error.message
    });
  }
});

// ✅ Ensure DB before every request
app.use(async (req, res, next) => {
  try {
    await initDatabase();
    next();
  } catch (e) {
    console.error("DB ERROR:", e);
    res.status(500).json({
      success: false,
      error: "Database failed to initialize"
    });
  }
});

// ✅ STATIC FILES
app.use(express.static(path.join(__dirname, 'public')));

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ============================================================
// API ROUTES
// ============================================================

// --- Sessions ---
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await db.getAllSessions();
    res.json({ success: true, data: sessions });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/sessions/latest', async (req, res) => {
  try {
    const session = await db.getLatestSession();
    if (!session) {
      return res.json({ success: true, data: null });
    }

    // Process one page per poll to keep work incremental and predictable.
    if (session.status === 'running') {
      try {
        await processOneBatch(session.id);
      } catch (e) {
        console.error('[API] Polling process error:', e.message);
      }
    }

    const stats = await db.getSessionStats(session.id);
    const issues = await db.getIssueSummary(session.id);

    res.json({
      success: true,
      data: {
        ...session,
        stats,
        issues
      }
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await db.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.status === 'running') {
      try {
        await processOneBatch(session.id);
      } catch (e) {
        console.error('[API] Session process error:', e.message);
      }
    }

    const stats = await db.getSessionStats(session.id);
    const issues = await db.getIssueSummary(session.id);

    res.json({ success: true, data: { ...session, stats, issues } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Crawl ---
app.post('/api/crawl', async (req, res) => {
  const { url, maxPages, batchSize, delayMs } = req.body;
  const targetUrl = url || 'https://theddcgroup.com/';
  const { v4: uuidv4 } = require('uuid');
  const sessionId = uuidv4();

  // Create the session before background work begins so the frontend can poll immediately.
  await db.createSession(sessionId, targetUrl);

  // Run async crawler in background
  startCrawl(targetUrl, sessionId, { maxPages, batchSize, delayMs })
    .catch(e => console.error('[API] Crawl error:', e.message));

  res.json({
    success: true,
    message: 'Crawl started',
    sessionId,
    targetUrl
  });
});

app.get('/api/crawl/status/:sessionId', async (req, res) => {
  const state = getCrawlState(req.params.sessionId);

  if (!state) {
    const session = await db.getSession(req.params.sessionId);

    if (session) {
      const stats = await db.getSessionStats(session.id);

      return res.json({
        success: true,
        data: {
          status: session.status,
          phase: 'done',
          ...stats
        }
      });
    }

    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  res.json({ success: true, data: state });
});

// --- Pages ---
app.get('/api/pages/:sessionId', async (req, res) => {
  try {
    const filters = {
      domain: req.query.domain || undefined,
      subdomain: req.query.subdomain || undefined,
      minScore: req.query.minScore ? parseInt(req.query.minScore) : undefined,
      maxScore: req.query.maxScore ? parseInt(req.query.maxScore) : undefined,
      issueType: req.query.issueType || undefined,
      statusCode: req.query.statusCode ? parseInt(req.query.statusCode) : undefined,
      crawlStatus: req.query.crawlStatus || 'done',
      limit: req.query.limit ? parseInt(req.query.limit) : undefined
    };

    const pages = await db.getPagesBySession(req.params.sessionId, filters);

    res.json({ success: true, data: pages, total: pages.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/page/:id', async (req, res) => {
  try {
    const page = await db.getPageById(parseInt(req.params.id));

    if (!page) {
      return res.status(404).json({ success: false, error: 'Page not found' });
    }

    try { page.issues = JSON.parse(page.issues || '[]'); } catch {}
    try { page.score_breakdown = JSON.parse(page.score_breakdown || '{}'); } catch {}
    try { page.schema_json = JSON.parse(page.schema_json || 'null'); } catch {}
    try { page.og_tags = JSON.parse(page.og_tags || 'null'); } catch {}
    try { page.redirect_chain = JSON.parse(page.redirect_chain || 'null'); } catch {}

    res.json({ success: true, data: page });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Stats ---
app.get('/api/stats/:sessionId', async (req, res) => {
  try {
    const stats = await db.getSessionStats(req.params.sessionId);
    const issues = await db.getIssueSummary(req.params.sessionId);

    res.json({ success: true, data: { ...stats, issues } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Export ---
app.get('/api/export/csv/:sessionId', (req, res) => {
  try {
    generateCSV(req.params.sessionId).then((csv) => {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=seo-audit-${req.params.sessionId.slice(0, 8)}.csv`);
      res.send(csv);
    }).catch((e) => {
      res.status(500).json({ success: false, error: e.message });
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/export/pdf/:sessionId', async (req, res) => {
  try {
    const pdf = await generatePDF(req.params.sessionId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=seo-audit-${req.params.sessionId.slice(0, 8)}.pdf`);

    res.send(pdf);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- SPA fallback ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SEO Agent server listening on port ${PORT}`);
  });
}

module.exports = app;
