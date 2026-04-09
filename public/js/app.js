const API = '';
const MAX_PAGES = 1500;
const SESSION_STORAGE_KEY = 'seoAuditSessionId';
let currentSessionId = null;
let currentFilter = null;
let allPages = [];
let pollTimer = null;
let chartRegistry = {};

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  bootstrapSession();
});

function initEventListeners() {
  document.getElementById('btnStartCrawl').addEventListener('click', startAudit);
  document.getElementById('btnStartCrawlWelcome').addEventListener('click', startAudit);
  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
  document.getElementById('btnExportPDF').addEventListener('click', exportPDF);
  document.getElementById('searchInput').addEventListener('input', debounce(onSearch, 200));
  document.getElementById('inspectorClose').addEventListener('click', closeInspector);
  document.getElementById('inspectorOverlay').addEventListener('click', closeInspector);

  syncInputs('headerUrlInput', 'welcomeUrlInput');
  syncInputs('welcomeUrlInput', 'headerUrlInput');

  document.getElementById('headerUrlInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') startAudit();
  });
  document.getElementById('welcomeUrlInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') startAudit();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeInspector();
  });
}

function syncInputs(sourceId, targetId) {
  document.getElementById(sourceId).addEventListener('input', (event) => {
    document.getElementById(targetId).value = event.target.value;
  });
}

function parseIssues(rawIssues) {
  if (!rawIssues) return [];
  if (Array.isArray(rawIssues)) return rawIssues;
  try {
    const parsed = typeof rawIssues === 'string' ? JSON.parse(rawIssues) : rawIssues;
    return Array.isArray(parsed) ? parsed : Object.values(parsed || {});
  } catch (error) {
    return [];
  }
}

function scoreBand(score) {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'average';
  return 'weak';
}

async function loadLatestSession() {
  try {
    const response = await fetch(`${API}/api/sessions/latest`);
    const json = await response.json();

    if (!json.success || !json.data) {
      showWelcome();
      return;
    }

    const session = json.data;
    pinSession(session.id);
    setUrlInputs(session.target_url || '');

    if (session.status === 'running') {
      showProgress();
      updateProgress(session);
      startPolling();
      return;
    }

    stopPolling();
    await loadDashboard(session);
  } catch (error) {
    console.error('Failed to load latest session', error);
    showWelcome();
  }
}

async function bootstrapSession() {
  const preferredSessionId = getPreferredSessionId();
  if (preferredSessionId) {
    const loaded = await loadSessionById(preferredSessionId);
    if (loaded) return;
    clearPinnedSession();
  }

  await loadLatestSession();
}

function getPreferredSessionId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('sessionId') || localStorage.getItem(SESSION_STORAGE_KEY) || null;
}

function pinSession(sessionId) {
  if (!sessionId) return;
  currentSessionId = sessionId;
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);

  const url = new URL(window.location.href);
  url.searchParams.set('sessionId', sessionId);
  window.history.replaceState({}, '', url.toString());
}

function clearPinnedSession() {
  currentSessionId = null;
  localStorage.removeItem(SESSION_STORAGE_KEY);

  const url = new URL(window.location.href);
  url.searchParams.delete('sessionId');
  window.history.replaceState({}, '', url.toString());
}

async function loadSessionById(sessionId) {
  try {
    const response = await fetch(`${API}/api/sessions/${sessionId}`);
    if (response.status === 404) return false;

    const json = await response.json();
    if (!json.success || !json.data) return false;

    const session = json.data;
    pinSession(session.id);
    setUrlInputs(session.target_url || '');

    if (session.status === 'running') {
      showProgress();
      updateProgress(session);
      startPolling();
      return true;
    }

    stopPolling();
    await loadDashboard(session);
    return true;
  } catch (error) {
    console.error('Failed to load session by id', error);
    return false;
  }
}

function setUrlInputs(value) {
  document.getElementById('headerUrlInput').value = value;
  document.getElementById('welcomeUrlInput').value = value;
}

