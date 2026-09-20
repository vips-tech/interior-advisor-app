// content/ai_prompts.js
//
// Internal-only prompt library for the advisor workspace's AI-assist buttons.
// Sourced from "AI Internal Prompt Workflow & Advisor AI System.docx" (Prompts 1-16).
// These are NEVER shown to the customer — they exist purely so the advisor
// can extract/normalize/compare/challenge/draft faster, per that document's
// core rule: "The advisor makes the judgment. AI makes the advisor harder to fool."
//
// Each function returns a ready-to-copy prompt string with the case's actual
// data interpolated. The advisor pastes the prompt (and the relevant source
// text) into Claude, reviews the output, and decides what — if anything —
// enters the case record. Nothing here calls out to a model automatically
// unless ANTHROPIC_API_KEY is set (see routes/advisor.js "/ai/run").

function caseContextBlock(c) {
  return [
    `Case ID: ${c.id}`,
    `Service: ${c.service}`,
    `Budget range: ${c.budget_range || 'not provided'}`,
    `Decision the customer is trying to make: ${c.decision_needed || 'not provided'}`,
    `Stated priorities / must-haves: ${c.priorities || 'not provided'}`,
    `Non-negotiables: ${c.non_negotiables || 'not recorded'}`,
    `Timeline: ${c.timeline || 'not provided'}`,
  ].join('\n');
}

// Prompt 1 — Quotation Extraction
function extractionPrompt(c, quote) {
  return `You are an internal quotation extraction assistant for an independent interior decision advisory service.

Extract only information explicitly present in the provided quotation. Do not infer missing information. Do not judge whether the company is good or bad. Do not recommend a company.

Structure the quotation (Company: ${quote.company_name}) into: total quoted price, room/area, scope, quantities, materials, material applications, hardware, finishes, design services, customization, manufacturing/execution information, timeline, payment terms, warranty, exclusions, additional-cost conditions, other commercial terms.

For every field, indicate: Explicitly stated / Partially stated / Not stated. Quote or reference the relevant wording where useful. Never fill a missing field with an assumption.

Case context:
${caseContextBlock(c)}

[Paste the quotation text/content for ${quote.company_name} below this line]`;
}

// Prompt 2 — Normalization
function normalizationPrompt(c, quotes) {
  const names = quotes.map(q => q.company_name).join(', ');
  return `Normalize these interior quotations (${names}) into a common comparison structure. Do not assume that similarly named items have identical specifications. Identify differences in: scope, quantity, material, application, hardware, finish, design, customization, execution, timeline, payment, warranty, exclusions. Where quotations cannot be directly compared, mark the item NEEDS CLARIFICATION. Do not decide which option is better yet.

Case context:
${caseContextBlock(c)}

[Paste the extracted structured data for each quotation below this line]`;
}

// Prompt 3 — Find Information Gaps ("missing information")
function gapsPrompt(c, quotes) {
  const names = quotes.map(q => q.company_name).join(', ');
  return `Review these quotations (${names}) as an independent advisor. Identify information that is missing, vague, contradictory or insufficiently specified. Prioritize the gaps by: Critical (could materially change price, scope, quality expectation, customization, timeline or decision), Important (could influence the customer's decision), Background (useful but unlikely to materially change the decision). Do not assume that a missing item is negative. For every gap, explain: 1. What is missing? 2. Why might it matter? 3. What exact question should the advisor ask? 4. What evidence would resolve it?

Case context:
${caseContextBlock(c)}

[Paste the extracted/normalized quotation data below this line]`;
}

// Prompt 5 — Structure Investigation Notes ("evidence structuring")
function evidenceStructuringPrompt(c, calls) {
  const notes = calls.length
    ? calls.map(call => `Q: ${call.question}\nA: ${call.answer}\nLabel so far: ${call.evidence_label}`).join('\n\n')
    : '[no investigation call notes recorded yet]';
  return `Convert these raw advisor investigation notes into a structured evidence record. Do not improve, reinterpret or strengthen the company's statements. For each finding, identify: 1. Topic 2. Exact company position 3. Evidence source 4. Evidence status (CONFIRMED / VERIFIED / CUSTOMER_REPORTED / UNCONFIRMED / ADVISOR_ASSESSMENT / RISK) 5. What the quotation originally said 6. Whether the investigation clarified, changed or contradicted the quotation 7. Whether written confirmation is still required 8. Potential relevance to the customer. Preserve uncertainty — if the advisor's notes are ambiguous, flag them rather than guessing.

Case context:
${caseContextBlock(c)}

Raw investigation notes:
${notes}`;
}

// Prompt 4 — Investigation Question Generator (used to seed the VERIFY call log)
function investigationQuestionsPrompt(c) {
  return `Based on the customer's priorities and the quotation gaps, create a company investigation question list. Only include questions that could materially improve understanding or change the customer's decision. Group into: Scope, Materials, Hardware, Design, Customization, Manufacturing, Execution, Timeline, Payment, Exclusions, Additional costs, Warranty, After-sales. Make every question specific enough that the company cannot answer with generic marketing language (prefer "What exact material is included for the kitchen carcass?" over "What materials do you use?"). Also identify the 5 highest-priority questions to ask first.

Case context:
${caseContextBlock(c)}

[Paste the quotation gaps / Customer Decision Profile below this line]`;
}

