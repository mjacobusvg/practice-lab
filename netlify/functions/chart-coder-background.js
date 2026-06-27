// netlify/functions/chart-coder-background.js
// Standalone Netlify BACKGROUND function for the Chart Audit + Coder.
// The "-background" filename suffix gives this function Netlify's 15-minute
// execution limit (vs the ~26-30s synchronous/inactivity cap that was killing
// the Inngest-based version). It runs the three-pass analysis (audit, MDM eval,
// adversarial review) on Sonnet, then writes the result to the tool_jobs table.
// The browser polls tool_jobs via chart-coder-poll.
//
// No Inngest. Invoked directly by chart-coder-trigger via HTTP POST.
//
// PHI note: the chart note is processed transiently and sent to the Anthropic
// API (BAA-covered). It is NOT written to the job row or logged.

const https = require('https');
const { verifyToken } = require('./_lib/session');

// ── Prompts (verbatim from pm-chart-coder.html) ──────────────────────────────

const CC_AUDIT_PROMPT = `You are a psychiatric chart documentation auditor. Your job is to find internal inconsistencies, contradictions, and documentation gaps in a completed psychiatric note BEFORE it is coded. You are NOT coding the note. You are checking whether the note is internally consistent and audit-ready.

Read the entire note carefully. Compare every section against every other section. Flag any of the following:

INCONSISTENCIES (statements in one section that contradict another):
- HPI symptom reports that contradict ROS (e.g. patient reports insomnia in HPI but ROS says sleep disturbance negative)
- Medication doses or names in HPI that don't match the Medications list
- Assessment discusses a medication change but Plan says something different
- HPI says one dose, Plan says a different dose
- MSE findings that contradict HPI or Assessment (e.g. MSE says euthymic but Assessment says depressed)
- Diagnosis in Assessment not reflected in the problem list, or vice versa
- Patient reports substance use in HPI but substance use section says denies

TIME DISCREPANCIES (VERY NARROW SCOPE — most notes will have ZERO time issues):
The ONLY time issue worth flagging is when the note contains two DIFFERENT numbers for PSYCHOTHERAPY time specifically. Example: "Time: 18 minutes" in one place and "Time spent on psychotherapy services only: 17 minutes" in another place. Those are two claims about the SAME thing that disagree.

EVERYTHING ELSE ABOUT TIME IS NORMAL AND MUST NOT BE FLAGGED:
- Total visit time (e.g. "25 minutes") being larger than psychotherapy time (e.g. "20 minutes") is CORRECT. The difference is E/M time. This is how psychiatric billing works. NEVER flag this.
- Start/end time matching total time but differing from psychotherapy time is CORRECT. NEVER flag this.
- Short E/M time is CORRECT. A 5-minute E/M portion is normal for stable follow-ups. NEVER flag this.
- Do NOT do subtraction between total time and psychotherapy time. Do NOT comment on it. Do NOT mention it.

If you cannot identify two conflicting statements about psychotherapy time, return an empty time_issues array.

DOCUMENTATION GAPS THAT AFFECT AUDIT DEFENSIBILITY:
- Plan references a medication not discussed anywhere in HPI or Assessment
- Assessment makes clinical claims not supported by any HPI content
- Psychotherapy intervention documented but no time stated
- Medication changed but no rationale documented
- Safety assessment missing when clinical content suggests it should be present (e.g. patient mentions hopelessness but no SI screening documented)

PSYCHOTHERAPY ADD-ON SUFFICIENCY (only evaluate this if the note appears to bill or document a psychotherapy add-on — 90833/90836/90838 — or contains a psychotherapy section):
A psychotherapy add-on is one of the most audited and most often denied elements in psychiatric billing. The central failure is documentation that is actually MEDICATION MANAGEMENT COUNSELING (already bundled into and paid by the E/M code) being presented as billable psychotherapy. Apply this test rigorously and flag gaps.

THE BUNDLING DISTINCTION (the most important check):
- BUNDLED INTO E/M, NOT billable psychotherapy: teaching how to take the medication, what side effects to watch for, lab/BP/vitals monitoring, dosing timing, substance avoidance counseling, adherence counseling, follow-up planning, and discussion of the medication plan. These are medication management counseling and do NOT support a psychotherapy add-on no matter how much time is spent.
- BILLABLE PSYCHOTHERAPY: active therapeutic work targeting the psychiatric condition or its symptoms/behaviors — e.g. teaching about the disorder itself (neurobiology, course, prognosis) with the target being the patient's understanding of and engagement with their illness, cognitive restructuring, processing, skills work, exploring ambivalence, emotional regulation work. Psychoeducation IS a recognized modality, but only when it addresses the psychiatric condition, not the mechanics of medication-taking.
- THE PRACTICAL TEST: would the note still describe a therapeutic encounter if the medication-management content were removed? If no, what is documented is E/M-only and a psychotherapy add-on is not defensible. Flag this explicitly.

THE FIVE REQUIRED ELEMENTS (flag each that is missing or invalid):
1. Modality — must be named AND tied to actual therapeutic work, not medication counseling. "Talk therapy," "counseling," or bare "psychotherapy" are too vague. "Individual psychotherapy via telehealth" names delivery format, not modality.
2. Intervention — the specific active therapeutic technique inside the modality must be documented. Content topics alone are not an intervention. Flag when interventions read as passive/educational ("provided psychoeducation," "discussed," "advised") rather than active therapeutic work, OR when the documented intervention is actually medication counseling.
3. Focus — must be a psychiatric symptom or behavior being therapeutically addressed (e.g. illness-related avoidance, executive-function challenges, emotional regulation, illness beliefs). Flag when the stated focus is medication-management topics (adherence, monitoring, affordability, side-effect tracking).
4. Patient response — must be a response to a THERAPEUTIC intervention, not agreement with the medication plan. Flag "patient agreed with plan" / "engaged" when it responds to med management rather than therapy.
5. Time — psychotherapy-only minutes, documented separately from the E/M. Flag if missing.

When flagging psychotherapy issues, name which of the five elements fail and whether the deeper problem is that the content is medication management rather than psychotherapy.

AI SCRIBE HALLUCINATION PATTERNS (flag these specifically):
Many clinicians use AI scribes that generate draft notes. These tools commonly introduce errors that weaken audit defensibility. Watch for:
- Symptoms documented in ROS or Assessment that were never mentioned in HPI (fabricated symptoms)
- Denials documented that were never actually asked about (inferred negatives from silence)
- Findings stated with more clinical certainty than the HPI content supports (e.g. "patient reports significant improvement" when HPI says "doing okay")
- Treatment recommendations or clinical decisions in the Assessment that are not reflected in the Plan (or vice versa)
- Medications captured with wrong names, wrong doses, or wrong frequencies compared to the medication list
- Mental health content discussed in HPI that is absent from the Assessment (AI scribes miss mental health details at high rates)
- MDM complexity inflated by assessment language that overstates what actually happened in the visit (e.g. "comprehensive evaluation" for a routine follow-up, or listing clinical reasoning the note doesn't actually support)
- Consent or disclosure language that appears auto-generated rather than clinician-written (e.g. "patient was advised of and consented to" without corresponding documentation of that conversation)

DO NOT flag:
- Stylistic preferences or formatting
- Missing sections that are optional
- Things that are clinically reasonable even if not explicitly stated
- Boilerplate or template language that is clearly intentional (e.g. crisis line information, standard plan language)

Respond ONLY with JSON. No markdown, no backticks.

{
  "inconsistencies": [
    {
      "type": "hpi_vs_ros" or "hpi_vs_plan" or "hpi_vs_meds" or "assessment_vs_plan" or "mse_vs_assessment" or "diagnosis_mismatch" or "substance_use_mismatch" or "fabricated_symptom" or "inferred_denial" or "overstated_finding" or "missing_mental_health_content" or "inflated_complexity" or "other",
      "sections": ["section 1", "section 2"],
      "detail": "Specific description of the contradiction with quotes from the note",
      "severity": "high" or "moderate" or "low",
      "audit_impact": "One sentence on how this could affect an audit"
    }
  ],
  "time_issues": [
    {
      "detail": "Specific time discrepancy with the numbers",
      "severity": "high" or "moderate" or "low"
    }
  ],
  "documentation_gaps": [
    {
      "detail": "Specific gap description",
      "severity": "high" or "moderate" or "low",
      "audit_impact": "One sentence on how this could affect an audit"
    }
  ],
  "psychotherapy_issues": [
    {
      "elements_failed": ["modality" and/or "intervention" and/or "focus" and/or "patient_response" and/or "time"],
      "is_actually_em_only": true or false,
      "detail": "Specific description: which elements fail, and whether the content is medication management rather than psychotherapy, with quotes from the note",
      "severity": "high" or "moderate" or "low",
      "audit_impact": "One sentence on the add-on denial / takeback risk"
    }
  ],
  "clean": true or false
}

If the note has no issues, return {"inconsistencies":[],"time_issues":[],"documentation_gaps":[],"psychotherapy_issues":[],"clean":true}.
Be thorough but precise. Only flag real problems, not nitpicks.`;