async function startAudit() {
  const rawValue = (document.getElementById('headerUrlInput').value || document.getElementById('welcomeUrlInput').value || '').trim();
  if (!rawValue) {
    showToast('Enter a URL before starting the audit.', 'error');
    return;
  }

  let targetUrl = rawValue;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `https://${targetUrl}`;
  }

  setUrlInputs(targetUrl);
  document.getElementById('btnStartCrawl').disabled = true;

  try {
    const response = await fetch(`${API}/api/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetUrl,
        maxPages: MAX_PAGES,
        discoveryConcurrency: 4,
        crawlConcurrency: 3,
        retries: 2
      })
    });

    const json = await response.json();
    if (!json.success) {
      showToast(json.error || 'Audit could not be started.', 'error');
      return;
    }

    pinSession(json.sessionId);
    showProgress();
    startPolling();
    showToast('Audit started successfully.', 'success');
  } catch (error) {
    showToast('Could not reach the server to start the audit.', 'error');
  } finally {
    document.getElementById('btnStartCrawl').disabled = false;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollProgress, 3000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollProgress() {
  if (!currentSessionId) return;

  try {
    const response = await fetch(`${API}/api/sessions/${currentSessionId}`);
    const json = await response.json();
    if (!json.success || !json.data) return;

    if (json.data.status === 'running') {
      updateProgress(json.data);
      return;
    }

    stopPolling();
    await loadDashboard(json.data);
    showToast('Audit completed.', 'success');
  } catch (error) {
    console.error('Polling error', error);
  }
}

function updateProgress(session) {
  const stats = session.stats || {};
  const discovered = session.total_discovered || stats.total_pages || 0;
  const processed = (stats.crawled || 0) + (stats.errors || 0);
  const total = Math.max(1, discovered || stats.total_pages || processed || 1);
  const percent = Math.min(100, Math.round((processed / total) * 100));

  document.getElementById('progressTitle').textContent = session.status === 'running' ? 'Audit in progress' : 'Audit queued';
  document.getElementById('progressPhase').textContent = `Phase: ${session.phase || 'crawling'} | Processing ${processed} of ${total} discovered pages`;
  document.getElementById('progressBar').style.width = `${percent}%`;
  document.getElementById('progressStats').textContent = `${stats.crawled || 0} completed, ${stats.processing || 0} processing, ${stats.pending || 0} pending, ${stats.errors || 0} errors`;
}

async function loadDashboard(session) {
  pinSession(session.id);
  hideWelcome();
  hideProgress();
  showDashboard();

  const stats = session.stats || {};
  updateStats(session, stats);
  renderCoverageSummary(stats);
  renderProgressSummary(session, stats);
  renderIssueCards(session.issues || []);

  await loadPages();
  renderCharts(allPages, session.issues || []);
}

function updateStats(session, stats) {
  const avgScore = Math.round(stats.avg_score || 0);
  const issueCounts = stats.issue_counts || {};
  const criticalIssues = (issueCounts.missing_title || 0) + (issueCounts.missing_meta || 0) + (issueCounts.client_error || 0) + (issueCounts.server_error || 0) + (issueCounts.broken_internal_links || 0);

  document.getElementById('statTotalPages').textContent = stats.total_pages || 0;
  document.getElementById('statPagesDetail').textContent = `${stats.crawled || 0} crawled | ${stats.errors || 0} errors`;
  document.getElementById('statAvgScore').textContent = avgScore;
  document.getElementById('statScoreBand').textContent = avgScore >= 80 ? 'Excellent overall health' : avgScore >= 65 ? 'Good with fixes available' : avgScore >= 50 ? 'Mixed quality' : 'Needs strong remediation';
  document.getElementById('statCritical').textContent = criticalIssues;
  document.getElementById('statSubdomains').textContent = stats.subdomains || 0;
  document.getElementById('statDomainsDetail').textContent = `${stats.domains || 0} domains discovered`;
  document.getElementById('statRedirects').textContent = stats.redirects || 0;
  document.getElementById('statLoadTime').textContent = stats.avg_load_time ? `${(stats.avg_load_time / 1000).toFixed(1)}s` : '0.0s';

  const targetHost = safeHostname(session.target_url);
  document.getElementById('sessionMeta').innerHTML = `
    <span class="meta-pill">${targetHost || 'Unknown target'}</span>
    <span class="meta-pill">Session ${session.id.slice(0, 8)}</span>
    <span class="meta-pill">${session.status}</span>
  `;
}

function renderCoverageSummary(stats) {
  const summary = [
    ['Strong pages', stats.strong_pages || 0],
    ['Average pages', stats.average_pages || 0],
    ['Weak pages', stats.weak_pages || 0],
    ['Images missing alt text', stats.images_missing_alt || 0],
    ['Broken internal links', stats.broken_internal_links || 0],
    ['Broken external links', stats.broken_external_links || 0]
  ];

  document.getElementById('coverageSummary').innerHTML = summary.map(([label, value]) => `
    <div class="summary-item">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join('');
}

function renderProgressSummary(session, stats) {
  const summary = [
    ['Status', session.status || 'unknown'],
    ['Discovered URLs', session.total_discovered || stats.total_pages || 0],
    ['Completed pages', stats.crawled || 0],
    ['Pages with errors', stats.errors || 0],
    ['Average load time', stats.avg_load_time ? `${(stats.avg_load_time / 1000).toFixed(1)}s` : '0.0s'],
    ['Completed at', session.completed_at ? new Date(session.completed_at).toLocaleString() : 'Still running']
  ];

  document.getElementById('progressSummary').innerHTML = summary.map(([label, value]) => `
    <div class="summary-item">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join('');
}

function renderIssueCards(issueSummary) {
  const grid = document.getElementById('issuesGrid');
  const items = [...issueSummary].slice(0, 12);

  if (items.length === 0) {
    grid.innerHTML = '<div class="summary-item"><span>No issues were detected in this session.</span><strong>Clean</strong></div>';
    return;
  }

  grid.innerHTML = items.map((issue) => `
    <article class="issue-card ${currentFilter === issue.type ? 'active' : ''}" data-issue-type="${issue.type}">
      <div class="issue-card-header">
        <div class="issue-card-name">${formatIssueLabel(issue.type)}</div>
        <span class="status-badge ${issue.severity === 'error' ? 'error' : 'redirect'}">${issue.severity}</span>
      </div>
      <div class="issue-card-count">${issue.count}</div>
      <div class="issue-card-footer">Impacted pages</div>
    </article>
  `).join('');

  [...grid.querySelectorAll('.issue-card')].forEach((card) => {
    card.addEventListener('click', () => toggleIssueFilter(card.dataset.issueType));
  });
}

function toggleIssueFilter(issueType) {
  currentFilter = currentFilter === issueType ? null : issueType;
  renderIssueCards(buildIssueSummaryFromPages(allPages));
  renderTable(getVisiblePages());
  renderActiveFilters();
}

function renderActiveFilters() {
  const container = document.getElementById('activeFilters');
  if (!currentFilter) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <span class="filter-badge">
      ${formatIssueLabel(currentFilter)}
      <button class="btn-clear-filter" onclick="clearFilter()">x</button>
    </span>
  `;
}

window.clearFilter = function clearFilter() {
  currentFilter = null;
  renderIssueCards(buildIssueSummaryFromPages(allPages));
  renderTable(getVisiblePages());
  renderActiveFilters();
};

async function loadPages() {
  if (!currentSessionId) return;

  const response = await fetch(`${API}/api/pages/${currentSessionId}`);
  const json = await response.json();
  allPages = (json.data || []).map((page) => ({ ...page, issues: parseIssues(page.issues) }));
  renderActiveFilters();
  renderTable(getVisiblePages());
}

function getVisiblePages(searchQuery = document.getElementById('searchInput').value.trim().toLowerCase()) {
  return allPages.filter((page) => {
    const matchesIssue = !currentFilter || page.issues.some((issue) => issue.type === currentFilter);
    const matchesQuery = !searchQuery || [page.original_url, page.title, page.domain, page.subdomain]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(searchQuery));
    return matchesIssue && matchesQuery;
  });
}

function renderTable(pages) {
  const tbody = document.getElementById('tableBody');
  document.getElementById('tableCount').textContent = `${pages.length} pages`;

  if (pages.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="table-empty">No pages match the current search or issue filter.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = pages.map((page) => {
    const statusClass = page.status_code >= 400 ? 'error' : page.status_code >= 300 ? 'redirect' : 'ok';
    const topIssues = page.issues.slice(0, 2).map((issue) => `
      <span class="issue-pill ${issue.severity === 'error' ? 'error' : 'warning'}">${formatIssueLabel(issue.type)}</span>
    `).join('');

    return `
      <tr data-id="${page.id}" onclick="openInspector(${page.id})">
        <td class="url-cell">${escapeHtml(trimProtocol(page.original_url || ''))}</td>
        <td><span class="score-badge ${scoreBand(Number(page.score) || 0)}">${Number(page.score) || 0}</span></td>
        <td><span class="status-badge ${statusClass}">${page.status_code || 'n/a'}</span></td>
        <td>${topIssues || '<span class="issue-pill info">No flagged issues</span>'}</td>
        <td>${page.word_count || 0}</td>
        <td>${page.image_count || 0} / alt miss ${page.images_missing_alt_count || 0}</td>
        <td>${page.load_time_ms ? `${(page.load_time_ms / 1000).toFixed(1)}s` : 'n/a'}</td>
      </tr>
    `;
  }).join('');
}

function buildIssueSummaryFromPages(pages) {
  const map = new Map();

  pages.forEach((page) => {
    page.issues.forEach((issue) => {
      const entry = map.get(issue.type) || { type: issue.type, count: 0, severity: issue.severity || 'warning' };
      entry.count += 1;
      map.set(issue.type, entry);
    });
  });

  return [...map.values()].sort((a, b) => b.count - a.count);
}

function renderCharts(pages, issueSummary) {
  destroyCharts();

  const scoreBuckets = {
    '0-39': 0,
    '40-59': 0,
    '60-79': 0,
    '80-100': 0
  };

  pages.forEach((page) => {
    const score = Number(page.score) || 0;
    if (score < 40) scoreBuckets['0-39'] += 1;
    else if (score < 60) scoreBuckets['40-59'] += 1;
    else if (score < 80) scoreBuckets['60-79'] += 1;
    else scoreBuckets['80-100'] += 1;
  });

  chartRegistry.scoreDistributionChart = new Chart(document.getElementById('scoreDistributionChart'), {
    type: 'bar',
    data: {
      labels: Object.keys(scoreBuckets),
      datasets: [{
        label: 'Pages',
        data: Object.values(scoreBuckets),
        backgroundColor: ['#ef4444', '#ff9f1c', '#6d8dff', '#14b26f'],
        borderRadius: 12
      }]
    },
    options: baseChartOptions()
  });

  const topIssues = [...issueSummary].slice(0, 6);
  chartRegistry.issueBreakdownChart = new Chart(document.getElementById('issueBreakdownChart'), {
    type: 'doughnut',
    data: {
      labels: topIssues.map((issue) => formatIssueLabel(issue.type)),
      datasets: [{
        data: topIssues.map((issue) => issue.count),
        backgroundColor: ['#326dff', '#53a3ff', '#14b26f', '#ff9f1c', '#ef4444', '#8b5cf6']
      }]
    },
    options: {
      ...baseChartOptions(),
      plugins: {
        legend: {
          position: 'bottom'
        }
      }
    }
  });

  const sortedScores = [...pages]
    .filter((page) => page.crawl_status === 'done')
    .sort((a, b) => (Number(a.score) || 0) - (Number(b.score) || 0));

  chartRegistry.pageScoreTrendChart = new Chart(document.getElementById('pageScoreTrendChart'), {
    type: 'line',
    data: {
      labels: sortedScores.map((_, index) => `Page ${index + 1}`),
      datasets: [{
        label: 'SEO score',
        data: sortedScores.map((page) => Number(page.score) || 0),
        borderColor: '#326dff',
        backgroundColor: 'rgba(50, 109, 255, 0.12)',
        fill: true,
        tension: 0.28,
        pointRadius: 2
      }]
    },
    options: baseChartOptions()
  });
}

function baseChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: '#5f6f86',
          font: {
            family: 'Plus Jakarta Sans'
          }
        }
      }
    },
    scales: {
      x: {
        ticks: { color: '#8593a7' },
        grid: { color: '#edf2f8' }
      },
      y: {
        beginAtZero: true,
        ticks: { color: '#8593a7' },
        grid: { color: '#edf2f8' }
      }
    }
  };
}

