const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./src/database');
const { startCrawl, getCrawlState } = require('./src/crawler');
const { generateCSV, generatePDF } = require('./src/exporter');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// API Routes
// ============================================================

// --- Sessions ---

app.get('/api/sessions', (req, res) => {
  try {
    const sessions = db.getAllSessions();
    res.json({ success: true, data: sessions });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/sessions/latest', (req, res) => {
  try {
    const session = db.getLatestSession();
    if (!session) return res.json({ success: true, data: null });
    
    const stats = db.getSessionStats(session.id);
    const issues = db.getIssueSummary(session.id);
    res.json({ success: true, data: { ...session, stats, issues } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  try {
    const session = db.getSession(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    
    const stats = db.getSessionStats(session.id);
    const issues = db.getIssueSummary(session.id);
    res.json({ success: true, data: { ...session, stats, issues } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Crawl ---

app.post('/api/crawl', (req, res) => {
  const { url, maxPages, batchSize, delayMs } = req.body;
  const targetUrl = url || 'https://theddcgroup.com/';

  startCrawl(targetUrl, { maxPages, batchSize, delayMs })
    .catch(e => console.error('[API] Crawl error:', e.message));

  res.json({ 
    success: true, 
    message: 'Crawl started',
    targetUrl 
  });
});

app.get('/api/crawl/status/:sessionId', (req, res) => {
  const state = getCrawlState(req.params.sessionId);
  if (!state) {
    const session = db.getSession(req.params.sessionId);
    if (session) {
      const stats = db.getSessionStats(session.id);
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

app.get('/api/pages/:sessionId', (req, res) => {
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

    const pages = db.getPagesBySession(req.params.sessionId, filters);
    res.json({ success: true, data: pages, total: pages.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/page/:id', (req, res) => {
  try {
    const page = db.getPageById(parseInt(req.params.id));
    if (!page) return res.status(404).json({ success: false, error: 'Page not found' });
    
    // Parse JSON fields
    try { page.issues = JSON.parse(page.issues || '[]'); } catch (e) { page.issues = []; }
    try { page.score_breakdown = JSON.parse(page.score_breakdown || '{}'); } catch (e) { page.score_breakdown = {}; }
    try { page.schema_json = JSON.parse(page.schema_json || 'null'); } catch (e) { page.schema_json = null; }
    try { page.og_tags = JSON.parse(page.og_tags || 'null'); } catch (e) { page.og_tags = null; }
    try { page.redirect_chain = JSON.parse(page.redirect_chain || 'null'); } catch (e) { page.redirect_chain = null; }

    res.json({ success: true, data: page });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Stats ---
app.get('/api/stats/:sessionId', (req, res) => {
  try {
    const stats = db.getSessionStats(req.params.sessionId);
    const issues = db.getIssueSummary(req.params.sessionId);
    res.json({ success: true, data: { ...stats, issues } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Export ---

app.get('/api/export/csv/:sessionId', (req, res) => {
  try {
    const csv = generateCSV(req.params.sessionId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=seo-audit-${req.params.sessionId.slice(0, 8)}.csv`);
    res.send(csv);
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

// Initialize database before handling requests.
async function initDb() {
  await db.getDbPromise();
  console.log('✅ Database initialized');
}

if (require.main === module) {
  // When running locally with `node server.js`, start the Express server normally.
  initDb()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`\n🚀 SEO Audit Server running at http://localhost:${PORT}\n`);
      });
    })
    .catch(e => {
      console.error('Failed to start server:', e);
      process.exit(1);
    });
} else {
  // When deployed as a Vercel serverless function, export the app.
  initDb().catch(e => {
    console.error('Failed to initialize database:', e);
  });
}

module.exports = app;
