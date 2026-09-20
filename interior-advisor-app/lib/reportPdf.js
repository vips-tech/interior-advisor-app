// lib/reportPdf.js
//
// Minimal markdown-to-PDF renderer for the customer report, built on pdfkit.
// This is NOT a full markdown engine — it recognizes a small, deliberately
// limited set of line shapes (headings, bullet lines, table rows, horizontal
// rules, and plain paragraphs) which is all that buildReportMarkdown() in
// routes/advisor.js ever produces or that an advisor is expected to type when
// hand-editing the report textarea. Anything more exotic (nested lists,
// inline emphasis, links, code blocks) is rendered as plain text rather than
// causing an error. See README for this caveat.
const PDFDocument = require('pdfkit');

function renderReportPdf(contentMd, { title } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const lines = String(contentMd || '').split(/\r?\n/);

  doc.font('Helvetica');

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (!line.trim()) {
      doc.moveDown(0.5);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      const y = doc.y + 4;
      doc.moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .strokeColor('#999999').lineWidth(1).stroke();
      doc.moveDown(0.75);
      continue;
    }

    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###\s+(.*)$/);

    if (h1) {
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(18).fillColor('#1a1a1a').text(stripEmphasis(h1[1]));
      doc.font('Helvetica').fontSize(11).fillColor('#000000');
      doc.moveDown(0.4);
      continue;
    }
    if (h2) {
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(14).fillColor('#1a1a1a').text(stripEmphasis(h2[1]));
      doc.font('Helvetica').fontSize(11).fillColor('#000000');
      doc.moveDown(0.25);
      continue;
    }
    if (h3) {
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(12).fillColor('#1a1a1a').text(stripEmphasis(h3[1]));
      doc.font('Helvetica').fontSize(11).fillColor('#000000');
      doc.moveDown(0.2);
      continue;
    }

    // Markdown table row: | a | b | c |
    if (/^\|.*\|$/.test(line.trim())) {
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
      // Skip separator rows like |---|---|
      if (cells.every(c => /^:?-+:?$/.test(c))) continue;
      doc.font('Helvetica').fontSize(9.5).fillColor('#000000').text(cells.join('   |   '), { paragraphGap: 2 });
      continue;
    }

    // Bullet line
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      doc.font('Helvetica').fontSize(11).fillColor('#000000')
        .text(`•  ${stripEmphasis(bullet[1])}`, { indent: 12, paragraphGap: 2 });
      continue;
    }

    // Bold-only line, e.g. "**Case ID:** abc"
    doc.font('Helvetica').fontSize(11).fillColor('#000000').text(stripEmphasis(line), { paragraphGap: 4 });
  }

  return doc;
}

// Strips the most common inline markdown markers (bold/italic) since pdfkit's
// simple .text() calls don't do inline rich text without extra bookkeeping —
// good enough for readable structure, not a full renderer.
function stripEmphasis(s) {
  return String(s)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1');
}

module.exports = { renderReportPdf };