function destroyCharts() {
  Object.values(chartRegistry).forEach((chart) => chart && chart.destroy());
  chartRegistry = {};
}

window.openInspector = async function openInspector(pageId) {
  try {
    const response = await fetch(`${API}/api/page/${pageId}`);
    const json = await response.json();
    if (!json.success) {
      showToast('Could not load the page inspector.', 'error');
      return;
    }

    renderInspector(json.data);
    document.getElementById('inspectorOverlay').classList.add('open');
    document.getElementById('inspectorPanel').classList.add('open');
    document.querySelectorAll('#tableBody tr').forEach((row) => row.classList.remove('selected'));
    const selected = document.querySelector(`#tableBody tr[data-id="${pageId}"]`);
    if (selected) selected.classList.add('selected');
  } catch (error) {
    showToast('Could not load the page inspector.', 'error');
  }
};

function renderInspector(page) {
  const score = Number(page.score) || 0;
  const issues = parseIssues(page.issues);
  const breakdown = typeof page.score_breakdown === 'string' ? JSON.parse(page.score_breakdown || '{}') : (page.score_breakdown || {});
  const schemaEntries = Array.isArray(page.schema_json) ? page.schema_json : (typeof page.schema_json === 'string' ? JSON.parse(page.schema_json || '[]') : []);
  const ogTags = typeof page.og_tags === 'string' ? JSON.parse(page.og_tags || '{}') : (page.og_tags || {});

  document.getElementById('inspectorBody').innerHTML = `
    <section class="inspector-card inspector-score">
      <div>
        <span class="eyebrow">Page score</span>
        <strong>${score}</strong>
        <p>${score >= 80 ? 'Strong page' : score >= 60 ? 'Moderate page' : 'Needs work'}</p>
      </div>
      <div>
        <span class="status-badge ${page.status_code >= 400 ? 'error' : page.status_code >= 300 ? 'redirect' : 'ok'}">${page.status_code || 'n/a'}</span>
      </div>
    </section>

    <section class="inspector-card">
      <div class="panel-heading">
        <h3>Key details</h3>
      </div>
      <div class="inspector-grid">
        ${inspectorField('URL', escapeHtml(page.original_url || ''), '')}
        ${inspectorField('Final URL', escapeHtml(page.final_url || page.original_url || ''), '')}
        ${inspectorField('Title', escapeHtml(page.title || 'Missing'), page.title ? 'valid' : 'error')}
        ${inspectorField('Meta description', escapeHtml(page.meta_description || 'Missing'), page.meta_description ? 'valid' : 'error')}
        ${inspectorField('Canonical', escapeHtml(page.canonical_url || 'Missing'), page.canonical_url ? 'valid' : 'warning')}
        ${inspectorField('Headings', `H1 ${page.h1_count || 0}, H2 ${page.h2_count || 0}, H3 ${page.h3_count || 0}`, 'valid')}
        ${inspectorField('Content', `${page.word_count || 0} words`, page.word_count >= 300 ? 'valid' : page.word_count >= 100 ? 'warning' : 'error')}
        ${inspectorField('Images', `${page.image_count || 0} total, ${page.images_missing_alt_count || 0} missing alt`, page.images_missing_alt_count > 0 ? 'warning' : 'valid')}
        ${inspectorField('Links', `${page.internal_links_count || 0} internal / ${page.external_links_count || 0} external`, 'valid')}
        ${inspectorField('Broken links', `${page.broken_internal_links_count || 0} internal / ${page.broken_external_links_count || 0} external`, page.broken_internal_links_count > 0 ? 'error' : page.broken_external_links_count > 0 ? 'warning' : 'valid')}
        ${inspectorField('Load time', page.load_time_ms ? `${(page.load_time_ms / 1000).toFixed(1)}s` : 'n/a', page.load_time_ms > 5000 ? 'warning' : 'valid')}
      </div>
    </section>

    <section class="inspector-card">
      <div class="panel-heading">
        <h3>Score breakdown</h3>
      </div>
      <div class="breakdown-list">
        ${Object.entries(breakdown).map(([label, value]) => {
          const scoreValue = Number(value) || 0;
          const percent = Math.max(4, Math.min(100, scoreValue * 8));
          return `
            <div class="breakdown-row">
              <span>${label}</span>
              <div class="breakdown-bar"><div class="breakdown-bar-fill" style="width:${percent}%"></div></div>
              <strong>${scoreValue}</strong>
            </div>
          `;
        }).join('')}
      </div>
    </section>

    <section class="inspector-card">
      <div class="panel-heading">
        <h3>Structured data and Open Graph</h3>
      </div>
      <div class="inspector-grid">
        ${inspectorField('Schema types', schemaEntries.length ? schemaEntries.map((entry) => entry['@type']).flat().filter(Boolean).join(', ') : 'None detected', schemaEntries.length ? 'valid' : 'warning')}
        ${inspectorField('Open Graph fields', Object.keys(ogTags).length ? Object.keys(ogTags).join(', ') : 'None detected', Object.keys(ogTags).length ? 'valid' : 'warning')}
      </div>
    </section>

    <section class="inspector-card">
      <div class="panel-heading">
        <h3>Issues and recommendations</h3>
      </div>
      <div class="inspector-issues">
        ${issues.length ? issues.map((issue) => `
          <article class="inspector-issue-item severity-${issue.severity}">
            <strong>${formatIssueLabel(issue.type)}</strong>
            <p>${escapeHtml(issue.message || '')}</p>
            <small>${escapeHtml(issue.suggestion || '')}</small>
          </article>
        `).join('') : '<article class="inspector-issue-item"><strong>No issues found</strong><p>This page currently has no flagged validation issues.</p></article>'}
      </div>
    </section>
  `;
}