const CC_MDM_EVAL_PROMPT = `You are an expert psychiatric E/M coder evaluating Medical Decision Making under the 2021/2025 guidelines.

Read this chart note. Evaluate all three MDM axes: Problems, Data, and Risk.

You already know the MDM framework. Apply it accurately. Do not undercode, but do not overcode either. Code what this visit actually is, not what the patient's lifetime acuity suggests.

For Problems: Evaluate what is happening at THIS visit, not the patient's full diagnostic history.

PROBLEMS COUNTING RULES:
- Count each diagnosis on the problem list that is being actively addressed in the visit
- Separate ICD codes = separate problems for MDM purposes, regardless of pathophysiological relationship
- Do NOT collapse related conditions (e.g. depression + anxiety + insomnia) into "one complex" — count each diagnosis being managed
- If there are separate medications, separate clinical reasoning, or separate diagnostic codes being addressed, they are separate problems
- Focus on what the clinician is documenting and managing, not theoretical diagnostic relationships
- A patient with depression (F33.1), GAD (F41.1), and insomnia (G47.00) each with active medications and assessment discussion has THREE problems, not one

Low: 1 stable chronic illness being managed without change, OR 2 or more self-limited problems. A stable follow-up where one condition is well-controlled, the patient reports improvement or stability, and the clinician renews medications without changes IS low. "Deciding not to change a working regimen" for a single stable condition is routine management, not a complex clinical decision. Do not count medications managed by other providers (e.g. PCP-managed antihypertensives) as adding psychiatric complexity.

Moderate: 2 or more stable chronic illnesses, OR 1 or more chronic illnesses with mild exacerbation, OR 1 undiagnosed new problem. The distinction from Low is: either multiple conditions are being actively managed, or one condition is showing worsening that requires clinical attention beyond routine renewal. "Actively managed" does NOT require a medication change. It includes: documented monitoring of a condition that interacts with treatment decisions for another condition (e.g. substance use disorders being monitored in the context of stimulant prescribing), documented risk-benefit analysis about continuing a treatment given another condition, and clinical reasoning about how multiple diagnoses affect each other at this visit. Count the diagnoses the clinician is actually reasoning about in the assessment, not just the ones with medication changes.

High: Determined by ANY of the following three pathways:

PATHWAY 1 — HIGH-COMPLEXITY DECISION-MAKING: New diagnoses being established that require immediate high-risk treatment decisions. Starting controlled substances or high-risk medications in the context of diagnostic uncertainty (e.g. stimulant trial with unresolved bipolar concerns). Treatment decisions requiring extensive clinical reasoning due to competing risks. Complex medication management with multiple simultaneous adjustments, new starts, or dose changes alongside safety considerations. If the clinician documents substantial decision-making around diagnostic uncertainty, medication risks, new diagnoses, or complex treatment decisions, Problems is HIGH.

PATHWAY 2 — SEVERE EXACERBATION: Active suicidal ideation (passive or active), recent psychiatric ER visit, self-discontinuation of critical medications with emerging destabilization, psychotic symptoms with safety concerns, acute functional deterioration, medication-induced adverse events requiring immediate management changes, or clinical situations where higher level of care was discussed, offered, or declined.

PATHWAY 3 — THREAT TO LIFE OR FUNCTION: A condition that poses a direct threat to life or bodily function at this visit.

High Problems is about the decision-making burden and clinical judgment required, not just crisis severity. Do not deflate to moderate simply because conditions appear "stable" or there is "no severe exacerbation" when Pathway 1 is clearly met.

Do not inflate stable single-condition visits to high just because the patient carries multiple diagnoses or has a complex history. But do not deflate genuinely complex decision-making visits to moderate just because there is no acute crisis.

For Risk: "If any clinical decision documented in this note turned out to be wrong, what is the worst plausible outcome for the patient?" That determines the risk level. This applies to decisions to prescribe, decisions NOT to prescribe, decisions about level of care, safety assessments, and any other clinical judgment documented in the note.

CRITICAL RULE — Prescription Drug Management: Per the AMA MDM table, "prescription drug management" is an example of moderate risk. This does NOT require starting, stopping, or changing a medication. Continuing a prescription medication IS prescription drug management when the note documents patient-specific medication assessment and a treatment decision — not merely sending a refill. Moderate-risk indicators: PMP review, cardiac monitoring, substance use screening, drug interaction assessment, explicit risk-benefit analysis about continuing given comorbidities, or documented assessment of tolerability/side effects/adherence that informs the decision to continue. The standard psychiatric interview (ROS, MSE, "how are you doing") does NOT by itself constitute prescription drug management. The question is: did the clinician document specific medication evaluation work beyond the routine interview that informed the decision to continue?

Psychiatric visits are systematically undercoded on the Risk axis because coders miss that outpatient crisis management, medication safety decisions, and declined escalations of care are themselves high-risk clinical judgments. Do not make that mistake.

Respond ONLY with JSON. No markdown.

{
  "problems": {
    "level": "minimal" or "low" or "moderate" or "high",
    "evidence": ["specific finding from note"],
    "reasoning": "paragraph explaining determination"
  },
  "data": {
    "level": "minimal" or "limited" or "moderate" or "extensive",
    "evidence": ["specific data item from note"],
    "reasoning": "paragraph explaining determination"
  },
  "risk": {
    "level": "minimal" or "low" or "moderate" or "high",
    "evidence": ["specific risk factor from note"],
    "reasoning": "paragraph explaining determination",
    "highest_stakes_decision": "one sentence: the single clinical decision in this note where being wrong has the most serious consequences"
  }
}`;

