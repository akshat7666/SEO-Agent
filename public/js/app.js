// ============================================================
// SEO & AEO Audit Dashboard — Frontend Application
// ============================================================

const API = '';
let currentSessionId = null;
let currentFilter = null;
let allPages = [];
let pollTimer = null;

// ============================================================
// Initialization
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  loadLatestSession();
});

function initEventListeners() {
  // Start crawl buttons
  document.getElementById('btnStartCrawl').addEventListener('click', startAudit);
  document.getElementById('btnStartCrawlWelcome').addEventListener('click', startAudit);

  // Sync URL inputs
  document.getElementById('headerUrlInput').addEventListener('input', (e) => {
    document.getElementById('welcomeUrlInput').value = e.target.value;
  });
  document.getElementById('welcomeUrlInput').addEventListener('input', (e) => {
    document.getElementById('headerUrlInput').value = e.target.value;
  });

  // Export buttons
  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
  document.getElementById('btnExportPDF').addEventListener('click', exportPDF);

  // Inspector close
  document.getElementById('inspectorClose').addEventListener('click', closeInspector);
  document.getElementById('inspectorOverlay').addEventListener('click', closeInspector);

  // Search input
  document.getElementById('searchInput').addEventListener('input', debounce(onSearch, 300));

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeInspector();
  });

  // Enter key on URL inputs
  document.getElementById('headerUrlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startAudit();
  });
  document.getElementById('welcomeUrlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startAudit();
  });
}

// ============================================================
// Session Management
// ============================================================

async function loadLatestSession() {
  try {
    const resp = await fetch(`${API}/api/sessions/latest`);
    const json = await resp.json();

    if (json.success && json.data) {
      currentSessionId = json.data.id;

      // Update URL inputs with the session's target URL
      if (json.data.target_url) {
        document.getElementById('headerUrlInput').value = json.data.target_url;
        document.getElementById('welcomeUrlInput').value = json.data.target_url;
        try {
          document.title = `SEO Audit | ${new URL(json.data.target_url).hostname}`;
        } catch(e) {}
      }

      if (json.data.status === 'running') {
        showProgress();
        startPolling();
      } else {
        await loadDashboard(json.data);
      }
    } else {
      showWelcome();
    }
  } catch (e) {
    console.error('Failed to load session:', e);
    showWelcome();
  }
}

async function loadDashboard(sessionData) {
  hideWelcome();
  hideProgress();
  showDashboard();

  // Stats
  const stats = sessionData.stats || {};
  updateStats(stats);

  // Issues grid
  const issues = sessionData.issues || {};
  renderIssueCards(issues, stats);

  // Load pages
  await loadPages();

  // Score distribution
  renderScoreDistribution(allPages);

  // Show export buttons
  document.getElementById('btnExportCSV').style.display = '';
  document.getElementById('btnExportPDF').style.display = '';
}

// ============================================================
// Start Audit
// ============================================================