function inspectorField(label, value, valueClass) {
  return `
    <div class="inspector-field">
      <span class="field-label">${label}</span>
      <span class="field-value ${valueClass}">${value}</span>
    </div>
  `;
}

function closeInspector() {
  document.getElementById('inspectorOverlay').classList.remove('open');
  document.getElementById('inspectorPanel').classList.remove('open');
}

function exportCSV() {
  if (!currentSessionId) return;
  window.open(`${API}/api/export/csv/${currentSessionId}`, '_blank');
}

function exportPDF() {
  if (!currentSessionId) return;
  window.open(`${API}/api/export/pdf/${currentSessionId}`, '_blank');
}

function showWelcome() {
  document.getElementById('welcomeState').style.display = 'grid';
  document.getElementById('crawlProgress').classList.add('hidden');
  document.getElementById('dashboardContent').style.display = 'none';
}

function hideWelcome() {
  document.getElementById('welcomeState').style.display = 'none';
}

function showProgress() {
  document.getElementById('welcomeState').style.display = 'none';
  document.getElementById('crawlProgress').classList.remove('hidden');
  document.getElementById('dashboardContent').style.display = 'none';
}

function hideProgress() {
  document.getElementById('crawlProgress').classList.add('hidden');
}

function showDashboard() {
  document.getElementById('dashboardContent').style.display = 'grid';
  document.getElementById('btnExportCSV').style.display = '';
  document.getElementById('btnExportPDF').style.display = '';
}

function onSearch() {
  renderTable(getVisiblePages());
}

function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = `toast ${type || 'info'}`;
  toast.textContent = message;
  document.getElementById('toastContainer').appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return '';
  }
}

function trimProtocol(value) {
  return value.replace(/^https?:\/\//, '');
}

function formatIssueLabel(issueType) {
  return issueType.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