const CC_REVIEW_PROMPT = `You are a senior psychiatric coding reviewer. You receive the original chart note and an initial MDM evaluation from another coder.

YOUR JOB IS VERIFICATION, NOT RE-CODING. For each axis, ask:
1. Does Pass 1's reasoning cite real evidence from the note? (not fabricated or assumed)
2. Does that evidence actually support the level Pass 1 chose?
3. Is the logic sound given the MDM definitions below?

If the answer to all three is YES: confirm the rating.
If any answer is NO: correct it, citing the specific evidence or logic error.

Do NOT form your own independent opinion and override. Do NOT search for reasons to disagree. Your role is peer review: check the work, confirm if defensible, correct if wrong.

=== REFERENCE DEFINITIONS (use these to verify Pass 1's logic) ===

PROBLEMS COUNTING RULES:
- Count each diagnosis on the problem list that is addressed in the assessment or has active medication management
- Separate ICD codes = separate problems, regardless of pathophysiological relationship
- Do NOT collapse related psychiatric conditions into "one interconnected complex"
- Respect the clinician's diagnostic framework

Low: 1 stable chronic illness being managed without change, OR 2 or more self-limited problems. One condition, routine renewal, no changes, patient doing well.

Moderate: 2 or more stable chronic illnesses being actively managed, OR 1 or more chronic illnesses with mild exacerbation, OR 1 undiagnosed new problem. "Actively managed" includes documented monitoring, risk-benefit analysis, and clinical reasoning about how conditions interact — not just medication changes.

High: Determined by ANY of the following three pathways:

PATHWAY 1 — HIGH-COMPLEXITY DECISION-MAKING: New diagnoses requiring high-risk treatment decisions. Starting controlled substances or high-risk medications with diagnostic uncertainty or competing risks. Complex medication management with multiple simultaneous adjustments. Substantial documented clinical reasoning around diagnostic uncertainty, medication risks, or complex treatment decisions.

PATHWAY 2 — SEVERE EXACERBATION: Active suicidal ideation, recent ER visit, medication-induced adverse events requiring immediate changes, psychotic symptoms, acute functional deterioration, or higher level of care discussed/declined.

PATHWAY 3 — THREAT TO LIFE OR FUNCTION: A condition posing direct threat to life or bodily function at this visit.

VERIFICATION RULE FOR PROBLEMS: If Pass 1 rated Problems at a level and cited evidence that fits the definition above, confirm it. If Pass 1 rated high and cited Pathway 1 evidence (new diagnosis, controlled substance start, diagnostic uncertainty, multiple med changes), and that evidence exists in the note, the rating is correct. Do not override it because the patient "seems stable" or because you would characterize the complexity differently. The question is: is Pass 1's reasoning defensible given the note content?

For Data: Verify that the data sources Pass 1 cited actually appear in the note. Re-count if needed.

For Risk: Verify that the clinical decisions Pass 1 cited are documented in the note and that the risk characterization is defensible.

CRITICAL RULE — Prescription Drug Management: Per the AMA MDM table, "prescription drug management" is an example of moderate risk. Continuing a medication IS prescription drug management when the note documents patient-specific assessment (tolerability, side effects, safety monitoring, clinical reasoning about continuing). The standard interview alone (ROS, MSE, symptom check) is NOT prescription drug management. Documented medication-specific evaluation with clinical reasoning IS moderate risk.

After verification, apply the 2-of-3 rule MECHANICALLY. List your three final axis levels (Problems, Data, Risk) after any corrections. Then count: the E/M level is the HIGHEST level that AT LEAST TWO of the three axes reach. A level reached by only ONE axis CANNOT be the final level. Example: high/moderate/moderate = moderate (99214), because only one axis is high but two reach moderate. Example: high/high/moderate = high (99215). Do this count explicitly after any axis correction, and make the final code match the count. If a correction lowered an axis, re-run this count, do not retain the pre-correction code.

=== CPT 2025 CRITICAL RULE ===
When a psychotherapy add-on code (90833, 90836, 90838) is billed alongside an E/M code, TIME CANNOT BE USED as the basis for E/M level selection. E/M level MUST be determined by MDM complexity alone. (CPT 2025, p. 766)

=== E/M CODE MAPPING (Established Patient) ===
99212: straightforward MDM (2 of 3 at minimal/low)
99213: low MDM (2 of 3 at low)
99214: moderate MDM (2 of 3 at moderate)
99215: high MDM (2 of 3 at high)

=== E/M CODE MAPPING (New Patient) ===
99202: straightforward MDM
99203: low MDM
99204: moderate MDM
99205: high MDM

Respond ONLY with JSON. No markdown.

{
  "corrections": [{"axis": "problems/data/risk", "from": "original level", "to": "corrected level", "reason": "specific evidence or logic error in Pass 1 that necessitates correction"}],
  "final_problems": "level",
  "final_data": "level",
  "final_risk": "level",
  "em_code": "99XXX",
  "em_description": "brief description",
  "two_of_three": "which two axes and at what level determined the code",
  "addon_code": "90833 or 90836 or 90838 or none",
  "addon_time": "documented time or null",
  "modifiers": ["25", "95"],
  "coding_support": "Strong or Moderate or Weak",
  "coding_support_reason": "one sentence",
  "audit_defensibility": "Strong or Moderate or Weak",
  "audit_reason": "one sentence",
  "documentation_gaps": ["gap 1 that could weaken the code", "gap 2"],
  "suggested_language": ["specific language to add to strengthen documentation"],
  "attestation": "A chart-ready MDM attestation for audit defensibility. Use this exact structure: '[Visit type] ([code]) was determined by [level] complexity medical decision making based on: (1) [level] problems — [one sentence with specific clinical content]; (2) [level] data — [one sentence]; (3) [level] risk — [one sentence with specific clinical content]. [2-of-3 rule statement]. Psychotherapy add-on [code] for [X] minutes of [modality]. Modifiers: [list with descriptions].' Do NOT write a visit narrative. Do NOT describe what happened during the visit. This is a structured coding justification, not a progress note summary. For established patients say 'established patient follow-up visit,' for new patients say 'new patient evaluation.'"
}`;

