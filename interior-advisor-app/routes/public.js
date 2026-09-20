// routes/public.js — customer-facing flow: landing -> choose service -> pay -> intake -> upload -> submit
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const supabase = require('../lib/supabase');
const legal = require('../content/legal');

const SERVICES = {
  CHECK: { label: 'CHECK', price: 2000, blurb: 'Compare your quotations and assess fit against your priorities.' },
  VERIFY: { label: 'VERIFY', price: 5000, blurb: 'CHECK, plus we independently call the companies to confirm specs, materials, hardware, exclusions and costs.' }
};

// Once a case has passed this point, the customer's own upload/edit link becomes
// read-only — the advisor is (or may already be) working on it, so allowing further
// silent edits from the customer side could invalidate work in progress.
const CUSTOMER_EDITABLE_STATUSES = new Set(['INTAKE_PENDING', 'PAYMENT_PENDING', 'PAYMENT_SUBMITTED']);
const MAX_QUOTES_PER_CASE = 6; // overall documents (quotations + supporting) per case
const MAX_QUOTATION_DOCS_PER_CASE = 3; // quotation documents specifically, separate from supporting docs
const DOC_TYPES = new Set(['QUOTATION', 'SUPPORTING']);
const DOC_SUBTYPES = new Set(['Floor plan', 'Photo', 'Previous communication', 'Reference design', 'Other']);

const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.doc', '.docx'];
const ALLOWED_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (!ALLOWED_EXT.includes(`.${ext}`)) {
      return cb(new Error('Unsupported file type. Please upload a PDF, Word document, or image (jpg/png/webp).'));
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Unsupported file type. Please upload a PDF, Word document, or image (jpg/png/webp).'));
    }
    cb(null, true);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getCaseOr404(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    res.status(404).render('404', { BRAND_NAME: res.app.locals.BRAND_NAME });
    return null;
  }
  const c = await db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) { res.status(404).render('404', { BRAND_NAME: res.app.locals.BRAND_NAME }); return null; }
  return c;
}

// A handful of required-field checks server-side (the HTML `required` attribute
// helps the customer but is not a security or data-integrity control on its own).
function validateIntake(body) {
  const errors = [];
  if (!body.customer_name || !body.customer_name.trim()) errors.push('Name is required.');
  if (!body.customer_phone || !/^[0-9+\-\s()]{7,20}$/.test(body.customer_phone.trim())) errors.push('A valid phone number is required.');
  if (!body.city || !body.city.trim()) errors.push('City is required.');
  if (!body.budget_range || !body.budget_range.trim()) errors.push('Budget range is required.');
  if (!body.decision_needed || !body.decision_needed.trim()) errors.push('Please describe the decision you need help with.');
  if (body.customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.customer_email.trim())) errors.push('Email address looks invalid.');
  return errors;
}

