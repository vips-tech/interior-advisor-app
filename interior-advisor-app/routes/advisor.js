// routes/advisor.js — the internal advisor workspace.
// Single-advisor auth (founder-operated, per V1 spec — no multi-advisor logic).
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const supabase = require('../lib/supabase');
const legal = require('../content/legal');
const aiPrompts = require('../content/ai_prompts');
const { renderReportPdf } = require('../lib/reportPdf');

// ---- Advisor password check (bcrypt) ----
// ADVISOR_PASSWORD_HASH (a bcrypt hash) is the recommended production setting.
// If only the plaintext ADVISOR_PASSWORD is set, hash it once at module load so
// the comparison is still a constant-time bcrypt compare rather than a plaintext ===.
let ADVISOR_PASSWORD_HASH = process.env.ADVISOR_PASSWORD_HASH || null;
if (!ADVISOR_PASSWORD_HASH && process.env.ADVISOR_PASSWORD) {
  ADVISOR_PASSWORD_HASH = bcrypt.hashSync(process.env.ADVISOR_PASSWORD, 10);
}

const DEFAULT_ADVISOR_EMAIL = 'admin123@gmail.com';
const DEFAULT_ADVISOR_PASSWORD = 'admin123';

const EVIDENCE_LABELS = ['CONFIRMED', 'VERIFIED', 'CUSTOMER_REPORTED', 'UNCONFIRMED', 'ADVISOR_ASSESSMENT', 'RISK'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In-memory cache of the most recent AI-assist result per case. Deliberately NOT
// persisted to the database — per AI Internal Prompt Workflow doc §35 "Source of
// Truth Rule", AI output is a draft aid, never the case's source of truth, and per
// §27 "AI output is never automatically customer-ready" until the advisor reviews it.
const aiResultCache = new Map(); // caseId -> { type, prompt, output, at }

function requireAuth(req, res, next) {
  if (req.session && req.session.advisor) return next();
  return res.redirect('/advisor/login');
}

// Every :id param in this router is a case UUID — reject anything else before it
// ever reaches a query, as defense-in-depth alongside parameterized statements.
function requireValidCaseId(req, res, next) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).send('Not found');
  next();
}

function requireEvidenceLabel(req, res, next) {
  if (!EVIDENCE_LABELS.includes(req.body.evidence_label)) {
    return res.status(400).send('Invalid evidence label.');
  }
  next();
}