// ── Anthropic call (non-streaming; background fn has 15 min so no timeout race) ──

function ccCallAnthropic(systemPrompt, userMessage, apiKey, maxTokens) {
  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens || 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('Anthropic API error ' + res.statusCode + ': ' + data.substring(0, 200)));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          let text = '';
          if (parsed.content) parsed.content.forEach((b) => { if (b.type === 'text') text += b.text; });
          resolve(text);
        } catch (e) {
          reject(new Error('Invalid JSON from Anthropic: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function ccParseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim()); }
  catch (e) { console.log('CC JSON parse error:', e.message, 'Raw:', (text || '').substring(0, 300)); return null; }
}

async function saveResult(supabaseUrl, supabaseKey, job_id, status, result) {
  const res = await fetch(`${supabaseUrl}/rest/v1/tool_jobs?job_id=eq.${job_id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ status: status, result: JSON.stringify(result) })
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('CC saveResult FAILED:', res.status, t.substring(0, 200));
  } else {
    console.log('CC saveResult OK for job:', job_id);
  }
}

// Background functions return 202 immediately and keep running.
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // AUTH: this background function has a PUBLIC Netlify URL, so it must gate itself
  // (gating only chart-coder-trigger is insufficient). Full-tier only. The trigger
  // forwards the caller's signed token in its internal POST.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) {
    return { statusCode: 401, body: 'Invalid or expired session.' };
  }
  if (!(session.claims.scope === 'member' && session.claims.tier === 'full')) {
    return { statusCode: 403, body: 'This tool requires the full Think Beyond Practice membership.' };
  }

  const { job_id, noteText, visitType, preflightContext } = body;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!job_id || !noteText) {
    return { statusCode: 400, body: 'Missing job_id or noteText' };
  }

  try {
    const userMsg = 'Visit type: ' + (visitType || '') + '\n\nChart note:\n\n' + noteText + (preflightContext || '');

    console.log('CC audit start for job:', job_id);
    const auditRaw = await ccCallAnthropic(CC_AUDIT_PROMPT, 'Chart note to audit:\n\n' + noteText, anthropicKey, 4000);
    const audit = ccParseJSON(auditRaw);
    console.log('CC audit parsed:', audit ? 'OK clean=' + audit.clean : 'NULL parse-failed raw-len ' + (auditRaw ? auditRaw.length : 0));

    console.log('CC mdm start for job:', job_id);
    const mdmRaw = await ccCallAnthropic(CC_MDM_EVAL_PROMPT, userMsg, anthropicKey, 3000);
    const mdm = ccParseJSON(mdmRaw);

    console.log('CC review start for job:', job_id);
    const reviewInput = userMsg + '\n\nINITIAL MDM EVALUATION:\n' + JSON.stringify(mdm, null, 2);
    const reviewRaw = await ccCallAnthropic(CC_REVIEW_PROMPT, reviewInput, anthropicKey, 3000);
    const review = ccParseJSON(reviewRaw);

    await saveResult(supabaseUrl, supabaseKey, job_id, 'complete', { audit: audit, mdm: mdm, review: review });
    console.log('Chart Coder background complete for job:', job_id);
  } catch (err) {
    console.error('Chart Coder background error:', err.message);
    try { await saveResult(supabaseUrl, supabaseKey, job_id, 'error', { error: err.message }); } catch (e) {}
  }

  return { statusCode: 202, body: 'Processing' };
};
