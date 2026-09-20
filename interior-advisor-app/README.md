# Interior Decision Advisor — V1

## Run it

```
npm install
cp .env.example .env   # edit ADVISOR_PASSWORD, UPI_ID, etc.
npm start
```

Open http://localhost:3000 for the customer-facing site.
Advisor workspace: http://localhost:3000/advisor/login.

## Deploy on Vercel

This repo includes Vercel-compatible serverless configuration in [vercel.json](vercel.json). Vercel uses [server.js](server.js) as the Express entrypoint, and the `/` route renders `landing.ejs`.

Important: the app still uses a local SQLite file and local uploads directory by default. That works for local development, but it is not production-safe on Vercel because serverless instances do not keep a writable filesystem between requests. For a real deployment, move the database and file uploads to external services before going live.

Recommended production stack:
- Database: Postgres (Neon/Supabase/Aiven/etc.)
- File storage: S3-compatible bucket (R2/Backblaze/S3)
- Environment variables in Vercel: `SESSION_SECRET`, `ADVISOR_EMAIL`, `ADVISOR_PASSWORD`, `UPI_ID`, `PAYEE_NAME`, `BUSINESS_PHONE`, `NODE_ENV`

The app is ready for Vercel wrapper deployment, but persistent data should be externalized before production use.

## What's built

**Customer side:** Landing page with CHECK (₹2,000) / VERIFY (₹5,000) — no old
pricing anywhere → start case → payment instructions (manual UPI/bank transfer,
reference number captured, no gateway wired yet) → intake → upload quotations
(multiple files, per-company) → Terms/Privacy/Disclaimer acceptance → submit.
Terms, Privacy Policy and Disclaimer pages are live at `/terms`, `/privacy`,
`/disclaimer`, linked from the footer and from the checkout step, condensed
from the uploaded business documents (see `content/legal.js` for the source
mapping). All marked "Legal Review Required" per the source drafts — not
finalized legal text yet.

**Advisor side** (`/advisor/login` — single founder account, no multi-advisor
logic): case dashboard with status filters and payment confirmation; per-case
workspace with customer info, an advisor-completed Decision Profile (condensed
from Customer Decision Profile.docx), quote viewer, an evidence-labeled notes
log, a VERIFY-only company investigation call log, an Apples-to-Apples
comparison table builder, a recommendation editor with a mandatory Conflict of
Interest / Recommendation Integrity check (from Conflict of Interest & Referral
Policy.docx §28), and a report generator that assembles a customer-ready
Markdown report from the case data, with disclaimer and independence-statement
sections built in, downloadable and markable as sent.

**AI-assist** (`content/ai_prompts.js`): internal-only prompt library sourced
from "AI Internal Prompt Workflow & Advisor AI System.docx" (extraction,
normalization+gaps, investigation questions, comparison draft, challenge, report
draft). Each prompt is pre-filled with the case's real data and shown as a
copyable textarea in the case workspace; if `ANTHROPIC_API_KEY` is set in `.env`,
a "Run with Claude" button calls the API directly and shows the result labeled
DRAFT/INTERNAL — nothing is ever sent to a customer automatically.

All of it persists to a local SQLite file at `data/app.db` — no external
services required.

## Security notes (Phase 2)