// Company Investigation (phone verification) is a VERIFY-only activity — CHECK is
// explicitly "desk-based review only, no outbound calls" per the service definition.
// The case workspace UI already hides this section for CHECK cases; this is the
// server-side enforcement so the rule can't be bypassed by posting directly to the
// route (the UI hiding it is not, on its own, a security or business-rule control).
async function requireVerifyService(req, res, next) {
  const c = await db.prepare('SELECT service FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).send('Not found');
  if (c.service !== 'VERIFY') {
    return res.status(403).send('Company investigation calls are only applicable to VERIFY cases.');
  }
  next();
}

module.exports = function ({ loginLimiter, verifyCsrf }) {
  const router = express.Router();

  // ---- Auth ----
  router.get('/login', async (req, res) => {
    res.render('advisor/login', { error: null });
  });

  // NOTE: the login POST is intentionally NOT run through verifyCsrf. Login is already
  // protected by loginLimiter (rate limiting) rather than a CSRF token, since a session
  // may not yet be persisted (saveUninitialized:false) at the point the login form was
  // rendered for a brand-new visitor, which could make the token unreliable pre-auth.
  // Every other state-changing route in this router does go through verifyCsrf.
  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    const configuredEmail = (process.env.ADVISOR_EMAIL || DEFAULT_ADVISOR_EMAIL).trim().toLowerCase();
    const configuredPassword = process.env.ADVISOR_PASSWORD || DEFAULT_ADVISOR_PASSWORD;
    const okEmail = (email || '').trim().toLowerCase() === configuredEmail;
    const okPass = typeof password === 'string' && password.length > 0 && bcrypt.compareSync(password, ADVISOR_PASSWORD_HASH || bcrypt.hashSync(configuredPassword, 10));
    if (okEmail && okPass) {
      // Regenerate the session on login to prevent session fixation.
      req.session.regenerate((err) => {
        if (err) return res.status(500).send('Login failed. Please try again.');
        req.session.advisor = { email };
        res.redirect('/advisor/cases');
      });
      return;
    }
    res.render('advisor/login', { error: 'Incorrect email or password.' });
  });

  router.post('/logout', verifyCsrf, async (req, res) => {
    req.session.destroy(() => res.redirect('/advisor/login'));
  });

  router.get('/', requireAuth, async (req, res) => res.redirect('/advisor/cases'));

  // ---- Case list ----
  const STATUS_VALUES = ['INTAKE_PENDING', 'PAYMENT_PENDING', 'PAYMENT_SUBMITTED', 'PAID', 'IN_REVIEW', 'INVESTIGATING', 'READY', 'DELIVERED'];
  router.get('/cases', requireAuth, async (req, res) => {
    const statusFilter = STATUS_VALUES.includes(req.query.status) ? req.query.status : '';
    let cases;
    if (statusFilter) {
      cases = await db.prepare('SELECT * FROM cases WHERE status = ? ORDER BY created_at DESC').all(statusFilter);
    } else {
      cases = await db.prepare('SELECT * FROM cases ORDER BY created_at DESC').all();
    }
    const counts = await db.prepare('SELECT status, COUNT(*) n FROM cases GROUP BY status').all();
    res.render('advisor/dashboard', { cases, counts, statusFilter });
  });

  router.post('/cases/:id/payment-confirm', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    const c = await db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).send('Not found');
    const nextStatus = c.status === 'PAYMENT_SUBMITTED' ? 'PAID' : c.status;
    await db.prepare(`UPDATE cases SET payment_confirmed_at = CURRENT_TIMESTAMP, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nextStatus, c.id);
    res.redirect('/advisor/cases');
  });

  // ---- Case detail ----
  async function loadCase(id) {
    const c = await db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
    if (!c) return null;
    const quotes = await db.prepare('SELECT * FROM quotes WHERE case_id = ? ORDER BY id').all(id);
    const notes = await db.prepare('SELECT * FROM case_notes WHERE case_id = ? ORDER BY id DESC').all(id);
    const calls = await db.prepare('SELECT * FROM investigation_calls WHERE case_id = ? ORDER BY id DESC').all(id);
    const comparisonRows = await db.prepare('SELECT * FROM comparison_rows WHERE case_id = ? ORDER BY sort_order, id').all(id);
    const recommendation = await db.prepare('SELECT * FROM recommendation WHERE case_id = ?').get(id);
    const report = await db.prepare('SELECT * FROM reports WHERE case_id = ?').get(id);
    // QUOTATION docs feed comparison/extraction/recommendation logic; SUPPORTING docs
    // (floor plans, photos, prior communication, reference designs, etc.) are still
    // viewable/downloadable but excluded from that decision-making logic.
    const quoteDocs = quotes.filter(q => (q.doc_type || 'QUOTATION') === 'QUOTATION');
    return { c, quotes, quoteDocs, notes, calls, comparisonRows, recommendation, report };
  }

  router.get('/cases/:id', requireAuth, requireValidCaseId, async (req, res) => {
    const data = await loadCase(req.params.id);
    if (!data) return res.status(404).send('Case not found');
    const ai = aiResultCache.get(req.params.id) || null;
    const stale = isReportStale(data.report, data.recommendation);
    res.render('advisor/case', {
      ...data,
      EVIDENCE_LABELS,
      reportStale: stale,
      prompts: {
        // AI extraction/normalization/comparison/report-drafting only ever consider
        // QUOTATION documents — supporting documents are reference material only.
        normalization: aiPrompts.normalizationPrompt(data.c, data.quoteDocs),
        gaps: aiPrompts.gapsPrompt(data.c, data.quoteDocs),
        evidenceStructuring: aiPrompts.evidenceStructuringPrompt(data.c, data.calls),
        investigationQuestions: aiPrompts.investigationQuestionsPrompt(data.c),
        comparisonDraft: aiPrompts.comparisonDraftPrompt(data.c, data.quoteDocs),
        contradictionCheck: aiPrompts.contradictionCheckPrompt(data.c, data.quoteDocs, data.calls),
        decisionCost: aiPrompts.decisionCostPrompt(data.c, data.quoteDocs, data.comparisonRows),
        challenge: aiPrompts.challengePrompt(data.c, data.recommendation ?
          `${data.recommendation.recommended_option}: ${data.recommendation.reasoning}` : null),
        reportDraft: aiPrompts.reportDraftPrompt(data.c, data.quoteDocs, data.recommendation, data.comparisonRows),
        extractionByQuote: data.quoteDocs.map(q => ({ quote: q, prompt: aiPrompts.extractionPrompt(data.c, q) })),
      },
      aiEnabled: !!process.env.ANTHROPIC_API_KEY,
      ai,
    });
  });

  // ---- Decision profile (advisor-completed, condensed from Customer Decision Profile.docx) ----
  router.post('/cases/:id/decision-profile', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    const { decision_type, risk_tolerance, non_negotiables, advisor_hypothesis } = req.body;
    await db.prepare(`UPDATE cases SET decision_type=?, risk_tolerance=?, non_negotiables=?, advisor_hypothesis=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(
        (decision_type || '').slice(0, 100), (risk_tolerance || '').slice(0, 100),
        (non_negotiables || '').slice(0, 2000), (advisor_hypothesis || '').slice(0, 2000),
        req.params.id
      );
    res.redirect(`/advisor/cases/${req.params.id}#profile`);
  });

  // ---- Authenticated file view for uploaded quotations ----
  // Scoped by BOTH quote id and case id, so a quote belonging to one case can never
  // be fetched by guessing its numeric id under a different case's URL.
  router.get('/cases/:id/quotes/:quoteId/file', requireAuth, requireValidCaseId, async (req, res) => {
    if (!/^\d+$/.test(req.params.quoteId)) return res.status(404).send('Not found');
    const q = await db.prepare('SELECT * FROM quotes WHERE id = ? AND case_id = ?').get(req.params.quoteId, req.params.id);
    if (!q) return res.status(404).send('Not found');

    const objectPath = typeof q.stored_filename === 'string' ? q.stored_filename.trim() : '';
    if (!objectPath || !objectPath.startsWith('documents/')) {
      return res.status(400).send('Invalid stored file path.');
    }

    try {
      const { data, error } = await supabase.storage.from('interior-advisor-files').download(objectPath);
      if (error || !data) {
        console.error('Supabase Storage download error:', error);
        return res.status(404).send('File missing');
      }

      const arrayBuffer = await data.arrayBuffer();
      res.setHeader('Content-Type', q.file_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${q.original_filename.replace(/["\r\n]/g, '')}"`);
      res.send(Buffer.from(arrayBuffer));
    } catch (err) {
      console.error('File download failed:', err);
      return res.status(500).send('Unable to load file');
    }
  });

  // ---- Notes (with evidence labels) ----
  router.post('/cases/:id/notes', requireAuth, requireValidCaseId, verifyCsrf, requireEvidenceLabel, async (req, res) => {
    const { quote_id, field_label, value, evidence_label } = req.body;
    if (!field_label || !value) return res.status(400).send('Field and value are required.');
    await db.prepare(`INSERT INTO case_notes (case_id, quote_id, field_label, value, evidence_label) VALUES (?, ?, ?, ?, ?)`)
      .run(req.params.id, quote_id || null, field_label.slice(0, 200), value.slice(0, 4000), evidence_label);
    res.redirect(`/advisor/cases/${req.params.id}#notes`);
  });

  router.post('/cases/:id/notes/:noteId/delete', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    await db.prepare('DELETE FROM case_notes WHERE id = ? AND case_id = ?').run(req.params.noteId, req.params.id);
    res.redirect(`/advisor/cases/${req.params.id}#notes`);
  });

  // ---- Investigation calls (VERIFY only) ----
  router.post('/cases/:id/investigation', requireAuth, requireValidCaseId, verifyCsrf, requireVerifyService, requireEvidenceLabel, async (req, res) => {
    const { quote_id, contact_name, contact_detail, question, answer, evidence_label, follow_up } = req.body;
    if (!question || !answer) return res.status(400).send('Question and answer are required.');
    await db.prepare(`
      INSERT INTO investigation_calls (case_id, quote_id, contact_name, contact_detail, question, answer, evidence_label, follow_up)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, quote_id || null, (contact_name || '').slice(0, 200), (contact_detail || '').slice(0, 200),
      question.slice(0, 1000), answer.slice(0, 4000), evidence_label, (follow_up || '').slice(0, 1000)
    );
    await db.prepare(`UPDATE cases SET status = CASE WHEN status IN ('IN_REVIEW','PAID') THEN 'INVESTIGATING' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.params.id);
    res.redirect(`/advisor/cases/${req.params.id}#investigation`);
  });

  router.post('/cases/:id/investigation/:callId/delete', requireAuth, requireValidCaseId, verifyCsrf, requireVerifyService, async (req, res) => {
    await db.prepare('DELETE FROM investigation_calls WHERE id = ? AND case_id = ?').run(req.params.callId, req.params.id);
    res.redirect(`/advisor/cases/${req.params.id}#investigation`);
  });

  // ---- Comparison table (Apples-to-Apples, condensed) ----
  const COMPARISON_STATUSES = new Set(['COMPARABLE', 'NOT_YET_COMPARABLE', 'NEEDS_CLARIFICATION', 'MISSING']);
  router.post('/cases/:id/comparison', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    const { attribute, sort_order } = req.body;
    const status = COMPARISON_STATUSES.has(req.body.status) ? req.body.status : 'NEEDS_CLARIFICATION';
    if (!attribute) return res.status(400).send('Attribute is required.');
    // quote_values arrive as quote_value_<quoteId> fields; only accept numeric quote ids
    // that actually belong to this case and are QUOTATION docs (not supporting documents),
    // so a crafted field name can't write to another case's data or pull in a non-quote file.
    const validQuoteIds = new Set((await db.prepare(`SELECT id FROM quotes WHERE case_id = ? AND (doc_type = 'QUOTATION' OR doc_type IS NULL)`).all(req.params.id)).map(q => String(q.id)));
    const values = {};
    Object.keys(req.body).forEach(k => {
      if (k.startsWith('quote_value_')) {
        const qid = k.replace('quote_value_', '');
        if (validQuoteIds.has(qid)) values[qid] = String(req.body[k]).slice(0, 500);
      }
    });
    await db.prepare(`INSERT INTO comparison_rows (case_id, attribute, quote_values, status, sort_order) VALUES (?, ?, ?, ?, ?)`)
      .run(req.params.id, attribute.slice(0, 200), JSON.stringify(values), status, parseInt(sort_order, 10) || 0);
    res.redirect(`/advisor/cases/${req.params.id}#comparison`);
  });

  router.post('/cases/:id/comparison/:rowId/delete', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    await db.prepare('DELETE FROM comparison_rows WHERE id = ? AND case_id = ?').run(req.params.rowId, req.params.id);
    res.redirect(`/advisor/cases/${req.params.id}#comparison`);
  });

  // ---- Recommendation (with Conflict/Recommendation Integrity Check) ----
  // Saving the recommendation (edits) always clears any prior approval — a recommendation
  // must be re-approved by the advisor after any change before it can reach a report.
  router.post('/cases/:id/recommendation', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    const { recommended_option, reasoning, trade_offs, risks, confidence, open_questions, conflict_confirmed, alternative_note, decision_cost_note } = req.body;
    const existing = await db.prepare('SELECT 1 FROM recommendation WHERE case_id = ?').get(req.params.id);
    const confirmed = conflict_confirmed ? 1 : 0;
    const vals = [
      (recommended_option || '').slice(0, 200), (reasoning || '').slice(0, 4000), (trade_offs || '').slice(0, 4000),
      (risks || '').slice(0, 4000), ['High', 'Medium', 'Low'].includes(confidence) ? confidence : null,
      (open_questions || '').slice(0, 4000), confirmed,
      (alternative_note || '').slice(0, 2000), (decision_cost_note || '').slice(0, 2000),
    ];
    if (existing) {
      await db.prepare(`UPDATE recommendation SET recommended_option=?, reasoning=?, trade_offs=?, risks=?, confidence=?, open_questions=?, conflict_confirmed=?, alternative_note=?, decision_cost_note=?, approved_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE case_id=?`)
        .run(...vals, req.params.id);
    } else {
      await db.prepare(`INSERT INTO recommendation (case_id, recommended_option, reasoning, trade_offs, risks, confidence, open_questions, conflict_confirmed, alternative_note, decision_cost_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.params.id, ...vals);
    }
    res.redirect(`/advisor/cases/${req.params.id}#recommendation`);
  });

  // Explicit final approval step — separate action from saving a draft, per the rule that
  // AI must never be the final decision-maker and the human advisor must explicitly approve
  // the recommendation before it can appear in the customer report.
  router.post('/cases/:id/recommendation/approve', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    const rec = await db.prepare('SELECT * FROM recommendation WHERE case_id = ?').get(req.params.id);
    if (!rec || !rec.recommended_option || !rec.conflict_confirmed) {
      return res.status(400).send('Complete the recommendation and confirm the conflict check before approving.');
    }
    await db.prepare(`UPDATE recommendation SET approved_at = CURRENT_TIMESTAMP WHERE case_id = ?`).run(req.params.id);
    res.redirect(`/advisor/cases/${req.params.id}#recommendation`);
  });

  // ---- Report ----
  function buildReportMarkdown(data) {
    const { c, quotes, quoteDocs, notes, calls, recommendation, comparisonRows } = data;
    const quotations = quoteDocs || quotes.filter(q => (q.doc_type || 'QUOTATION') === 'QUOTATION');
    const lines = [];

    // ---- 1. Cover / header ----
    lines.push(`# Interior ${c.service === 'VERIFY' ? 'Quote Verify' : 'Quote Check'} — Independent Interior Decision Report`);
    lines.push(`*Your home. Your money. Your decision.*`);
    lines.push('');
    lines.push(`**Case reference:** ${c.id}  `);
    lines.push(`**Customer:** ${c.customer_name || 'Not yet determined'}  `);
    lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}  `);
    lines.push(`**Service tier:** ${c.service === 'VERIFY' ? 'VERIFY (independent company investigation included)' : 'CHECK (quote comparison and assessment)'}`);
    lines.push('');

    // ---- 2. What you asked us to help with ----
    lines.push('## 2. What You Asked Us to Help With');
    lines.push(`**The decision you're trying to make:** ${c.decision_needed || 'Not yet determined'}`);
    lines.push(`**Budget:** ${c.budget_range || 'Not yet determined'}`);
    lines.push(`**Your stated priorities (must-haves / nice-to-haves):** ${c.priorities || 'Not yet determined'}`);
    lines.push(`**Non-negotiables:** ${c.non_negotiables || 'None identified'}`);
    lines.push(`**Timeline:** ${c.timeline || 'Not provided'}`);
    lines.push('');

    // ---- 3. Quotations / companies considered ----
    lines.push('## 3. Quotations & Companies Considered');
    if (quotations.length) {
      lines.push(quotations.map(q => `- ${q.company_name}`).join('\n'));
    } else {
      lines.push('_No quotations uploaded yet._');
    }
    lines.push('');

    // ---- 4. What we found — evidence summary ----
    lines.push('## 4. What We Found — Evidence Summary');
    lines.push('Legend: 🟢 Confirmed · 🔵 Verified · ⚪ Customer Reported · 🟡 Unconfirmed · 🟣 Advisor Assessment · 🔴 Risk');
    lines.push('');
    if (notes.length) {
      const grouped = {};
      notes.forEach(n => { (grouped[n.evidence_label] = grouped[n.evidence_label] || []).push(n); });
      EVIDENCE_LABELS.forEach(label => {
        const rows = grouped[label];
        if (!rows || !rows.length) return;
        lines.push(`**${EVIDENCE_EMOJI[label] || ''} ${label.replace('_', ' ')}**`);
        rows.forEach(n => {
          const q = quotes.find(x => x.id === n.quote_id);
          lines.push(`- ${q ? `[${q.company_name}] ` : ''}${n.field_label}: ${n.value}`);
        });
        lines.push('');
      });
    } else {
      lines.push('_No findings recorded yet._');
      lines.push('');
    }

    // ---- 5. Investigation findings (VERIFY only) ----
    if (c.service === 'VERIFY') {
      lines.push('## 5. Investigation Findings (Independent Company Calls)');
      if (calls.length) {
        calls.forEach(call => {
          const q = quotes.find(x => x.id === call.quote_id);
          lines.push(`- **${q ? q.company_name : 'Unknown company'}** — ${EVIDENCE_EMOJI[call.evidence_label] || ''} ${(call.evidence_label || '').replace('_', ' ')}`);
          lines.push(`  Q: ${call.question}`);
          lines.push(`  A: ${call.answer}`);
          if (call.follow_up) lines.push(`  Follow-up: ${call.follow_up}`);
        });
      } else {
        lines.push('_No investigation calls logged yet._');
      }
      lines.push('');
    }

    // ---- 6. Apples-to-Apples comparison ----
    lines.push(`## ${c.service === 'VERIFY' ? '6' : '5'}. Apples-to-Apples Comparison`);
    if (comparisonRows.length && quotations.length) {
      const header = `| Attribute | ${quotations.map(q => q.company_name).join(' | ')} | Status |`;
      const sep = `|---|${quotations.map(() => '---').join('|')}|---|`;
      lines.push(header, sep);
      comparisonRows.forEach(r => {
        const vals = JSON.parse(r.quote_values || '{}');
        const row = quotations.map(q => vals[q.id] || vals[String(q.id)] || '—').join(' | ');
        lines.push(`| ${r.attribute} | ${row} | ${(r.status || '').replace('_', ' ')} |`);
      });
    } else {
      lines.push('_Comparison not yet built._');
    }
    lines.push('');

    const secOffset = c.service === 'VERIFY' ? 1 : 0;

    // ---- 7. Our recommendation (gated on approval) ----
    lines.push(`## ${6 + secOffset}. Our Recommendation`);
    if (recommendation && recommendation.approved_at) {
      lines.push(`We recommend: **${recommendation.recommended_option || 'Not yet determined'}**`);
    } else {
      lines.push('_Recommendation not yet approved by the advisor — complete and approve the Recommendation section before this report is ready for delivery._');
    }
    lines.push('');

    // ---- 8. Why ----
    lines.push(`## ${7 + secOffset}. Why`);
    lines.push(recommendation && recommendation.approved_at
      ? (recommendation.reasoning || 'Not yet determined')
      : '_Reasoning will appear here once the recommendation is approved._');
    lines.push('');

    // ---- 9. Risks identified ----
    lines.push(`## ${8 + secOffset}. Risks Identified`);
    lines.push(recommendation?.risks || 'None identified yet.');
    lines.push('');

    // ---- 10. Why not the alternative(s) ----
    lines.push(`## ${9 + secOffset}. Why We Didn't Recommend the Alternative(s)`);
    lines.push(recommendation && recommendation.approved_at
      ? (recommendation.alternative_note || 'Not yet determined')
      : '_Will appear here once the recommendation is approved._');
    lines.push('');

    // ---- 11. Estimated decision cost ----
    lines.push(`## ${10 + secOffset}. Estimated Cost If You Proceed`);
    lines.push('_This is the advisor\'s estimate based on the information available, not a guaranteed final project price._');
    lines.push('');
    lines.push(recommendation?.decision_cost_note || 'Not yet estimated — ask your advisor for an all-in cost estimate including likely additional items before you sign.');
    lines.push('');

    // ---- 12. Confidence level ----
    lines.push(`## ${11 + secOffset}. Confidence Level`);
    lines.push(recommendation?.confidence || 'Not yet determined');
    lines.push('');

    // ---- 13. Open questions / before you sign ----
    lines.push(`## ${12 + secOffset}. Open Questions / Before You Sign`);
    lines.push(recommendation?.open_questions || '_To be completed._');
    lines.push('');

    // ---- 14. Important limitations ----
    lines.push(`## ${13 + secOffset}. Important Limitations`);
    lines.push(legal.shortDisclaimerReport);
    lines.push('');

    // ---- 15. Independence & referral disclosure ----
    lines.push(`## ${14 + secOffset}. Independence & Referral Disclosure`);
    lines.push(legal.independenceStatement);
    lines.push('');

    // ---- 16. Your decision (for the customer's own record — not synced back) ----
    lines.push(`## ${15 + secOffset}. Your Decision`);
    lines.push('This section is for your own reference — nothing you write here is sent back to us.');
    lines.push('');
    lines.push('**What I have decided to do:** _______________________________________________');
    lines.push('');
    lines.push('**Date:** ___________');
    lines.push('');
    lines.push('---');
    lines.push('*Your home. Your money. Your decision.*');
    return lines.join('\n');
  }

  const EVIDENCE_EMOJI = {
    CONFIRMED: '🟢', VERIFIED: '🔵', CUSTOMER_REPORTED: '⚪',
    UNCONFIRMED: '🟡', ADVISOR_ASSESSMENT: '🟣', RISK: '🔴',
  };

  // A report is "stale" once the recommendation has changed (by updated_at, or by
  // approval) since the report was last generated — the advisor must regenerate
  // before it can be sent, so the customer never receives a report describing an
  // out-of-date recommendation.
  function normalizeTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  function recommendationVersionKey(recommendation) {
    if (!recommendation) return null;
    return normalizeTimestamp(recommendation.approved_at || recommendation.updated_at || null);
  }
  function isReportStale(report, recommendation) {
    if (!report) return false;
    const currentKey = recommendationVersionKey(recommendation);
    if (!currentKey) return false;
    return normalizeTimestamp(report.recommendation_snapshot_at) !== currentKey;
  }

  router.post('/cases/:id/report/generate', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    const data = await loadCase(req.params.id);
    if (!data) return res.status(404).send('Not found');
    const md = buildReportMarkdown(data);
    const snapshotAt = recommendationVersionKey(data.recommendation);
    const existing = await db.prepare('SELECT 1 FROM reports WHERE case_id = ?').get(req.params.id);
    if (existing) {
      await db.prepare(`UPDATE reports SET content_md = ?, status='DRAFT', recommendation_snapshot_at = ?, updated_at=CURRENT_TIMESTAMP WHERE case_id = ?`).run(md, snapshotAt, req.params.id);
    } else {
      await db.prepare(`INSERT INTO reports (case_id, content_md, status, recommendation_snapshot_at) VALUES (?, ?, 'DRAFT', ?)`).run(req.params.id, md, snapshotAt);
    }
    res.redirect(`/advisor/cases/${req.params.id}#report`);
  });

  router.post('/cases/:id/report', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    const { content_md } = req.body;
    if (typeof content_md !== 'string') return res.status(400).send('Report content is required.');
    const existing = await db.prepare('SELECT 1 FROM reports WHERE case_id = ?').get(req.params.id);
    if (existing) {
      await db.prepare(`UPDATE reports SET content_md = ?, updated_at=CURRENT_TIMESTAMP WHERE case_id = ?`).run(content_md.slice(0, 50000), req.params.id);
    } else {
      await db.prepare(`INSERT INTO reports (case_id, content_md, status) VALUES (?, ?, 'DRAFT')`).run(req.params.id, content_md.slice(0, 50000));
    }
    res.redirect(`/advisor/cases/${req.params.id}#report`);
  });

  // Sending requires BOTH: a report exists, and the recommendation has been explicitly
  // approved by the advisor (approved_at set) — this is the hard gate the spec requires.
  router.post('/cases/:id/report/send', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    const rec = await db.prepare('SELECT * FROM recommendation WHERE case_id = ?').get(req.params.id);
    const report = await db.prepare('SELECT * FROM reports WHERE case_id = ?').get(req.params.id);
    if (!report) return res.status(400).send('Generate a report before sending.');
    if (!rec || !rec.approved_at) {
      return res.status(400).send('The recommendation must be approved by the advisor before the report can be marked sent.');
    }
    if (isReportStale(report, rec)) {
      return res.status(400).send('Report is out of date — the recommendation has changed since this report was generated. Regenerate the report before sending.');
    }
    await db.prepare(`UPDATE reports SET status='SENT', updated_at=CURRENT_TIMESTAMP WHERE case_id = ?`).run(req.params.id);
    await db.prepare(`UPDATE cases SET status='DELIVERED', updated_at=CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
    res.redirect(`/advisor/cases/${req.params.id}#report`);
  });

  router.get('/cases/:id/report/download', requireAuth, requireValidCaseId, async (req, res) => {
    const report = await db.prepare('SELECT * FROM reports WHERE case_id = ?').get(req.params.id);
    if (!report) return res.status(404).send('No report yet');
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="report-${req.params.id}.md"`);
    res.send(report.content_md);
  });

  // Simplified markdown-to-PDF rendering — see lib/reportPdf.js and README for the
  // supported subset of markdown; it is not a full markdown engine.
  router.get('/cases/:id/report/download-pdf', requireAuth, requireValidCaseId, async (req, res) => {
    const report = await db.prepare('SELECT * FROM reports WHERE case_id = ?').get(req.params.id);
    if (!report) return res.status(404).send('No report yet');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report-${req.params.id}.pdf"`);
    const doc = renderReportPdf(report.content_md);
    doc.pipe(res);
    doc.end();
  });

  // ---- AI-assist: run a prompt against Claude directly (optional; requires ANTHROPIC_API_KEY) ----
  const ALLOWED_AI_TYPES = new Set(['extraction', 'normalization', 'gaps', 'evidence-structuring', 'investigation-questions', 'comparison-draft', 'contradiction-check', 'decision-cost', 'challenge', 'report-draft']);
  router.post('/cases/:id/ai/run', requireAuth, requireValidCaseId, verifyCsrf, async (req, res) => {
    const { type, prompt } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.redirect(`/advisor/cases/${req.params.id}#ai`);
    }
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) {
      return res.status(400).send('Invalid prompt.');
    }
    const safeType = typeof type === 'string' ? type.slice(0, 60) : 'unknown';
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const json = await resp.json();
      const output = json?.content?.[0]?.text || JSON.stringify(json);
      aiResultCache.set(req.params.id, { type: safeType, prompt, output, at: new Date().toISOString() });
    } catch (e) {
      aiResultCache.set(req.params.id, { type: safeType, prompt, output: `Error calling AI: ${e.message}`, at: new Date().toISOString() });
    }
    res.redirect(`/advisor/cases/${req.params.id}#ai`);
  });

  return router;
};
