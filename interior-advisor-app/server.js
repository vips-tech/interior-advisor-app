require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const pgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');
const app = express();
const isProd = process.env.NODE_ENV === 'production';

if (isProd) app.set('trust proxy', 1); // needed for secure cookies behind a reverse proxy

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Baseline security headers. CSP is left permissive-but-same-origin since the app
// serves its own CSS/JS only (no external scripts, no inline event handlers needed
// beyond the small advisor.js file) — disable the default upgrade-insecure-requests
// directive so local http development isn't broken.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'upgrade-insecure-requests': null,
      'script-src': ["'self'"],
    },
  },
}));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));
// uploaded quote files are served only via an authenticated advisor route (see routes/advisor.js),
// never directly as static files, so customer-uploaded documents aren't guessable/public.

if (!process.env.SESSION_SECRET && isProd) {
  console.error('SESSION_SECRET is not set — refusing to start in production with the default secret.');
  process.exit(1);
}

app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: 'user_sessions',
      createTableIfMissing: true
    }),

    secret: process.env.SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

// ---- CSRF protection (small custom middleware — no `csurf`, which is deprecated/unmaintained) ----
// Ensure every session has a CSRF token, and expose it to all views as `csrfToken`.
// `saveUninitialized: false` means a session with nothing else in it still won't be
// persisted until something else touches it (e.g. a successful login regenerates the
// session), but req.session.csrfToken is available on `req.session` for the lifetime
// of THIS request/response regardless, which is enough for the login form to render
// a valid token and for the login POST to be checked against it.
app.use((req, res, next) => {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  next();
});
app.use((req, res, next) => {
  res.locals.csrfToken = req.session ? req.session.csrfToken : '';
  next();
});

function verifyCsrf(req, res, next) {
  if (!req.session || req.body._csrf !== req.session.csrfToken) {
    return res.status(403).send('Invalid or missing CSRF token. Please reload the page and try again.');
  }
  next();
}
app.locals.verifyCsrf = verifyCsrf;

// Basic abuse protection on the unauthenticated, write-heavy public endpoints
// (case creation and file upload) and on the advisor login form.
const startCaseLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: 'Too many login attempts. Please try again later.' });

app.locals.BRAND_NAME = 'Interior Decision Advisor';

app.use('/', require('./routes/public')({ startCaseLimiter, uploadLimiter, verifyCsrf }));
app.use('/advisor', require('./routes/advisor')({ loginLimiter, verifyCsrf }));

app.use((req, res) => {
  res.status(404).render('404', { BRAND_NAME: app.locals.BRAND_NAME });
});

// Centralized error handler — avoids leaking stack traces to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `Interior Decision Advisor running on http://localhost:${PORT}`
    );
  });
}

module.exports = app;