// Prompt 7 — Quotation Comparison (drafts the comparison table)
function comparisonDraftPrompt(c, quotes) {
  const names = quotes.map(q => q.company_name).join(', ');
  return `Compare these companies (${names}) using only the information and evidence provided. Do not produce a universal ranking. Compare: scope, quantity, materials, hardware, finishes, design, customization, execution, timeline, payment, warranty, exclusions, additional-cost risk. For each company identify: strongest relevant offering, weakest relevant offering, important unknowns, important trade-offs, customer-relevant risks. Do not recommend a company yet.

Case context:
${caseContextBlock(c)}

[Paste extracted/verified quotation data and investigation notes below this line]`;
}

// Prompt 6 — Contradiction Check (between quotes, investigation answers, and customer statements)
function contradictionCheckPrompt(c, quotes, calls) {
  const names = quotes.map(q => q.company_name).join(', ');
  return `Review the quotation data and investigation call notes for these companies (${names}) and identify contradictions only — do not compare or recommend. Look for: a company's investigation answer that contradicts its own written quotation; two investigation answers from the same company that contradict each other; a company's claim that contradicts what the customer reported; a claim that seems inconsistent with the stated scope or budget. For each contradiction found, state exactly what was said, where (quote text vs. call answer vs. customer statement), and label each side by evidence type (Confirmed / Verified / Customer Reported / Unconfirmed / Advisor Assessment). Do not decide which side is true — flag it for the advisor to resolve. If no contradictions are found, say so rather than inventing one.

Case context:
${caseContextBlock(c)}

Investigation notes so far: ${calls && calls.length ? JSON.stringify(calls.map(x => ({ company: x.quote_id, q: x.question, a: x.answer, label: x.evidence_label }))) : '[none logged yet]'}

[Paste extracted quotation data below this line]`;
}

// Prompt 8 — Decision Cost Analysis (estimated all-in cost, not just the headline quote)
function decisionCostPrompt(c, quotes, comparisonRows) {
  const names = quotes.map(q => q.company_name).join(', ');
  return `For each of these companies (${names}), estimate the likely all-in cost if the customer proceeds — not just the headline quoted price. Using only the provided quotation/comparison data: list the quoted price, any exclusions the customer would likely need to pay for separately (state your evidence for each), any known upgrade the customer has indicated they want, and any additional cost already identified during investigation. Then give an estimated cost range (low–high), clearly labeling which inputs are Confirmed/Verified vs. an Advisor Assessment estimate. Do not invent exclusion costs that aren't evidenced — where a likely extra cost can't be estimated from the data given, say "cannot be estimated from the information available" rather than guessing a number.

Case context:
${caseContextBlock(c)}

Comparison rows: ${JSON.stringify((comparisonRows || []).map(r => ({ attribute: r.attribute, status: r.status, values: JSON.parse(r.quote_values || '{}') })))}

[Paste quoted prices and known exclusions/additional costs below this line]`;
}

// Prompt 11 — Challenge the Advisor (devil's advocate before finalizing)
function challengePrompt(c, draftRecommendation) {
  return `Act as a skeptical internal quality reviewer. Here is the customer's Decision Profile, quotation comparison, investigation evidence and my preliminary recommendation. Do not produce a new recommendation. Instead, challenge my reasoning. Identify: claims that are unsupported, assumptions presented as facts, important evidence I may have ignored, customer priorities I may have undervalued, important trade-offs I may have missed, unknowns that could change the recommendation, places where I may be biased toward a company, places where the price comparison may not be apples-to-apples, statements that should be softened, questions that should be investigated before finalizing. Be critical but evidence-based. Do not invent negative information about any company.

Case context:
${caseContextBlock(c)}

My preliminary recommendation:
${draftRecommendation || '[not yet drafted]'}`;
}

// Prompt 13 — Report Draft
function reportDraftPrompt(c, quotes, recommendation, comparisonRows) {
  const companies = quotes.map(q => q.company_name).join(', ');
  return `Draft the Interior Quote Check Report using the approved structure. Use only the provided case information. The report should be clear to a homeowner without technical interior-industry knowledge. Explain differences rather than merely listing them.

Structure: 1. Decision Snapshot 2. What We Understood About Your Project 3. Quote Comparison 4. Price Differences 5. Materials 6. Hardware 7. Design and Customization 8. Execution and Timeline 9. Warranty and After-Sales 10. Exclusions and Potential Additional Costs 11. Company-Specific Fit 12. Recommendation 13. Trade-offs 14. Risk and Confidence 15. Before-You-Sign Questions 16. Important Limitations 17. Independence/Referral Disclosure.

Keep facts, company statements, customer reports and advisor assessments clearly distinguishable. Do not invent information. Do not use "best company", "definitely", "guaranteed", "overpriced", "bad company", "fraud" — prefer "Based on your stated priorities...", "The quotation specifies...", "The company confirmed...", "We could not verify...".

Case context:
${caseContextBlock(c)}

Companies reviewed: ${companies}

Recommendation (advisor-approved):
Option: ${recommendation?.recommended_option || '[not yet set]'}
Reasoning: ${recommendation?.reasoning || '[not yet set]'}
Trade-offs: ${recommendation?.trade_offs || '[not yet set]'}
Confidence: ${recommendation?.confidence || '[not yet set]'}
Open questions: ${recommendation?.open_questions || '[not yet set]'}

Comparison rows: ${JSON.stringify(comparisonRows.map(r => ({ attribute: r.attribute, status: r.status, values: JSON.parse(r.quote_values || '{}') })))}

[Paste any additional investigation notes below this line]`;
}

module.exports = {
  extractionPrompt,
  normalizationPrompt,
  gapsPrompt,
  evidenceStructuringPrompt,
  investigationQuestionsPrompt,
  comparisonDraftPrompt,
  contradictionCheckPrompt,
  decisionCostPrompt,
  challengePrompt,
  reportDraftPrompt,
};
