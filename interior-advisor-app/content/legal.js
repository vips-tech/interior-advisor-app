// content/legal.js
//
// Single source of truth for customer-facing legal/policy text used across
// the app (checkout acceptance, footer links, and the final report footer).
//
// SOURCE MAPPING (see project doc "V1 MVP Specification" / uploaded business docs):
//   - shortDisclaimerCheckout   <- Customer Disclaimer.docx, §18 "Short Version — For Website/Checkout"
//   - shortDisclaimerReport     <- Customer Disclaimer.docx, §19 "Short Version — For the Report"
//   - acknowledgement           <- Customer Disclaimer.docx, §17 "Customer Acknowledgement"
//   - privacyNotice             <- Privacy Policy.docx, §30 "Simple Customer Privacy Notice"
//   - independenceStatement     <- Conflict of Interest & Referral Policy.docx, §40
//   - termsAcceptance           <- Terms of Service & Customer Agreement.docx, §37
//
// These documents are marked "Launch Draft — Legal Review Required" in the
// source material. That status is preserved here and surfaced in the UI
// (see views/terms.ejs, privacy.ejs, disclaimer.ejs) rather than presented
// as finalized legal text. Do not remove the legal-review notice without
// an actual legal review.
//
// Full-length ToS / Privacy Policy / Disclaimer / Conflict of Interest text
// remains in the original uploaded documents as the historical/reference
// version — this file holds the condensed, product-integrated version used
// in the live V1 app, with pricing updated to the current CHECK/VERIFY ladder.

const LEGAL_REVIEW_NOTICE =
  'These terms are a launch draft prepared by the business and have not yet been reviewed by a qualified legal professional. They will be updated after legal review.';

const shortDisclaimerCheckout =
  `Disclaimer: Our service provides independent decision support based on the documents, information and company responses available to us. ` +
  `We do not guarantee the future performance, pricing, quality, timeline or outcome of any interior company or project. Our recommendation is ` +
  `customer-specific and does not replace your responsibility to verify final technical and commercial terms before signing.`;

const shortDisclaimerReport =
  `Important: This assessment reflects the information available to us at the time of review and is intended to support — not replace — your own decision. ` +
  `Company statements, quotations, pricing, materials, timelines and other terms may change. Verify all final technical and commercial terms directly with the ` +
  `selected provider before signing. We do not guarantee the future performance or outcome of any provider or project.`;

const independenceStatement =
  `We work for the homeowner. Our advisory service is based on your requirements and the evidence we find. Providers do not pay to receive a favourable ` +
  `assessment or recommendation. In this V1 service we have no referral or commission relationships with any interior company.`;

const privacyNotice =
  `Your information is used to understand your interior project, provide the requested advisory service, communicate with you, analyse the quotations/documents ` +
  `you provide and deliver your report. Where necessary to perform the service, relevant information may be shared with an interior company for clarification. ` +
  `We do not sell your personal information. See our full Privacy Policy for details.`;

const acknowledgement =
  `I understand that this service provides independent decision support based on the information available at the time of analysis. I understand that the ` +
  `assessment and recommendation are not guarantees of future project performance, pricing, quality or outcome. I understand that I remain responsible for ` +
  `verifying final terms and making the final decision. I have read and agree to the Terms of Service, Privacy Policy and Disclaimer.`;

const termsSummaryPoints = [
  'This is an independent advisory and decision-support service — we do not act as your interior contractor.',
  'CHECK (₹2,000): review and comparison of up to 3 quotations, gaps flagged, one written assessment, one consultation up to ~60 minutes, delivered in 2–4 business days.',
  'VERIFY (₹5,000): everything in CHECK, plus we independently contact each company to confirm specifications, materials, hardware, exclusions and costs, and request clarification/revised quotations where needed.',
  'We do not guarantee any interior company’s future performance, pricing, timeline, quality, or that our service will reduce your budget or find the cheapest option.',
  'Our recommendation is based on your stated priorities and the information available to us — it is not a universal ranking, and it does not replace your responsibility to verify final terms before signing.',
  'A company statement we relay is that company’s position, not automatically independently verified fact, unless we label it as verified.',
  'This service is not legal advice, structural/electrical/architectural certification, or a material lab test.',
  'A refund is based on whether we delivered the agreed service, not on whether you agree with our recommendation or later change your mind.',
  'We may use AI tools internally (extraction, comparison drafting, report drafting) reviewed and approved by a human advisor before anything reaches you.',
  'Proposed governing law/jurisdiction: India, Chennai, Tamil Nadu (subject to legal review).'
];

const privacySummaryPoints = [
  'We collect only what is reasonably necessary to deliver the service: your contact details, project/budget information, and the quotations/documents you upload.',
  'Your uploaded quotations and documents are treated as confidential and used to provide your service — not published or used as marketing examples without your permission.',
  'For VERIFY cases, we may share information reasonably necessary with an interior company solely to clarify your quotation.',
  'We may use AI tools internally to help extract, organize, compare and draft — customer data sent to these tools is minimized and not treated as public.',
  'We do not sell your personal information, and do not send marketing without an opt-out.',
  'We aim to retain case files only as long as reasonably necessary, and take reasonable security measures to protect them.',
  'This policy is written with reference to India’s DPDP Act 2023 and its 2025 Rules; a full legal review is still required before this is treated as final.'
];

module.exports = {
  LEGAL_REVIEW_NOTICE,
  shortDisclaimerCheckout,
  shortDisclaimerReport,
  independenceStatement,
  privacyNotice,
  acknowledgement,
  termsSummaryPoints,
  privacySummaryPoints,
};