async function startAudit() {
  // Get URL from whichever input has focus or is visible
  const headerInput = document.getElementById('headerUrlInput');
  const welcomeInput = document.getElementById('welcomeUrlInput');
  let targetUrl = (headerInput.value || welcomeInput.value || '').trim();

  if (!targetUrl) {
    showToast('Please enter a URL to audit', 'error');
    return;
  }

  // Add protocol if missing
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  // Add trailing slash if missing
  if (!targetUrl.endsWith('/')) targetUrl += '/';

  // Sync inputs  
  headerInput.value = targetUrl;
  welcomeInput.value = targetUrl;

  const btn = document.getElementById('btnStartCrawl');
  btn.disabled = true;
  btn.textContent = '⏳ Starting...';

  try {
    const resp = await fetch(`${API}/api/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetUrl,
        maxPages: 500,
        batchSize: 5,
        delayMs: 1500
      })
    });

    const json = await resp.json();
    if (json.success) {
      showToast(`Audit started for ${new URL(targetUrl).hostname}!`, 'success');
      document.title = `SEO Audit | ${new URL(targetUrl).hostname}`;
      showProgress();
      hideWelcome();

      // Wait a moment then start polling
      setTimeout(() => {
        loadLatestSession();
        startPolling();
      }, 2000);
    } else {
      showToast('Failed to start audit: ' + json.error, 'error');
    }
  } catch (e) {
    showToast('Error connecting to server', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Start Audit';
  }
}

// ============================================================
// Polling for Progress
// ============================================================

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollProgress, 3000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollProgress() {
  try {
    const resp = await fetch(`${API}/api/sessions/latest`);
    const json = await resp.json();

    if (!json.success || !json.data) return;

    const session = json.data;
    currentSessionId = session.id;

    if (session.status === 'running') {
      const stats = session.stats || {};
      const total = stats.total_pages || 1;
      const crawled = stats.crawled || 0;
      const pct = Math.round((crawled / total) * 100);

      document.getElementById('progressTitle').textContent = 'Auditing Pages...';
      document.getElementById('progressPhase').textContent =
        crawled === 0 ? '🔍 Discovering URLs...' : `📊 Extracting SEO data (${crawled}/${total})`;
      document.getElementById('progressBar').style.width = pct + '%';
      document.getElementById('progressStats').textContent =
        `${crawled} of ${total} pages crawled • ${stats.errors || 0} errors`;

    } else if (session.status === 'completed') {
      stopPolling();
      showToast('🎉 Audit complete!', 'success');
      await loadDashboard(session);
    } else if (session.status === 'error') {
      stopPolling();
      showToast('Audit encountered an error', 'error');
      hideProgress();
    }
  } catch (e) {
    console.error('Poll error:', e);
  }
}

// ============================================================
// Stats Display
// ============================================================

function updateStats(stats) {
  const total = stats.total_pages || 0;
  const crawled = stats.crawled || 0;
  const avg = Math.round(stats.avg_score || 0);

  document.getElementById('statTotalPages').textContent = total;
  document.getElementById('statPagesDetail').textContent = `${crawled} crawled`;

  const avgEl = document.getElementById('statAvgScore');
  avgEl.textContent = avg;
  avgEl.className = 'stat-value ' + (avg >= 80 ? 'success' : avg >= 60 ? 'warning' : 'error');

  document.getElementById('statScoreBand').textContent =
    avg >= 80 ? '✅ Strong' : avg >= 60 ? '⚡ Average' : '⚠️ Needs Work';

  const critical = (stats.missing_title || 0) + (stats.missing_meta || 0) +
    (stats.missing_h1 || 0) + (stats.broken || 0);
  document.getElementById('statCritical').textContent = critical;

  document.getElementById('statSubdomains').textContent = stats.subdomains || 0;
  document.getElementById('statDomainsDetail').textContent =
    `${stats.domains || 0} domain(s) detected`;

  document.getElementById('statRedirects').textContent = stats.redirects || 0;

  const avgLoad = stats.avg_load_time || 0;
  document.getElementById('statLoadTime').textContent =
    avgLoad > 0 ? (avgLoad / 1000).toFixed(1) + 's' : '—';
}

// ============================================================
// Issues Cards
// ============================================================

function renderIssueCards(issues, stats) {
  const grid = document.getElementById('issuesGrid');
  grid.innerHTML = '';

  const issueConfig = [
    { type: 'missing_meta', label: 'Missing Meta Description', icon: '📝', severity: 'error', count: stats.missing_meta || 0 },
    { type: 'missing_title', label: 'Missing Title', icon: '🏷️', severity: 'error', count: stats.missing_title || 0 },
    { type: 'missing_h1', label: 'Missing H1', icon: '📌', severity: 'error', count: stats.missing_h1 || 0 },
    { type: 'missing_canonical', label: 'Missing Canonical', icon: '🔗', severity: 'error', count: stats.missing_canonical || 0 },
    { type: 'weak_content', label: 'Weak Content', icon: '📄', severity: 'warning', count: stats.weak_content || 0 },
    { type: 'missing_schema', label: 'Missing Schema', icon: '🧩', severity: 'warning', count: stats.missing_schema || 0 },
    { type: 'redirect', label: 'Redirects', icon: '↩️', severity: 'warning', count: stats.redirects || 0 },
    { type: 'client_error', label: 'Broken Pages', icon: '💥', severity: 'error', count: stats.broken || 0 },
  ];

  for (const item of issueConfig) {
    if (item.count === 0 && item.type !== 'redirect') continue;

    const card = document.createElement('div');
    card.className = `issue-card severity-${item.severity}`;
    card.dataset.issueType = item.type;
    card.innerHTML = `
      <div class="issue-icon ${item.severity}">${item.icon}</div>
      <div class="issue-info">
        <div class="issue-name">${item.label}</div>
        <div class="issue-count">${item.count}</div>
      </div>
    `;
    card.addEventListener('click', () => toggleIssueFilter(item.type, card));
    grid.appendChild(card);
  }
}

function toggleIssueFilter(issueType, cardEl) {
  const cards = document.querySelectorAll('.issue-card');

  if (currentFilter === issueType) {
    // Remove filter
    currentFilter = null;
    cards.forEach(c => c.classList.remove('active'));
    document.getElementById('activeFilters').innerHTML = '';
    renderTable(allPages);
  } else {
    // Apply filter
    currentFilter = issueType;
    cards.forEach(c => c.classList.remove('active'));
    cardEl.classList.add('active');

    const label = cardEl.querySelector('.issue-name').textContent;
    document.getElementById('activeFilters').innerHTML = `
      <span class="filter-badge">
        ${label}
        <span class="close" onclick="clearFilter()">✕</span>
      </span>
    `;

    const filtered = allPages.filter(p => {
      try {
        const issues = typeof p.issues === 'string' ? JSON.parse(p.issues) : (p.issues || []);
        return issues.some(i => i.type === issueType);
      } catch (e) { return false; }
    });
    renderTable(filtered);
  }
}

// Global function for inline onclick
window.clearFilter = function () {
  currentFilter = null;
  document.querySelectorAll('.issue-card').forEach(c => c.classList.remove('active'));
  document.getElementById('activeFilters').innerHTML = '';
  renderTable(allPages);
};

// ============================================================
// Pages Table
// ============================================================

async function loadPages() {
  if (!currentSessionId) return;

  try {
    const resp = await fetch(`${API}/api/pages/${currentSessionId}?crawlStatus=done`);
    const json = await resp.json();

    if (json.success) {
      allPages = json.data;
      renderTable(allPages);
    }
  } catch (e) {
    console.error('Failed to load pages:', e);
  }
}

function renderTable(pages) {
  const tbody = document.getElementById('tableBody');
  const countEl = document.getElementById('tableCount');

  countEl.textContent = `(${pages.length} pages)`;

  if (pages.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="table-empty">
          <div class="icon">🔍</div>
          <div>No pages match the current filter.</div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = pages.map(page => {
    const score = page.score || 0;
    const scoreBand = score >= 80 ? 'strong' : score >= 60 ? 'average' : 'weak';

    const status = page.status_code || 0;
    let statusClass = 'ok';
    if (status >= 300 && status < 400) statusClass = 'redirect';
    if (status >= 400) statusClass = 'error';

    let issues = [];
    try { issues = typeof page.issues === 'string' ? JSON.parse(page.issues) : (page.issues || []); } catch (e) {}

    const issuesPills = issues.slice(0, 3).map(i => {
      const label = i.type.replace(/_/g, ' ').replace('missing ', '').replace('weak ', '').replace('thin ', '');
      return `<span class="issue-pill ${i.severity}">${label}</span>`;
    }).join('');

    const displayUrl = (page.original_url || '').replace(/^https?:\/\/(www\.)?/, '');
    const domain = page.subdomain ? `${page.subdomain}.${page.domain}` : page.domain || '';

    return `
      <tr onclick="openInspector(${page.id})" data-id="${page.id}">
        <td class="url-cell" title="${page.original_url}">${displayUrl}</td>
        <td style="font-size:0.78rem;color:var(--text-muted);">${domain}</td>
        <td><span class="score-badge ${scoreBand}">${score}</span></td>
        <td><span class="status-badge ${statusClass}">${status}</span></td>
        <td><div class="issues-pills">${issuesPills}${issues.length > 3 ? `<span class="issue-pill warning">+${issues.length - 3}</span>` : ''}</div></td>
        <td style="font-size:0.82rem;color:var(--text-secondary);">${page.word_count || 0}</td>
        <td style="font-size:0.82rem;color:var(--text-secondary);">${page.load_time_ms ? (page.load_time_ms / 1000).toFixed(1) + 's' : '—'}</td>
      </tr>
    `;
  }).join('');
}

function onSearch(e) {
  const query = e.target.value.toLowerCase().trim();
  if (!query) {
    renderTable(currentFilter ? allPages.filter(p => {
      try {
        const issues = typeof p.issues === 'string' ? JSON.parse(p.issues) : (p.issues || []);
        return issues.some(i => i.type === currentFilter);
      } catch (e) { return false; }
    }) : allPages);
    return;
  }

  const filtered = allPages.filter(p =>
    (p.original_url || '').toLowerCase().includes(query) ||
    (p.title || '').toLowerCase().includes(query) ||
    (p.domain || '').toLowerCase().includes(query)
  );

  renderTable(filtered);
}

// ============================================================
// Inspector Panel
// ============================================================

window.openInspector = async function (pageId) {
  try {
    const resp = await fetch(`${API}/api/page/${pageId}`);
    const json = await resp.json();

    if (!json.success) {
      showToast('Failed to load page details', 'error');
      return;
    }

    const page = json.data;
    renderInspector(page);

    document.getElementById('inspectorOverlay').classList.add('open');
    document.getElementById('inspectorPanel').classList.add('open');
    document.body.style.overflow = 'hidden';

    // Highlight table row
    document.querySelectorAll('.data-table tbody tr').forEach(tr => tr.classList.remove('selected'));
    const row = document.querySelector(`tr[data-id="${pageId}"]`);
    if (row) row.classList.add('selected');

  } catch (e) {
    console.error('Inspector error:', e);
    showToast('Error loading inspector', 'error');
  }
};

function renderInspector(page) {
  const body = document.getElementById('inspectorBody');
  const score = page.score || 0;
  const scoreColor = score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--warning)' : 'var(--error)';
  const scoreBand = score >= 80 ? 'Strong' : score >= 60 ? 'Average' : 'Weak';

  // Score ring
  const circumference = 2 * Math.PI * 48;
  const dashoffset = circumference - (score / 100) * circumference;

  // Breakdown
  const breakdown = page.score_breakdown || {};
  const maxScores = { title: 10, meta: 10, h1: 10, content: 20, links: 10, schema: 10, performance: 10, url: 10, freshness: 10 };

  let breakdownHTML = '';
  for (const [key, val] of Object.entries(breakdown)) {
    const max = maxScores[key] || 10;
    const pct = (val / max) * 100;
    const barClass = pct >= 80 ? '' : pct >= 50 ? 'mid' : 'low';
    breakdownHTML += `
      <div class="breakdown-row">
        <div class="breakdown-label">${key}</div>
        <div class="breakdown-bar">
          <div class="breakdown-bar-fill ${barClass}" style="width: ${pct}%"></div>
        </div>
        <div class="breakdown-score">${val}/${max}</div>
      </div>
    `;
  }

  // Issues
  const issues = Array.isArray(page.issues) ? page.issues : [];
  let issuesHTML = '';
  for (const issue of issues) {
    issuesHTML += `
      <div class="inspector-issue-item severity-${issue.severity}">
        <div class="inspector-issue-header">
          <span class="inspector-issue-severity ${issue.severity}">${issue.severity}</span>
          <span style="font-size:0.75rem;color:var(--text-muted);">${issue.field}</span>
        </div>
        <div class="inspector-issue-msg">${issue.message}</div>
        ${issue.suggestion ? `<div class="inspector-issue-fix">${issue.suggestion}</div>` : ''}
      </div>
    `;
  }

  // Schema info
  let schemaHTML = '<span style="color:var(--text-muted);">None</span>';
  if (page.schema_json && Array.isArray(page.schema_json) && page.schema_json.length > 0) {
    const types = page.schema_json.map(s => s['@type'] || 'Unknown').flat();
    schemaHTML = types.map(t => `<span class="issue-pill" style="background:var(--info-bg);color:var(--info);">${t}</span>`).join(' ');
  }

  // OG tags
  let ogHTML = '<span style="color:var(--text-muted);">None</span>';
  if (page.og_tags && typeof page.og_tags === 'object' && Object.keys(page.og_tags).length > 0) {
    ogHTML = Object.entries(page.og_tags).map(([k, v]) =>
      `<div style="font-size:0.78rem;margin-bottom:4px;"><strong style="color:var(--text-muted);">${k}:</strong> ${v.substring(0, 80)}</div>`
    ).join('');
  }

  body.innerHTML = `
    <!-- Score Ring -->
    <div class="inspector-score">
      <div class="score-ring">
        <svg viewBox="0 0 120 120">
          <circle class="bg" cx="60" cy="60" r="48" />
          <circle class="progress" cx="60" cy="60" r="48"
            stroke="${scoreColor}"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${dashoffset}" />
        </svg>
        <div class="score-text" style="color:${scoreColor};">${score}</div>
      </div>
      <div class="inspector-score-label">${scoreBand} • /100</div>
    </div>

    <!-- URL -->
    <div class="inspector-url">
      <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px;">Original URL</div>
      <a href="${page.original_url}" target="_blank" style="color:var(--accent-primary-hover);text-decoration:none;">
        ${page.original_url}
      </a>
      ${page.final_url && page.final_url !== page.original_url ? `
        <div style="font-size:0.7rem;color:var(--text-muted);margin-top:8px;">Final URL (after redirect)</div>
        <a href="${page.final_url}" target="_blank" style="color:var(--warning);text-decoration:none;font-size:0.82rem;">
          ${page.final_url}
        </a>
      ` : ''}
    </div>

    <!-- Score Breakdown -->
    <div class="inspector-section">
      <div class="inspector-section-title">Score Breakdown</div>
      <div class="score-breakdown">${breakdownHTML}</div>
    </div>

    <!-- Extracted Values -->
    <div class="inspector-section">
      <div class="inspector-section-title">Extracted SEO Data</div>
      <div class="inspector-field">
        <span class="field-label">Title</span>
        <span class="field-value ${page.title ? 'valid' : 'error'}">
          ${page.title || '⚠️ Missing'}
          ${page.title ? `<br><small style="color:var(--text-muted);">${page.title_length} chars</small>` : ''}
        </span>
      </div>
      <div class="inspector-field">
        <span class="field-label">Meta Description</span>
        <span class="field-value ${page.meta_description ? 'valid' : 'error'}">
          ${page.meta_description ? page.meta_description.substring(0, 120) + (page.meta_description.length > 120 ? '...' : '') : '⚠️ Missing'}
          ${page.meta_description ? `<br><small style="color:var(--text-muted);">${page.meta_description_length} chars</small>` : ''}
        </span>
      </div>
      <div class="inspector-field">
        <span class="field-label">H1</span>
        <span class="field-value ${page.h1_text ? (page.h1_count > 1 ? 'warning' : 'valid') : 'error'}">
          ${page.h1_text || '⚠️ Missing'}
          ${page.h1_count > 1 ? `<br><small style="color:var(--warning);">${page.h1_count} H1 tags found</small>` : ''}
        </span>
      </div>
      <div class="inspector-field">
        <span class="field-label">Canonical</span>
        <span class="field-value ${page.canonical_url ? 'valid' : 'error'}">
          ${page.canonical_url || '⚠️ Missing'}
        </span>
      </div>
      <div class="inspector-field">
        <span class="field-label">Word Count</span>
        <span class="field-value ${(page.word_count || 0) >= 300 ? 'valid' : (page.word_count || 0) >= 100 ? 'warning' : 'error'}">
          ${page.word_count || 0} words
        </span>
      </div>
      <div class="inspector-field">
        <span class="field-label">Status Code</span>
        <span class="field-value ${(page.status_code || 0) === 200 ? 'valid' : (page.status_code || 0) < 400 ? 'warning' : 'error'}">
          ${page.status_code || '—'} ${page.is_redirect ? '(redirect)' : ''}
        </span>
      </div>
      <div class="inspector-field">
        <span class="field-label">Load Time</span>
        <span class="field-value ${(page.load_time_ms || 0) <= 3000 ? 'valid' : (page.load_time_ms || 0) <= 5000 ? 'warning' : 'error'}">
          ${page.load_time_ms ? (page.load_time_ms / 1000).toFixed(1) + 's' : '—'}
        </span>
      </div>
      <div class="inspector-field">
        <span class="field-label">Internal Links</span>
        <span class="field-value">${page.internal_links_count || 0}</span>
      </div>
      <div class="inspector-field">
        <span class="field-label">External Links</span>
        <span class="field-value">${page.external_links_count || 0}</span>
      </div>
    </div>

    <!-- Schema -->
    <div class="inspector-section">
      <div class="inspector-section-title">Structured Data (Schema)</div>
      <div style="padding: 8px 0;">${schemaHTML}</div>
    </div>

    <!-- OG Tags -->
    <div class="inspector-section">
      <div class="inspector-section-title">Open Graph Tags</div>
      <div style="padding: 8px 0;">${ogHTML}</div>
    </div>

    <!-- Issues & Recommendations -->
    ${issues.length > 0 ? `
      <div class="inspector-section">
        <div class="inspector-section-title">Issues & Recommendations (${issues.length})</div>
        <div class="inspector-issues">${issuesHTML}</div>
      </div>
    ` : `
      <div class="inspector-section">
        <div class="inspector-section-title">Issues & Recommendations</div>
        <div style="padding:20px;text-align:center;color:var(--success);">✅ No issues found!</div>
      </div>
    `}
  `;
}

function closeInspector() {
  document.getElementById('inspectorOverlay').classList.remove('open');
  document.getElementById('inspectorPanel').classList.remove('open');
  document.body.style.overflow = '';
  document.querySelectorAll('.data-table tbody tr').forEach(tr => tr.classList.remove('selected'));
}

// ============================================================
// Export
// ============================================================

function exportCSV() {
  if (!currentSessionId) return;
  window.open(`${API}/api/export/csv/${currentSessionId}`, '_blank');
  showToast('CSV download started', 'info');
}

function exportPDF() {
  if (!currentSessionId) return;
  window.open(`${API}/api/export/pdf/${currentSessionId}`, '_blank');
  showToast('PDF report download started', 'info');
}

// ============================================================
// UI State Management
// ============================================================

function showWelcome() {
  document.getElementById('welcomeState').style.display = '';
  document.getElementById('dashboardContent').style.display = 'none';
  document.getElementById('crawlProgress').classList.add('hidden');
}

function hideWelcome() {
  document.getElementById('welcomeState').style.display = 'none';
}

function showProgress() {
  document.getElementById('crawlProgress').classList.remove('hidden');
  document.getElementById('dashboardContent').style.display = 'none';
  document.getElementById('welcomeState').style.display = 'none';
}

function hideProgress() {
  document.getElementById('crawlProgress').classList.add('hidden');
}

function showDashboard() {
  document.getElementById('dashboardContent').style.display = '';
}

// ============================================================
// Toasts
// ============================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ============================================================
// Score Distribution
// ============================================================

function renderScoreDistribution(pages) {
  const strong = pages.filter(p => p.score >= 80).length;
  const average = pages.filter(p => p.score >= 60 && p.score < 80).length;
  const weak = pages.filter(p => p.score < 60).length;
  const total = pages.length || 1;

  // Update band bars
  document.getElementById('distStrong').textContent = strong;
  document.getElementById('distAverage').textContent = average;
  document.getElementById('distWeak').textContent = weak;

  setTimeout(() => {
    document.getElementById('distStrongBar').style.width = (strong / total * 100) + '%';
    document.getElementById('distAverageBar').style.width = (average / total * 100) + '%';
    document.getElementById('distWeakBar').style.width = (weak / total * 100) + '%';
  }, 100);

  // Build histogram (20 buckets of 5 points each)
  const buckets = new Array(20).fill(0);
  for (const page of pages) {
    const idx = Math.min(Math.floor((page.score || 0) / 5), 19);
    buckets[idx]++;
  }

  const maxBucket = Math.max(...buckets, 1);
  const histogram = document.getElementById('scoreHistogram');
  histogram.innerHTML = buckets.map((count, i) => {
    const pct = (count / maxBucket) * 100;
    const scoreRange = `${i * 5}-${i * 5 + 4}`;
    let color;
    if (i * 5 >= 80) color = 'var(--success)';
    else if (i * 5 >= 60) color = 'var(--warning)';
    else color = 'var(--error)';
    return `<div class="histogram-bar" style="height:${Math.max(pct, 2)}%;background:${color};" data-tooltip="${scoreRange}: ${count} pages"></div>`;
  }).join('');
}

// ============================================================
// Utilities
// ============================================================

function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