module.exports = function ({ startCaseLimiter, uploadLimiter, verifyCsrf }) {
  const router = express.Router();

  router.get('/terms', async (req, res) => res.render('terms', legal));
  router.get('/privacy', async (req, res) => res.render('privacy', legal));
  router.get('/disclaimer', async (req, res) => res.render('disclaimer', legal));

  // ---- Landing page ----
  router.get('/', async (req, res) => {
    res.render('landing', { SERVICES });
  });

  // ---- Choose service ----
  router.get('/start', async (req, res) => {
    res.render('start-case', { SERVICES, error: null });
  });

  router.post('/start', startCaseLimiter, verifyCsrf, async (req, res) => {
    const service = req.body.service;
    if (!SERVICES[service]) {
      return res.render('start-case', { SERVICES, error: 'Please choose a service.' });
    }
    const id = uuidv4();
    await db.prepare(`INSERT INTO cases (id, service, price_inr, status) VALUES (?, ?, ?, 'PAYMENT_PENDING')`)
      .run(id, service, SERVICES[service].price);
    res.redirect(`/case/${id}/pay`);
  });

  // ---- Payment instructions (manual / placeholder for V1) ----
  function renderPayment(res, c, error) {
    res.render('payment', {
      c, service: SERVICES[c.service],
      upiId: process.env.UPI_ID || 'yourupi@bank',
      payeeName: process.env.PAYEE_NAME || 'Interior Decision Advisor',
      businessPhone: process.env.BUSINESS_PHONE || '',
      error,
    });
  }

  router.get('/case/:id/pay', async (req, res) => {
    const c = await getCaseOr404(req, res);
    if (!c) return;
    renderPayment(res, c, null);
  });

  router.post('/case/:id/pay', verifyCsrf, async (req, res) => {
    const c = await getCaseOr404(req, res);
    if (!c) return;
    const ref = (req.body.payment_reference || '').trim().slice(0, 200);
    if (!ref) {
      return renderPayment(res, c, 'Please enter your UPI/transaction reference so we can confirm payment.');
    }
    await db.prepare(`UPDATE cases SET payment_reference = ?, status = 'PAYMENT_SUBMITTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(ref, c.id);
    res.redirect(`/case/${c.id}/intake`);
  });

  // ---- Intake ----
  router.get('/case/:id/intake', async (req, res) => {
    const c = await getCaseOr404(req, res);
    if (!c) return;
    res.render('intake', { c, error: null, ...legal });
  });

  router.post('/case/:id/intake', verifyCsrf, async (req, res) => {
    const c = await getCaseOr404(req, res);
    if (!c) return;
    if (!CUSTOMER_EDITABLE_STATUSES.has(c.status)) {
      return res.status(403).render('intake', { c, error: 'This case has already been submitted and can no longer be edited here.', ...legal });
    }
    const errors = validateIntake(req.body);
    if (errors.length) {
      return res.render('intake', { c: { ...c, ...req.body }, error: errors.join(' '), ...legal });
    }
    const {
      customer_name, customer_phone, customer_email, city,
      budget_range, decision_needed, priorities, timeline, notes_from_customer
    } = req.body;
    await db.prepare(`
      UPDATE cases SET
        customer_name = ?, customer_phone = ?, customer_email = ?, city = ?,
        budget_range = ?, decision_needed = ?, priorities = ?, timeline = ?, notes_from_customer = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      customer_name.trim().slice(0, 200), customer_phone.trim().slice(0, 30), (customer_email || '').trim().slice(0, 200),
      city.trim().slice(0, 100), budget_range.trim().slice(0, 100), decision_needed.trim().slice(0, 2000),
      (priorities || '').trim().slice(0, 2000), (timeline || '').trim().slice(0, 200), (notes_from_customer || '').trim().slice(0, 2000),
      c.id
    );
    res.redirect(`/case/${c.id}/upload`);
  });

  // ---- Upload quotations ----
  router.get('/case/:id/upload', async (req, res) => {
    const c = await getCaseOr404(req, res);
    if (!c) return;
    const quotes = await db.prepare('SELECT * FROM quotes WHERE case_id = ? ORDER BY id').all(c.id);
    res.render('upload', { c, quotes, error: null, locked: !CUSTOMER_EDITABLE_STATUSES.has(c.status), ...legal });
  });

  router.post('/case/:id/upload', uploadLimiter, async (req, res, next) => {
    const c = await getCaseOr404(req, res);
    if (!c) return;
    if (!CUSTOMER_EDITABLE_STATUSES.has(c.status)) {
      // once the case has been submitted the advisor may already be working on it — lock further customer uploads
      const quotes = await db.prepare('SELECT * FROM quotes WHERE case_id = ? ORDER BY id').all(c.id);
      return res.status(403).render('upload', { c, quotes, error: 'This case has already been submitted and can no longer be modified. Please contact us if you need to add something.', locked: true, ...legal });
    }
    const existingCount = (await db.prepare('SELECT COUNT(*) n FROM quotes WHERE case_id = ?').get(c.id)).n;
    if (existingCount >= MAX_QUOTES_PER_CASE) {
      const quotes = await db.prepare('SELECT * FROM quotes WHERE case_id = ? ORDER BY id').all(c.id);
      return res.render('upload', { c, quotes, error: `You can upload up to ${MAX_QUOTES_PER_CASE} documents per case.`, locked: false, ...legal });
    }
    // multer parses the multipart body first, THEN we can check req.body._csrf —
    // form fields (including _csrf) aren't populated until multer has run.
    upload.single('quote_file')(req, res, async (err) => {
      if (err) {
        const quotes = await db.prepare('SELECT * FROM quotes WHERE case_id = ? ORDER BY id').all(c.id);
        return res.render('upload', { c, quotes, error: err.message, locked: false, ...legal });
      }
      if (!req.session || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Invalid or missing CSRF token. Please reload the page and try again.');
      }
      const docType = DOC_TYPES.has(req.body.doc_type) ? req.body.doc_type : 'QUOTATION';
      if (docType === 'QUOTATION') {
        const quotationCount = (await db.prepare(`SELECT COUNT(*) n FROM quotes WHERE case_id = ? AND (doc_type = 'QUOTATION' OR doc_type IS NULL)`).get(c.id)).n;
        if (quotationCount >= MAX_QUOTATION_DOCS_PER_CASE) {
          const quotes = await db.prepare('SELECT * FROM quotes WHERE case_id = ? ORDER BY id').all(c.id);
          return res.render('upload', { c, quotes, error: `You can upload up to ${MAX_QUOTATION_DOCS_PER_CASE} quotation documents per case.`, locked: false, ...legal });
        }
      }
      if (req.file) {
        const companyName = (req.body.company_name || '').trim().slice(0, 100) || 'Unnamed company';
        const docSubtype = docType === 'SUPPORTING' && DOC_SUBTYPES.has(req.body.doc_subtype) ? req.body.doc_subtype : null;
        const fileName = `documents/${Date.now()}-${req.file.originalname}`;

        const { data, error } = await supabase
          .storage
          .from('interior-advisor-files')
          .upload(fileName, req.file.buffer, {
            contentType: req.file.mimetype,
            upsert: false,
          });

        if (error) {
          console.error('Supabase Storage error:', error);
          return res.status(500).send('File upload failed');
        }

        console.log('Uploaded:', data.path);

        await db.prepare(`
          INSERT INTO quotes (case_id, company_name, original_filename, stored_filename, file_type, doc_type, doc_subtype)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(c.id, companyName, req.file.originalname.slice(0, 255), data.path, req.file.mimetype, docType, docSubtype);
      }
      res.redirect(`/case/${c.id}/upload`);
    });
  });

  router.post('/case/:id/upload/:quoteId/delete', verifyCsrf, async (req, res) => {
    const c = await getCaseOr404(req, res);
    if (!c) return;
    if (!CUSTOMER_EDITABLE_STATUSES.has(c.status)) {
      return res.status(403).send('This case can no longer be modified.');
    }
    const q = await db.prepare('SELECT * FROM quotes WHERE id = ? AND case_id = ?').get(req.params.quoteId, c.id);
    if (q) {
      if (q.stored_filename) {
        const { error: storageDeleteError } = await supabase.storage
          .from('interior-advisor-files')
          .remove([q.stored_filename]);
        if (storageDeleteError) console.warn('Supabase Storage delete warning:', storageDeleteError.message);
      }
      await db.prepare('DELETE FROM quotes WHERE id = ?').run(q.id);
    }
    res.redirect(`/case/${c.id}/upload`);
  });

  // ---- Submit case ----
  router.post('/case/:id/submit', verifyCsrf, async (req, res) => {
    const c = await getCaseOr404(req, res);
    if (!c) return;
    if (!CUSTOMER_EDITABLE_STATUSES.has(c.status)) {
      return res.redirect(`/case/${c.id}/submitted`);
    }
    const quotes = await db.prepare('SELECT * FROM quotes WHERE case_id = ? ORDER BY id').all(c.id);
    const quotationCount = quotes.filter(q => (q.doc_type || 'QUOTATION') === 'QUOTATION').length;
    if (quotationCount < 1) {
      return res.render('upload', { c, quotes, error: 'Please upload at least one quotation before submitting.', locked: false, ...legal });
    }
    if (!req.body.agree_terms) {
      return res.render('upload', { c, quotes, error: 'Please confirm you have read and agree to the Terms, Privacy Policy and Disclaimer before submitting.', locked: false, ...legal });
    }
    await db.prepare(`UPDATE cases SET status = 'IN_REVIEW', agreed_terms_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
    res.redirect(`/case/${c.id}/submitted`);
  });

  router.get('/case/:id/submitted', async (req, res) => {
    const c = await getCaseOr404(req, res);
    if (!c) return;
    res.render('submitted', { c, service: SERVICES[c.service] });
  });

  // "Talk to an Advisor" — request-based entry point for advisory help that isn't a
  // productized checkout (decision consultation, showroom accompaniment, pre-signing
  // review, execution-phase support). Not a paid flow: just a message the advisor
  // follows up on directly. CHECK/VERIFY remain the only self-service paid products.
  const JOURNEY_STAGES = [
    'Not yet contacted any interior company',
    'Comparing interior companies / getting quotations',
    'Have quotation(s), deciding whom to choose',
    'About to sign / finalizing with a company',
    'Project already in progress',
    'Something else'
  ];

  router.get('/talk-to-advisor', async (req, res) => {
    res.render('talk-to-advisor', { error: null, JOURNEY_STAGES });
  });

  router.post('/talk-to-advisor', startCaseLimiter, verifyCsrf, async (req, res) => {
    const b = req.body || {};
    const errors = [];
    if (!b.name || !b.name.trim()) errors.push('Name is required.');
    if (!b.phone || !/^[0-9+\-\s()]{7,20}$/.test(b.phone.trim())) errors.push('A valid phone number is required.');
    if (!b.message || !b.message.trim()) errors.push('Please briefly describe what decision you need help with.');
    if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) errors.push('Email address looks invalid.');
    if (errors.length) {
      return res.render('talk-to-advisor', { error: errors.join(' '), JOURNEY_STAGES });
    }
    await db.prepare(`INSERT INTO advisory_requests (name, phone, email, city, stage, message) VALUES (?, ?, ?, ?, ?, ?)`).run(
      b.name.trim().slice(0, 200),
      b.phone.trim().slice(0, 30),
      (b.email || '').trim().slice(0, 200),
      (b.city || '').trim().slice(0, 100),
      (b.stage || '').trim().slice(0, 100),
      b.message.trim().slice(0, 2000)
    );
    res.render('talk-to-advisor-sent', {});
  });

  return router;
};
