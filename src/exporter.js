const PDFDocument = require('pdfkit');
const db = require('./database');

/**
 * Generate CSV export from session data
 */
async function generateCSV(sessionId) {
  const pages = await db.getPagesBySession(sessionId, { crawlStatus: 'done' });
  
  const headers = [
    'URL', 'Final URL', 'Domain', 'Subdomain', 'Status Code',
    'Is Redirect', 'Score', 'Title', 'Title Length',
    'Meta Description', 'Meta Desc Length', 'H1', 'H1 Count',
    'Canonical', 'Word Count', 'Schema Present', 'OG Tags Present',
    'Internal Links', 'External Links', 'Load Time (ms)', 'Issues Count',
    'Error Count', 'Warning Count', 'Last Crawled'
  ];

  const rows = pages.map(page => {
    let issues = [];
    try { issues = JSON.parse(page.issues || '[]'); } catch (e) {}
    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const hasSchema = page.schema_json && page.schema_json !== '[]' && page.schema_json !== 'null';
    const hasOg = page.og_tags && page.og_tags !== '{}' && page.og_tags !== 'null';

    return [
      page.original_url,
      page.final_url || '',
      page.domain || '',
      page.subdomain || '',
      page.status_code || '',
      page.is_redirect ? 'Yes' : 'No',
      page.score || 0,
      (page.title || '').replace(/"/g, '""'),
      page.title_length || 0,
      (page.meta_description || '').replace(/"/g, '""'),
      page.meta_description_length || 0,
      (page.h1_text || '').replace(/"/g, '""'),
      page.h1_count || 0,
      page.canonical_url || '',
      page.word_count || 0,
      hasSchema ? 'Yes' : 'No',
      hasOg ? 'Yes' : 'No',
      page.internal_links_count || 0,
      page.external_links_count || 0,
      page.load_time_ms || 0,
      issues.length,
      errors,
      warnings,
      page.last_crawled || ''
    ].map(v => `"${v}"`).join(',');
  });

  return [headers.map(h => `"${h}"`).join(','), ...rows].join('\n');
}

/**
 * Generate PDF report from session data
 */
async function generatePDF(sessionId) {
  return new Promise((resolve, reject) => {
    (async () => {
      const session = await db.getSession(sessionId);
      if (!session) {
        return reject(new Error('Session not found'));
      }

      const stats = await db.getSessionStats(sessionId);
      const pages = await db.getPagesBySession(sessionId, { crawlStatus: 'done' });
      const issueSummary = await db.getIssueSummary(sessionId);

      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: 'SEO & AEO Audit Report',
          Author: 'SEO Audit System',
          Subject: `Audit Report for ${session.target_url}`
        }
      });

      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(28).font('Helvetica-Bold')
        .text('SEO & AEO Audit Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(14).font('Helvetica')
        .text(session.target_url, { align: 'center', color: '#666' });
      doc.moveDown(0.3);
      doc.fontSize(10)
        .text(`Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, { align: 'center' });
      doc.moveDown(2);

      doc.rect(50, doc.y, 495, 120).stroke('#ddd');
      const boxY = doc.y + 15;
      doc.fontSize(16).font('Helvetica-Bold').text('Executive Summary', 65, boxY);
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica');
      doc.text(`Total Pages Audited: ${stats.total_pages || 0}`, 65);
      doc.text(`Average SEO Score: ${Math.round(stats.avg_score || 0)}/100`, 65);
      doc.text(`Strong Pages: ${stats.strong_pages || 0}`, 65);
      doc.text(`Average Pages: ${stats.average_pages || 0}`, 65);
      doc.text(`Weak Pages: ${stats.weak_pages || 0}`, 65);
      doc.moveDown(2);

      doc.addPage();
      doc.fontSize(18).font('Helvetica-Bold').text('Score Distribution');
      doc.moveDown(0.5);

      const strong = pages.filter((p) => p.score >= 80).length;
      const average = pages.filter((p) => p.score >= 60 && p.score < 80).length;
      const weak = pages.filter((p) => p.score < 60).length;

      doc.fontSize(11).font('Helvetica');
      doc.fillColor('#27ae60').text(`Strong (80+): ${strong} pages`);
      doc.fillColor('#f39c12').text(`Average (60-79): ${average} pages`);
      doc.fillColor('#e74c3c').text(`Weak (<60): ${weak} pages`);
      doc.fillColor('#000');
      doc.moveDown(1);

      doc.fontSize(18).font('Helvetica-Bold').text('Issues Overview');
      doc.moveDown(0.5);

      const issueLabelMap = {
        missing_title: 'Missing Title',
        missing_meta: 'Missing Meta Description',
        missing_h1: 'Missing H1 Heading',
        missing_canonical: 'Missing Canonical URL',
        missing_schema: 'Missing Schema Markup',
        missing_og: 'Missing Open Graph Tags',
        thin_content: 'Thin Content (<100 words)',
        weak_content: 'Weak Content (<300 words)',
        short_title: 'Short Title',
        long_title: 'Long Title',
        short_meta: 'Short Meta Description',
        long_meta: 'Long Meta Description',
        multiple_h1: 'Multiple H1 Tags',
        redirect: 'Redirect Detected',
        client_error: 'Client Error (4xx)',
        server_error: 'Server Error (5xx)',
        slow_page: 'Slow Page Load',
        very_slow_page: 'Very Slow Page Load',
        no_internal_links: 'No Internal Links'
      };

      doc.fontSize(11).font('Helvetica');
      for (const issue of issueSummary.sort((a, b) => b.count - a.count)) {
        const label = issueLabelMap[issue.type] || issue.type;
        doc.text(`- ${label}: ${issue.count} pages`);
      }
      doc.moveDown(1);

      doc.addPage();
      doc.fontSize(18).font('Helvetica-Bold').text('Page Details');
      doc.moveDown(0.5);

      const sortedPages = [...pages].sort((a, b) => (a.score || 0) - (b.score || 0));

      for (const page of sortedPages.slice(0, 50)) {
        if (doc.y > 700) {
          doc.addPage();
        }

        const scoreColor = page.score >= 80 ? '#27ae60' : page.score >= 60 ? '#f39c12' : '#e74c3c';

        doc.fontSize(10).font('Helvetica-Bold');
        doc.fillColor(scoreColor).text(`[${page.score || 0}]`, { continued: true });
        doc.fillColor('#000').text(` ${page.original_url}`);

        doc.fontSize(9).font('Helvetica').fillColor('#666');
        if (page.title) doc.text(`  Title: ${page.title.substring(0, 80)}`);
        if (page.status_code) doc.text(`  Status: ${page.status_code}${page.is_redirect ? ' (redirect)' : ''}`);

        let issues = [];
        try {
          issues = JSON.parse(page.issues || '[]');
        } catch (error) {}

        const issueList = Array.isArray(issues) ? issues : Object.values(issues || {});
        const errorIssues = issueList.filter((issue) => issue.severity === 'error');
        if (errorIssues.length > 0) {
          doc.fillColor('#e74c3c');
          for (const issue of errorIssues.slice(0, 3)) {
            doc.text(`  x ${issue.message}`);
          }
        }

        doc.fillColor('#000').moveDown(0.5);
      }

      if (sortedPages.length > 50) {
        doc.moveDown(1);
        doc.fontSize(10).font('Helvetica-Oblique')
          .text(`... and ${sortedPages.length - 50} more pages. See CSV export for complete data.`);
      }

      doc.end();
    })().catch(reject);
  });
}

module.exports = { generateCSV, generatePDF };