- Advisor auth: single-account session login, rate-limited (10 attempts/15min), session regenerated on login, `httpOnly`/`sameSite=lax` cookies, `secure` cookies auto-enabled when `NODE_ENV=production`. The password is checked with bcrypt (`bcryptjs`) — set `ADVISOR_PASSWORD_HASH` (generate with `node scripts/hash-password.js yourpassword`) for production, or the simpler plaintext `ADVISOR_PASSWORD` for local dev (hashed in memory at startup).
- Sessions are stored in PostgreSQL through `connect-pg-simple`, not in-memory — they survive a process restart and work across serverless instances.
- CSRF protection: a per-session token is generated and exposed to every view as `csrfToken`; every state-changing (POST) form includes it as a hidden `_csrf` field, and a `verifyCsrf` middleware checks it before the request is processed. The advisor login POST is the one exception (rate-limited instead, since a session may not exist yet for a first-time visitor); every other POST route in both routers is protected.
- Uploaded quotation files are served only through an authenticated advisor route, scoped to both the quote id AND its case id (one case's files can never be fetched via another case's URL), with a resolved-path check against the uploads directory.
- Customer case links (`/case/<uuid>/...`) become **read-only** once a case is submitted — no further edits/uploads/deletes are possible from that link.
- Helmet security headers, JSON/body size limits, and rate limits on case creation and file upload.
- Server-side validation on intake fields and file type/size/count (max 6 files/case, 4MB each, PDF/DOC/DOCX/JPG/PNG/WEBP only, extension + MIME both checked). Uploaded documents are typed as QUOTATION (max 3/case) or SUPPORTING (floor plan/photo/previous communication/reference design/other) — only QUOTATION documents feed the comparison table, recommendation, AI-assist prompts and the customer report; SUPPORTING documents remain viewable/downloadable by the advisor but are reference material only.
- The final recommendation requires an explicit advisor "Approve as final recommendation" action (separate from saving a draft) before a report can be marked sent — editing an approved recommendation clears the approval and requires re-approval.
- Report staleness: once a report is generated, editing the recommendation afterwards marks the report "stale" (a warning banner appears in the case workspace) and blocks "Mark sent to customer" with a 400 until the report is regenerated.
- Report PDF download (`/advisor/cases/:id/report/download-pdf`) is rendered by `lib/reportPdf.js` using `pdfkit`. **This is a simplified markdown-to-PDF renderer, not a full markdown engine** — it recognizes headings (`#`/`##`/`###`), bullet lines (`- `), `|`-delimited table rows, and horizontal rules, rendering everything else as plain paragraphs with bold/italic/code markers stripped. Since the report content is always advisor-authored/edited plain text, this is deliberately limited rather than pulling in a full markdown-to-PDF dependency; unusual formatting in a hand-edited report may not render exactly as typed.

## What's not built yet

- Real payment gateway — currently manual reference-number capture, confirmed
  by the advisor later.
- EXPERIENCE (₹10,000) and ADVISE (₹20,000) — intentionally out of scope for V1.
- The full 34-section Customer Decision Profile / Company Investigation Card /
  Recommendation Worksheet templates — the V1 workspace uses the condensed
  fields that actually drive a recommendation; the originals remain as internal
  reference material (see the uploaded source documents).

## Notes

- Uploaded files are stored under `uploads/` and are **not** served as static
  files — only reachable through an authenticated advisor route (once built),
  so a customer's quotation isn't guessable via a public URL.
- Case links use a random UUID as the case ID (`/case/<uuid>/...`) — good
  enough as a private link for V1 at this volume; not meant as strong auth.


## Vercel + Supabase deployment

1. Create a Supabase project and a **private** Storage bucket named `interior-advisor-files`.
2. Run `supabase/schema.sql` in Supabase SQL Editor.
3. Copy the Supabase **Transaction Pooler** PostgreSQL connection string into Vercel as `DATABASE_URL`. Do not commit it.
4. Add `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, `ADVISOR_EMAIL`, `ADVISOR_PASSWORD`, `UPI_ID`, `PAYEE_NAME`, `BUSINESS_PHONE`, and `NODE_ENV=production` in Vercel Environment Variables.
5. Keep `api/index.js` as the Vercel entry point and use the included `vercel.json`.
6. Do not upload or commit `.env` or `node_modules`.
7. Deploy, then test: landing page -> start -> payment reference -> intake -> upload -> submit -> advisor login -> case -> file download -> report PDF.

The app database is PostgreSQL/Supabase; local SQLite is no longer used by the routes. Uploaded documents are stored in the private Supabase Storage bucket.
