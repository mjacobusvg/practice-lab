// netlify/functions/assessment-instruments.js
//
// Shared instrument definitions + scoring for the Assessment Suite.
// Server-side only. Item text lives here; the patient form receives only the
// items needed to render, and scoring happens here on submit so the client
// never holds scoring logic or severity interpretation.
//
// LICENSING: Every instrument in this file is public domain or free for clinical
// use with attribution (the "cleared" tier from the build planning). Do NOT add
// DASS-21, ISI, or MDQ here (paid commercial licenses) or any instrument whose
// item text is not cleared for reproduction. C-SSRS and ASQ are intentionally
// EXCLUDED from the patient-send pipeline (clinician-administered only; they live
// in pm-crisis-safety-plan.html).
//
// Each instrument:
//   id, name, domain, attribution, itemCount
//   instructionText        - shown to patient above the items
//   options                - response scale [{value, label}] (shared across items
//                            unless an instrument overrides per-item)
//   items                  - [{ id, text, options? }]
//   score(responses)       - returns { total, subscales?, band, bandLabel,
//                            interpretation, flags? } given a responses map
//   chartLanguage(scored)  - returns chart-ready paste-in text
//
// "responses" is a map of itemId -> selected numeric value.

'use strict';

// ── Shared response scales ──────────────────────────────────────────────────

// PHQ-9 / GAD-7 standard 0-3 frequency scale
var FREQ_0_3 = [
  { value: 0, label: 'Not at all' },
  { value: 1, label: 'Several days' },
  { value: 2, label: 'More than half the days' },
  { value: 3, label: 'Nearly every day' }
];

// Yes/No (1/0)
var YES_NO = [
  { value: 1, label: 'Yes' },
  { value: 0, label: 'No' }
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function sumItems(responses, itemIds) {
  var total = 0;
  for (var i = 0; i < itemIds.length; i++) {
    var v = responses[itemIds[i]];
    if (typeof v === 'number' && !isNaN(v)) total += v;
  }
  return total;
}

function allItemIds(inst) {
  return inst.items.map(function (it) { return it.id; });
}

// Returns the count of answered items for completeness checks
function answeredCount(responses, itemIds) {
  var n = 0;
  for (var i = 0; i < itemIds.length; i++) {
    if (typeof responses[itemIds[i]] === 'number') n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTRUMENTS
// ─────────────────────────────────────────────────────────────────────────────

var INSTRUMENTS = {};

// ── PHQ-9 (Patient Health Questionnaire-9) — public domain (Pfizer) ──────────
INSTRUMENTS['phq9'] = {
  id: 'phq9',
  name: 'PHQ-9',
  fullName: 'Patient Health Questionnaire-9',
  domain: 'Depression',
  attribution: 'Kroenke, Spitzer & Williams (2001). Public domain.',
  itemCount: 9,
  instructionText: 'Over the last 2 weeks, how often have you been bothered by any of the following problems?',
  options: FREQ_0_3,
  // Item 9 is the self-harm/suicide item — flagged for provider risk review.
  riskItem: 'phq9_9',
  items: [
    { id: 'phq9_1', text: 'Little interest or pleasure in doing things' },
    { id: 'phq9_2', text: 'Feeling down, depressed, or hopeless' },
    { id: 'phq9_3', text: 'Trouble falling or staying asleep, or sleeping too much' },
    { id: 'phq9_4', text: 'Feeling tired or having little energy' },
    { id: 'phq9_5', text: 'Poor appetite or overeating' },
    { id: 'phq9_6', text: 'Feeling bad about yourself, or that you are a failure, or have let yourself or your family down' },
    { id: 'phq9_7', text: 'Trouble concentrating on things, such as reading the newspaper or watching television' },
    { id: 'phq9_8', text: 'Moving or speaking so slowly that other people could have noticed; or the opposite, being so fidgety or restless that you have been moving around a lot more than usual' },
    { id: 'phq9_9', text: 'Thoughts that you would be better off dead, or of hurting yourself in some way' }
  ],
  score: function (responses) {
    var ids = allItemIds(this);
    var total = sumItems(responses, ids);
    var band, bandLabel, interp;
    if (total <= 4) { band = 0; bandLabel = 'Minimal'; interp = 'minimal or no depressive symptoms'; }
    else if (total <= 9) { band = 1; bandLabel = 'Mild'; interp = 'mild depressive symptoms'; }
    else if (total <= 14) { band = 2; bandLabel = 'Moderate'; interp = 'moderate depressive symptoms'; }
    else if (total <= 19) { band = 3; bandLabel = 'Moderately severe'; interp = 'moderately severe depressive symptoms'; }
    else { band = 4; bandLabel = 'Severe'; interp = 'severe depressive symptoms'; }

    var flags = [];
    var item9 = responses['phq9_9'];
    if (typeof item9 === 'number' && item9 >= 1) {
      flags.push({
        type: 'self_harm',
        severity: item9 >= 2 ? 'high' : 'elevated',
        label: 'PHQ-9 Item 9 endorsed',
        detail: 'Patient endorsed thoughts of being better off dead or of self-harm (Item 9 = ' + item9 + '). Direct suicide risk assessment indicated.'
      });
    }
    return {
      total: total, max: 27, band: band, bandLabel: bandLabel,
      interpretation: interp, flags: flags
    };
  },
  chartLanguage: function (s) {
    var t = 'PHQ-9 administered. Total score ' + s.total + '/27, consistent with ' + s.interpretation + ' (' + s.bandLabel + ' range).';
    if (s.flags && s.flags.length) {
      t += ' NOTE: Item 9 (thoughts of being better off dead or self-harm) was endorsed; suicide risk evaluation indicated and addressed.';
    }
    return t;
  }
};

// ── GAD-7 (Generalized Anxiety Disorder-7) — public domain (Pfizer) ──────────
INSTRUMENTS['gad7'] = {
  id: 'gad7',
  name: 'GAD-7',
  fullName: 'Generalized Anxiety Disorder-7',
  domain: 'Anxiety',
  attribution: 'Spitzer, Kroenke, Williams & Löwe (2006). Public domain.',
  itemCount: 7,
  instructionText: 'Over the last 2 weeks, how often have you been bothered by the following problems?',
  options: FREQ_0_3,
  items: [
    { id: 'gad7_1', text: 'Feeling nervous, anxious, or on edge' },
    { id: 'gad7_2', text: 'Not being able to stop or control worrying' },
    { id: 'gad7_3', text: 'Worrying too much about different things' },
    { id: 'gad7_4', text: 'Trouble relaxing' },
    { id: 'gad7_5', text: 'Being so restless that it is hard to sit still' },
    { id: 'gad7_6', text: 'Becoming easily annoyed or irritable' },
    { id: 'gad7_7', text: 'Feeling afraid, as if something awful might happen' }
  ],
  score: function (responses) {
    var total = sumItems(responses, allItemIds(this));
    var band, bandLabel, interp;
    if (total <= 4) { band = 0; bandLabel = 'Minimal'; interp = 'minimal anxiety symptoms'; }
    else if (total <= 9) { band = 1; bandLabel = 'Mild'; interp = 'mild anxiety symptoms'; }
    else if (total <= 14) { band = 2; bandLabel = 'Moderate'; interp = 'moderate anxiety symptoms'; }
    else { band = 3; bandLabel = 'Severe'; interp = 'severe anxiety symptoms'; }
    return { total: total, max: 21, band: band, bandLabel: bandLabel, interpretation: interp, flags: [] };
  },
  chartLanguage: function (s) {
    return 'GAD-7 administered. Total score ' + s.total + '/21, consistent with ' + s.interpretation + ' (' + s.bandLabel + ' range).';
  }
};

// ── AUDIT-C (Alcohol Use Disorders Identification Test — Consumption) — WHO, free ──
// Using AUDIT-C (3-item consumption subset) for the self-report pipeline.
INSTRUMENTS['auditc'] = {
  id: 'auditc',
  name: 'AUDIT-C',
  fullName: 'Alcohol Use Disorders Identification Test — Consumption',
  domain: 'Alcohol use',
  attribution: 'Bush et al. (1998), derived from WHO AUDIT (Saunders et al., 1993). Free for use.',
  itemCount: 3,
  instructionText: 'Please answer the following questions about your use of alcoholic beverages during the past year. One standard drink is one 12-oz beer, one 5-oz glass of wine, or one 1.5-oz shot of liquor.',
  // Per-item option sets (AUDIT-C items have distinct scales)
  options: null,
  items: [
    {
      id: 'auditc_1',
      text: 'How often did you have a drink containing alcohol in the past year?',
      options: [
        { value: 0, label: 'Never' },
        { value: 1, label: 'Monthly or less' },
        { value: 2, label: '2–4 times a month' },
        { value: 3, label: '2–3 times a week' },
        { value: 4, label: '4 or more times a week' }
      ]
    },
    {
      id: 'auditc_2',
      text: 'How many standard drinks containing alcohol did you have on a typical day when you were drinking in the past year?',
      options: [
        { value: 0, label: '1 or 2' },
        { value: 1, label: '3 or 4' },
        { value: 2, label: '5 or 6' },
        { value: 3, label: '7 to 9' },
        { value: 4, label: '10 or more' }
      ]
    },
    {
      id: 'auditc_3',
      text: 'How often did you have six or more drinks on one occasion in the past year?',
      options: [
        { value: 0, label: 'Never' },
        { value: 1, label: 'Less than monthly' },
        { value: 2, label: 'Monthly' },
        { value: 3, label: 'Weekly' },
        { value: 4, label: 'Daily or almost daily' }
      ]
    }
  ],
  score: function (responses) {
    var total = sumItems(responses, allItemIds(this));
    // Sex-specific cutoffs exist (>=4 men, >=3 women); we report the score and a
    // sex-neutral interpretation, flagging the lower threshold so the clinician
    // applies judgment.
    var band, bandLabel, interp;
    if (total <= 2) { band = 0; bandLabel = 'Low risk'; interp = 'a low-risk drinking pattern'; }
    else if (total <= 4) { band = 1; bandLabel = 'Possible risk'; interp = 'a possibly hazardous drinking pattern (at or above the screening threshold; lower cutoff applies for women, ≥3)'; }
    else if (total <= 7) { band = 2; bandLabel = 'Increased risk'; interp = 'an increased-risk drinking pattern'; }
    else { band = 3; bandLabel = 'High risk'; interp = 'a high-risk drinking pattern suggestive of alcohol use disorder'; }
    return { total: total, max: 12, band: band, bandLabel: bandLabel, interpretation: interp, flags: [] };
  },
  chartLanguage: function (s) {
    return 'AUDIT-C administered. Total score ' + s.total + '/12, consistent with ' + s.interpretation + '. Clinical correlation and sex-specific cutoff applied.';
  }
};

// ── DAST-10 (Drug Abuse Screening Test-10) — free for clinical/research use ───
INSTRUMENTS['dast10'] = {
  id: 'dast10',
  name: 'DAST-10',
  fullName: 'Drug Abuse Screening Test-10',
  domain: 'Drug use',
  attribution: 'Skinner (1982). Free for clinical and research use.',
  itemCount: 10,
  instructionText: 'The following questions concern information about your involvement with drugs, NOT including alcoholic beverages, during the past 12 months. "Drug use" refers to non-medical use of prescription drugs and any use of illegal drugs. Please answer every question with Yes or No.',
  options: YES_NO,
  // Item 3 is reverse-scored ("Are you always able to stop using drugs when you want to?")
  reverseItems: ['dast10_3'],
  items: [
    { id: 'dast10_1', text: 'Have you used drugs other than those required for medical reasons?' },
    { id: 'dast10_2', text: 'Do you abuse more than one drug at a time?' },
    { id: 'dast10_3', text: 'Are you always able to stop using drugs when you want to?' },
    { id: 'dast10_4', text: 'Have you ever had blackouts or flashbacks as a result of drug use?' },
    { id: 'dast10_5', text: 'Do you ever feel bad or guilty about your drug use?' },
    { id: 'dast10_6', text: 'Does your spouse (or parents) ever complain about your involvement with drugs?' },
    { id: 'dast10_7', text: 'Have you neglected your family because of your use of drugs?' },
    { id: 'dast10_8', text: 'Have you engaged in illegal activities in order to obtain drugs?' },
    { id: 'dast10_9', text: 'Have you ever experienced withdrawal symptoms (felt sick) when you stopped taking drugs?' },
    { id: 'dast10_10', text: 'Have you had medical problems as a result of your drug use (e.g., memory loss, hepatitis, convulsions, bleeding)?' }
  ],
  score: function (responses) {
    var total = 0;
    var ids = allItemIds(this);
    for (var i = 0; i < ids.length; i++) {
      var v = responses[ids[i]];
      if (typeof v !== 'number') continue;
      if (this.reverseItems.indexOf(ids[i]) !== -1) {
        // reverse: a "No" (0) scores 1 point
        total += (v === 0 ? 1 : 0);
      } else {
        total += (v === 1 ? 1 : 0);
      }
    }
    var band, bandLabel, interp;
    if (total === 0) { band = 0; bandLabel = 'No problems'; interp = 'no problems reported related to drug use'; }
    else if (total <= 2) { band = 1; bandLabel = 'Low level'; interp = 'a low level of problems related to drug use'; }
    else if (total <= 5) { band = 2; bandLabel = 'Moderate level'; interp = 'a moderate level of problems related to drug use'; }
    else if (total <= 8) { band = 3; bandLabel = 'Substantial level'; interp = 'a substantial level of problems related to drug use'; }
    else { band = 4; bandLabel = 'Severe level'; interp = 'a severe level of problems related to drug use'; }
    return { total: total, max: 10, band: band, bandLabel: bandLabel, interpretation: interp, flags: [] };
  },
  chartLanguage: function (s) {
    return 'DAST-10 administered. Total score ' + s.total + '/10, indicating ' + s.interpretation + ' (' + s.bandLabel + '). Clinical assessment of substance use indicated as appropriate.';
  }
};

// ── EPDS (Edinburgh Postnatal Depression Scale) — free for clinical use ───────
INSTRUMENTS['epds'] = {
  id: 'epds',
  name: 'EPDS',
  fullName: 'Edinburgh Postnatal Depression Scale',
  domain: 'Perinatal depression',
  attribution: 'Cox, Holden & Sagovsky (1987). Free for clinical use with attribution.',
  itemCount: 10,
  instructionText: 'As you are pregnant or have recently had a baby, we would like to know how you are feeling. Please choose the answer that comes closest to how you have felt in the past 7 days, not just how you feel today.',
  options: null, // per-item (each item has its own 4 anchored responses)
  riskItem: 'epds_10',
  // Reverse-scored items per standard EPDS scoring: 3,5,6,7,8,9,10 are scored 3-0.
  items: [
    {
      id: 'epds_1', text: 'I have been able to laugh and see the funny side of things.',
      options: [
        { value: 0, label: 'As much as I always could' },
        { value: 1, label: 'Not quite so much now' },
        { value: 2, label: 'Definitely not so much now' },
        { value: 3, label: 'Not at all' }
      ]
    },
    {
      id: 'epds_2', text: 'I have looked forward with enjoyment to things.',
      options: [
        { value: 0, label: 'As much as I ever did' },
        { value: 1, label: 'Rather less than I used to' },
        { value: 2, label: 'Definitely less than I used to' },
        { value: 3, label: 'Hardly at all' }
      ]
    },
    {
      id: 'epds_3', text: 'I have blamed myself unnecessarily when things went wrong.',
      options: [
        { value: 3, label: 'Yes, most of the time' },
        { value: 2, label: 'Yes, some of the time' },
        { value: 1, label: 'Not very often' },
        { value: 0, label: 'No, never' }
      ]
    },
    {
      id: 'epds_4', text: 'I have been anxious or worried for no good reason.',
      options: [
        { value: 0, label: 'No, not at all' },
        { value: 1, label: 'Hardly ever' },
        { value: 2, label: 'Yes, sometimes' },
        { value: 3, label: 'Yes, very often' }
      ]
    },
    {
      id: 'epds_5', text: 'I have felt scared or panicky for no very good reason.',
      options: [
        { value: 3, label: 'Yes, quite a lot' },
        { value: 2, label: 'Yes, sometimes' },
        { value: 1, label: 'No, not much' },
        { value: 0, label: 'No, not at all' }
      ]
    },
    {
      id: 'epds_6', text: 'Things have been getting on top of me.',
      options: [
        { value: 3, label: 'Yes, most of the time I have not been able to cope at all' },
        { value: 2, label: 'Yes, sometimes I have not been coping as well as usual' },
        { value: 1, label: 'No, most of the time I have coped quite well' },
        { value: 0, label: 'No, I have been coping as well as ever' }
      ]
    },
    {
      id: 'epds_7', text: 'I have been so unhappy that I have had difficulty sleeping.',
      options: [
        { value: 3, label: 'Yes, most of the time' },
        { value: 2, label: 'Yes, sometimes' },
        { value: 1, label: 'Not very often' },
        { value: 0, label: 'No, not at all' }
      ]
    },
    {
      id: 'epds_8', text: 'I have felt sad or miserable.',
      options: [
        { value: 3, label: 'Yes, most of the time' },
        { value: 2, label: 'Yes, quite often' },
        { value: 1, label: 'Not very often' },
        { value: 0, label: 'No, not at all' }
      ]
    },
    {
      id: 'epds_9', text: 'I have been so unhappy that I have been crying.',
      options: [
        { value: 3, label: 'Yes, most of the time' },
        { value: 2, label: 'Yes, quite often' },
        { value: 1, label: 'Only occasionally' },
        { value: 0, label: 'No, never' }
      ]
    },
    {
      id: 'epds_10', text: 'The thought of harming myself has occurred to me.',
      options: [
        { value: 3, label: 'Yes, quite often' },
        { value: 2, label: 'Sometimes' },
        { value: 1, label: 'Hardly ever' },
        { value: 0, label: 'Never' }
      ]
    }
  ],
  score: function (responses) {
    var total = sumItems(responses, allItemIds(this));
    var band, bandLabel, interp;
    if (total <= 8) { band = 0; bandLabel = 'Low likelihood'; interp = 'a low likelihood of depression'; }
    else if (total <= 12) { band = 1; bandLabel = 'Possible'; interp = 'possible depression (further assessment indicated)'; }
    else { band = 2; bandLabel = 'Probable'; interp = 'a probable depressive illness (clinical assessment indicated)'; }

    var flags = [];
    var item10 = responses['epds_10'];
    if (typeof item10 === 'number' && item10 >= 1) {
      flags.push({
        type: 'self_harm',
        severity: item10 >= 2 ? 'high' : 'elevated',
        label: 'EPDS Item 10 endorsed',
        detail: 'Patient endorsed that the thought of self-harm has occurred (Item 10 = ' + item10 + '). Direct suicide risk assessment indicated.'
      });
    }
    return { total: total, max: 30, band: band, bandLabel: bandLabel, interpretation: interp, flags: flags };
  },
  chartLanguage: function (s) {
    var t = 'EPDS administered. Total score ' + s.total + '/30, consistent with ' + s.interpretation + '.';
    if (s.flags && s.flags.length) {
      t += ' NOTE: Item 10 (thoughts of self-harm) was endorsed; suicide risk evaluation indicated and addressed.';
    }
    return t;
  }
};

// ── PCL-5 (PTSD Checklist for DSM-5) — VA, public domain (US gov work) ────────
INSTRUMENTS['pcl5'] = {
  id: 'pcl5',
  name: 'PCL-5',
  fullName: 'PTSD Checklist for DSM-5',
  domain: 'PTSD',
  attribution: 'Weathers et al. (2013), National Center for PTSD. Public domain (US Government work).',
  itemCount: 20,
  instructionText: 'This questionnaire asks about problems you may have had after a very stressful experience. In the past month, how much were you bothered by each problem?',
  options: [
    { value: 0, label: 'Not at all' },
    { value: 1, label: 'A little bit' },
    { value: 2, label: 'Moderately' },
    { value: 3, label: 'Quite a bit' },
    { value: 4, label: 'Extremely' }
  ],
  items: [
    { id: 'pcl5_1', text: 'Repeated, disturbing, and unwanted memories of the stressful experience' },
    { id: 'pcl5_2', text: 'Repeated, disturbing dreams of the stressful experience' },
    { id: 'pcl5_3', text: 'Suddenly feeling or acting as if the stressful experience were actually happening again' },
    { id: 'pcl5_4', text: 'Feeling very upset when something reminded you of the stressful experience' },
    { id: 'pcl5_5', text: 'Having strong physical reactions when something reminded you of the stressful experience (e.g., heart pounding, trouble breathing, sweating)' },
    { id: 'pcl5_6', text: 'Avoiding memories, thoughts, or feelings related to the stressful experience' },
    { id: 'pcl5_7', text: 'Avoiding external reminders of the stressful experience (e.g., people, places, conversations, activities, objects, or situations)' },
    { id: 'pcl5_8', text: 'Trouble remembering important parts of the stressful experience' },
    { id: 'pcl5_9', text: 'Having strong negative beliefs about yourself, other people, or the world (e.g., I am bad, there is something seriously wrong with me, no one can be trusted, the world is completely dangerous)' },
    { id: 'pcl5_10', text: 'Blaming yourself or someone else for the stressful experience or what happened after it' },
    { id: 'pcl5_11', text: 'Having strong negative feelings such as fear, horror, anger, guilt, or shame' },
    { id: 'pcl5_12', text: 'Loss of interest in activities that you used to enjoy' },
    { id: 'pcl5_13', text: 'Feeling distant or cut off from other people' },
    { id: 'pcl5_14', text: 'Trouble experiencing positive feelings (e.g., being unable to feel happiness or have loving feelings for people close to you)' },
    { id: 'pcl5_15', text: 'Irritable behavior, angry outbursts, or acting aggressively' },
    { id: 'pcl5_16', text: 'Taking too many risks or doing things that could cause you harm' },
    { id: 'pcl5_17', text: 'Being superalert or watchful or on guard' },
    { id: 'pcl5_18', text: 'Feeling jumpy or easily startled' },
    { id: 'pcl5_19', text: 'Having difficulty concentrating' },
    { id: 'pcl5_20', text: 'Trouble falling or staying asleep' }
  ],
  score: function (responses) {
    var total = sumItems(responses, allItemIds(this));
    // DSM-5 symptom clusters
    var clusterB = sumItems(responses, ['pcl5_1', 'pcl5_2', 'pcl5_3', 'pcl5_4', 'pcl5_5']);
    var clusterC = sumItems(responses, ['pcl5_6', 'pcl5_7']);
    var clusterD = sumItems(responses, ['pcl5_8', 'pcl5_9', 'pcl5_10', 'pcl5_11', 'pcl5_12', 'pcl5_13', 'pcl5_14']);
    var clusterE = sumItems(responses, ['pcl5_15', 'pcl5_16', 'pcl5_17', 'pcl5_18', 'pcl5_19', 'pcl5_20']);
    // Provisional diagnosis (item >=2 counts as symptom endorsed): >=1 B, >=1 C, >=2 D, >=2 E
    function countEndorsed(ids) {
      var n = 0;
      for (var i = 0; i < ids.length; i++) { if ((responses[ids[i]] || 0) >= 2) n++; }
      return n;
    }
    var bEnd = countEndorsed(['pcl5_1', 'pcl5_2', 'pcl5_3', 'pcl5_4', 'pcl5_5']);
    var cEnd = countEndorsed(['pcl5_6', 'pcl5_7']);
    var dEnd = countEndorsed(['pcl5_8', 'pcl5_9', 'pcl5_10', 'pcl5_11', 'pcl5_12', 'pcl5_13', 'pcl5_14']);
    var eEnd = countEndorsed(['pcl5_15', 'pcl5_16', 'pcl5_17', 'pcl5_18', 'pcl5_19', 'pcl5_20']);
    var provisional = (bEnd >= 1 && cEnd >= 1 && dEnd >= 2 && eEnd >= 2);

    var band, bandLabel, interp;
    if (total < 31) { band = 0; bandLabel = 'Below threshold'; interp = 'PTSD symptoms below the provisional screening threshold'; }
    else { band = 1; bandLabel = 'At/above threshold'; interp = 'PTSD symptoms at or above the provisional screening threshold (≥31)'; }

    return {
      total: total, max: 80, band: band, bandLabel: bandLabel, interpretation: interp,
      subscales: { 'Cluster B (Intrusion)': clusterB, 'Cluster C (Avoidance)': clusterC, 'Cluster D (Cognition/Mood)': clusterD, 'Cluster E (Arousal)': clusterE },
      provisionalDiagnosis: provisional,
      flags: []
    };
  },
  chartLanguage: function (s) {
    var thresholdStatus = (s.total >= 31)
      ? 'above the common provisional PTSD screening cutoff (31-33)'
      : 'below the common provisional PTSD screening cutoff (31-33)';
    var clusterStatus = s.provisionalDiagnosis
      ? 'DSM-5 symptom-cluster screening criteria appear met by the item-endorsement rule (>=1 intrusion, >=1 avoidance, >=2 negative cognition/mood, >=2 arousal items endorsed at item score >=2)'
      : 'DSM-5 symptom-cluster screening criteria do not appear met by the item-endorsement rule';
    var t = 'PCL-5 administered. Total score ' + s.total + '/80, ' + thresholdStatus + '. ';
    t += 'Cluster scores: B intrusion ' + s.subscales['Cluster B (Intrusion)'] +
      ', C avoidance ' + s.subscales['Cluster C (Avoidance)'] +
      ', D negative cognition/mood ' + s.subscales['Cluster D (Cognition/Mood)'] +
      ', E arousal/reactivity ' + s.subscales['Cluster E (Arousal)'] + '. ';
    t += clusterStatus + '. ';
    t += 'This is a positive screen requiring clinical confirmation; confirm Criterion A trauma exposure, symptom duration, functional impairment, and differential diagnosis in interview.';
    return t;
  }
};

// ── ACE (Adverse Childhood Experiences, original 10-item) — public domain ─────
INSTRUMENTS['ace10'] = {
  id: 'ace10',
  name: 'ACE',
  fullName: 'Adverse Childhood Experiences Questionnaire (10-item)',
  domain: 'Childhood adversity',
  attribution: 'Felitti et al. (1998), CDC-Kaiser ACE Study. Public domain.',
  itemCount: 10,
  instructionText: 'While you were growing up, during your first 18 years of life: please answer Yes or No to each question. Your answers are summed into a single score; you do not have to share which specific items you endorsed unless you wish to discuss them.',
  options: YES_NO,
  items: [
    { id: 'ace_1', text: 'Did a parent or other adult in the household often or very often swear at you, insult you, put you down, or humiliate you; or act in a way that made you afraid that you might be physically hurt?' },
    { id: 'ace_2', text: 'Did a parent or other adult in the household often or very often push, grab, slap, or throw something at you; or ever hit you so hard that you had marks or were injured?' },
    { id: 'ace_3', text: 'Did an adult or person at least 5 years older than you ever touch or fondle you or have you touch their body in a sexual way; or attempt or actually have oral, anal, or vaginal intercourse with you?' },
    { id: 'ace_4', text: 'Did you often or very often feel that no one in your family loved you or thought you were important or special; or that your family did not look out for each other, feel close to each other, or support each other?' },
    { id: 'ace_5', text: 'Did you often or very often feel that you did not have enough to eat, had to wear dirty clothes, and had no one to protect you; or that your parents were too drunk or high to take care of you or take you to the doctor if you needed it?' },
    { id: 'ace_6', text: 'Were your parents ever separated or divorced?' },
    { id: 'ace_7', text: 'Was your mother or stepmother often or very often pushed, grabbed, slapped, or had something thrown at her; or sometimes/often/very often kicked, bitten, hit with a fist, hit with something hard, repeatedly hit over at least a few minutes, or threatened or hurt with a weapon?' },
    { id: 'ace_8', text: 'Did you live with anyone who was a problem drinker or alcoholic, or who used street drugs?' },
    { id: 'ace_9', text: 'Was a household member depressed or mentally ill, or did a household member attempt suicide?' },
    { id: 'ace_10', text: 'Did a household member go to prison?' }
  ],
  score: function (responses) {
    var total = sumItems(responses, allItemIds(this));
    var band, bandLabel, interp;
    if (total === 0) { band = 0; bandLabel = 'None reported'; interp = 'no adverse childhood experiences reported on this measure'; }
    else if (total <= 3) { band = 1; bandLabel = 'Moderate exposure'; interp = 'moderate cumulative childhood adversity'; }
    else { band = 2; bandLabel = 'High exposure'; interp = 'high cumulative childhood adversity (ACE ≥4), associated in the literature with elevated health and behavioral-health risk'; }
    return { total: total, max: 10, band: band, bandLabel: bandLabel, interpretation: interp, flags: [] };
  },
  chartLanguage: function (s) {
    return 'ACE questionnaire (10-item) administered. Total score ' + s.total + '/10, indicating ' + s.interpretation + '. ACE score reflects cumulative exposure and is not diagnostic; used to inform trauma-informed care.';
  }
};

// ── ASRS v1.1 (Adult ADHD Self-Report Scale — 6-item screener) — WHO, free ────
INSTRUMENTS['asrs'] = {
  id: 'asrs',
  name: 'ASRS v1.1',
  fullName: 'Adult ADHD Self-Report Scale (6-item screener)',
  domain: 'ADHD (screen)',
  attribution: 'Kessler et al. (2005), WHO. Free for use with attribution.',
  itemCount: 6,
  instructionText: 'Please answer the questions below, rating yourself on each of the criteria using the scale. As you answer, think about how you have felt and conducted yourself over the past 6 months.',
  options: [
    { value: 0, label: 'Never' },
    { value: 1, label: 'Rarely' },
    { value: 2, label: 'Sometimes' },
    { value: 3, label: 'Often' },
    { value: 4, label: 'Very often' }
  ],
  // Part A screener: items 1-3 score if "Sometimes"+; items 4-6 score if "Often"+.
  // 4+ shaded marks = positive screen.
  items: [
    { id: 'asrs_1', text: 'How often do you have trouble wrapping up the final details of a project, once the challenging parts have been done?' },
    { id: 'asrs_2', text: 'How often do you have difficulty getting things in order when you have to do a task that requires organization?' },
    { id: 'asrs_3', text: 'How often do you have problems remembering appointments or obligations?' },
    { id: 'asrs_4', text: 'When you have a task that requires a lot of thought, how often do you avoid or delay getting started?' },
    { id: 'asrs_5', text: 'How often do you fidget or squirm with your hands or feet when you have to sit down for a long time?' },
    { id: 'asrs_6', text: 'How often do you feel overly active and compelled to do things, like you were driven by a motor?' }
  ],
  score: function (responses) {
    // Shaded-mark logic
    var marks = 0;
    var lowThreshold = ['asrs_1', 'asrs_2', 'asrs_3']; // Sometimes(2)+
    var highThreshold = ['asrs_4', 'asrs_5', 'asrs_6']; // Often(3)+
    for (var i = 0; i < lowThreshold.length; i++) {
      if ((responses[lowThreshold[i]] || 0) >= 2) marks++;
    }
    for (var j = 0; j < highThreshold.length; j++) {
      if ((responses[highThreshold[j]] || 0) >= 3) marks++;
    }
    var raw = sumItems(responses, allItemIds(this));
    var positive = marks >= 4;
    var band = positive ? 1 : 0;
    var bandLabel = positive ? 'Positive screen' : 'Negative screen';
    var interp = positive
      ? 'a positive ADHD screen (' + marks + ' of 6 symptom thresholds met); symptoms consistent with adult ADHD and further clinical evaluation is warranted'
      : 'a negative ADHD screen (' + marks + ' of 6 symptom thresholds met)';
    return { total: raw, max: 24, shadedMarks: marks, band: band, bandLabel: bandLabel, interpretation: interp, flags: [] };
  },
  chartLanguage: function (s) {
    return 'ASRS v1.1 (6-item screener) administered. ' + s.shadedMarks + ' of 6 symptom thresholds met (raw item sum ' + s.total + '/24), indicating ' + s.interpretation + '. Screening result only; a positive screen requires structured diagnostic evaluation (childhood onset, cross-setting symptoms, functional impairment, and rule-outs).';
  }
};

// ── WFIRS-S (Weiss Functional Impairment Rating Scale — Self-Report) — free ───
// Functional impairment companion to ADHD screening.
// ── WFIRS-S (Weiss Functional Impairment Rating Scale — Self-Report) ──────────
// The REAL validated instrument: 69 items across 7 domains, 0-3 Likert plus n/a.
// © University of British Columbia 2011 (Margaret D. Weiss). Public domain to
// encourage use; may be reproduced without permission provided the instrument is
// unmodified and the copyright notice is retained. Items transcribed verbatim from
// the CADDRA October 2011 WFIRS-S source.
//
// n/a handling: an item may be Not Applicable (e.g., no partner, not employed,
// not in school). n/a is the value NA_VALUE (-1) and is OMITTED from all scoring
// (domain mean, totals, impairment rule), per the published scoring instructions.
//
// Conditional domains: Work and School are gated on employment/enrollment status
// collected up front; a respondent who is not employed/enrolled does not see those
// items (they are treated as entirely n/a).
//
// Validated impairment rule (per source): a domain is impaired if it has >=2 items
// scored 2, OR >=1 item scored 3, OR a domain mean > 1.5.
INSTRUMENTS['wfirs'] = {
  id: 'wfirs',
  name: 'WFIRS-S',
  fullName: 'Weiss Functional Impairment Rating Scale — Self-Report',
  domain: 'Functional impairment',
  attribution: '\u00a9 University of British Columbia 2011 (Margaret D. Weiss, MD PhD). Public domain; reproduced unmodified with copyright notice retained.',
  itemCount: 69,
  naAllowed: true,
  instructionText: 'Circle the rating that best describes how your emotional or behavioural problems have affected each item in the last month. If an item does not apply to you, choose "Not applicable."',
  options: [
    { value: 0, label: 'Never or not at all' },
    { value: 1, label: 'Sometimes or somewhat' },
    { value: 2, label: 'Often or much' },
    { value: 3, label: 'Very often or very much' },
    { value: -1, label: 'Not applicable' }
  ],
  // Domain definitions: which item ids belong to each, plus optional gating.
  domains: [
    { key: 'A', label: 'Family', prefix: 'wfirs_a' },
    { key: 'B', label: 'Work', prefix: 'wfirs_b', conditionalOn: 'employed' },
    { key: 'C', label: 'School', prefix: 'wfirs_c', conditionalOn: 'inSchool' },
    { key: 'D', label: 'Life skills', prefix: 'wfirs_d' },
    { key: 'E', label: 'Self-concept', prefix: 'wfirs_e' },
    { key: 'F', label: 'Social', prefix: 'wfirs_f' },
    { key: 'G', label: 'Risk', prefix: 'wfirs_g' }
  ],
  items: [
    // A. FAMILY (8)
    { id: 'wfirs_a1', domain: 'Family', text: 'Having problems with family' },
    { id: 'wfirs_a2', domain: 'Family', text: 'Having problems with spouse/partner' },
    { id: 'wfirs_a3', domain: 'Family', text: 'Relying on others to do things for you' },
    { id: 'wfirs_a4', domain: 'Family', text: 'Causing fighting in the family' },
    { id: 'wfirs_a5', domain: 'Family', text: 'Makes it hard for the family to have fun together' },
    { id: 'wfirs_a6', domain: 'Family', text: 'Problems taking care of your family' },
    { id: 'wfirs_a7', domain: 'Family', text: 'Problems balancing your needs against those of your family' },
    { id: 'wfirs_a8', domain: 'Family', text: 'Problems losing control with family' },
    // B. WORK (11) — conditional on employment
    { id: 'wfirs_b1', domain: 'Work', text: 'Problems performing required duties' },
    { id: 'wfirs_b2', domain: 'Work', text: 'Problems with getting your work done efficiently' },
    { id: 'wfirs_b3', domain: 'Work', text: 'Problems with your supervisor' },
    { id: 'wfirs_b4', domain: 'Work', text: 'Problems keeping a job' },
    { id: 'wfirs_b5', domain: 'Work', text: 'Getting fired from work' },
    { id: 'wfirs_b6', domain: 'Work', text: 'Problems working in a team' },
    { id: 'wfirs_b7', domain: 'Work', text: 'Problems with your attendance' },
    { id: 'wfirs_b8', domain: 'Work', text: 'Problems with being late' },
    { id: 'wfirs_b9', domain: 'Work', text: 'Problems taking on new tasks' },
    { id: 'wfirs_b10', domain: 'Work', text: 'Problems working to your potential' },
    { id: 'wfirs_b11', domain: 'Work', text: 'Poor performance evaluations' },
    // C. SCHOOL (10) — conditional on enrollment
    { id: 'wfirs_c1', domain: 'School', text: 'Problems taking notes' },
    { id: 'wfirs_c2', domain: 'School', text: 'Problems completing assignments' },
    { id: 'wfirs_c3', domain: 'School', text: 'Problems getting your work done efficiently' },
    { id: 'wfirs_c4', domain: 'School', text: 'Problems with teachers' },
    { id: 'wfirs_c5', domain: 'School', text: 'Problems with school administrators' },
    { id: 'wfirs_c6', domain: 'School', text: 'Problems meeting minimum requirements to stay in school' },
    { id: 'wfirs_c7', domain: 'School', text: 'Problems with attendance' },
    { id: 'wfirs_c8', domain: 'School', text: 'Problems with being late' },
    { id: 'wfirs_c9', domain: 'School', text: 'Problems with working to your potential' },
    { id: 'wfirs_c10', domain: 'School', text: 'Problems with inconsistent grades' },
    // D. LIFE SKILLS (12)
    { id: 'wfirs_d1', domain: 'Life skills', text: 'Excessive or inappropriate use of internet, video games or TV' },
    { id: 'wfirs_d2', domain: 'Life skills', text: 'Problems keeping an acceptable appearance' },
    { id: 'wfirs_d3', domain: 'Life skills', text: 'Problems getting ready to leave the house' },
    { id: 'wfirs_d4', domain: 'Life skills', text: 'Problems getting to bed' },
    { id: 'wfirs_d5', domain: 'Life skills', text: 'Problems with nutrition' },
    { id: 'wfirs_d6', domain: 'Life skills', text: 'Problems with sex' },
    { id: 'wfirs_d7', domain: 'Life skills', text: 'Problems with sleeping' },
    { id: 'wfirs_d8', domain: 'Life skills', text: 'Getting hurt or injured' },
    { id: 'wfirs_d9', domain: 'Life skills', text: 'Avoiding exercise' },
    { id: 'wfirs_d10', domain: 'Life skills', text: 'Problems keeping regular appointments with doctor/dentist' },
    { id: 'wfirs_d11', domain: 'Life skills', text: 'Problems keeping up with household chores' },
    { id: 'wfirs_d12', domain: 'Life skills', text: 'Problems managing money' },
    // E. SELF-CONCEPT (5)
    { id: 'wfirs_e1', domain: 'Self-concept', text: 'Feeling bad about yourself' },
    { id: 'wfirs_e2', domain: 'Self-concept', text: 'Feeling frustrated with yourself' },
    { id: 'wfirs_e3', domain: 'Self-concept', text: 'Feeling discouraged' },
    { id: 'wfirs_e4', domain: 'Self-concept', text: 'Not feeling happy with your life' },
    { id: 'wfirs_e5', domain: 'Self-concept', text: 'Feeling incompetent' },
    // F. SOCIAL (9)
    { id: 'wfirs_f1', domain: 'Social', text: 'Getting into arguments' },
    { id: 'wfirs_f2', domain: 'Social', text: 'Trouble cooperating' },
    { id: 'wfirs_f3', domain: 'Social', text: 'Trouble getting along with people' },
    { id: 'wfirs_f4', domain: 'Social', text: 'Problems having fun with other people' },
    { id: 'wfirs_f5', domain: 'Social', text: 'Problems participating in hobbies' },
    { id: 'wfirs_f6', domain: 'Social', text: 'Problems making friends' },
    { id: 'wfirs_f7', domain: 'Social', text: 'Problems keeping friends' },
    { id: 'wfirs_f8', domain: 'Social', text: 'Saying inappropriate things' },
    { id: 'wfirs_f9', domain: 'Social', text: 'Complaints from neighbours' },
    // G. RISK (14)
    { id: 'wfirs_g1', domain: 'Risk', text: 'Aggressive driving' },
    { id: 'wfirs_g2', domain: 'Risk', text: 'Doing other things while driving' },
    { id: 'wfirs_g3', domain: 'Risk', text: 'Road rage' },
    { id: 'wfirs_g4', domain: 'Risk', text: 'Breaking or damaging things' },
    { id: 'wfirs_g5', domain: 'Risk', text: 'Doing things that are illegal' },
    { id: 'wfirs_g6', domain: 'Risk', text: 'Being involved with the police' },
    { id: 'wfirs_g7', domain: 'Risk', text: 'Smoking cigarettes' },
    { id: 'wfirs_g8', domain: 'Risk', text: 'Smoking marijuana' },
    { id: 'wfirs_g9', domain: 'Risk', text: 'Drinking alcohol' },
    { id: 'wfirs_g10', domain: 'Risk', text: 'Taking "street" drugs' },
    { id: 'wfirs_g11', domain: 'Risk', text: 'Sex without protection (birth control, condom)' },
    { id: 'wfirs_g12', domain: 'Risk', text: 'Sexually inappropriate behaviour' },
    { id: 'wfirs_g13', domain: 'Risk', text: 'Being physically aggressive' },
    { id: 'wfirs_g14', domain: 'Risk', text: 'Being verbally aggressive' }
  ],
  score: function (responses) {
    var NA = -1;
    var domainResults = {};
    var impairedDomains = [];
    var grandSum = 0, grandCount = 0;

    for (var d = 0; d < this.domains.length; d++) {
      var dom = this.domains[d];
      var domItems = this.items.filter(function (it) { return it.domain === dom.label; });
      var sum = 0, count = 0, num2 = 0, num3 = 0;
      for (var i = 0; i < domItems.length; i++) {
        var v = responses[domItems[i].id];
        if (typeof v !== 'number' || v === NA) continue; // omit n/a + unanswered
        sum += v; count += 1;
        if (v === 2) num2 += 1;
        if (v === 3) num3 += 1;
        grandSum += v; grandCount += 1;
      }
      if (count === 0) {
        // Whole domain n/a or unseen (e.g., not employed). Record as N/A.
        domainResults[dom.label] = { applicable: false, mean: null, count: 0 };
        continue;
      }
      var dmean = sum / count;
      // Validated impairment rule: >=2 items at 2, OR >=1 item at 3, OR mean > 1.5
      var impaired = (num2 >= 2) || (num3 >= 1) || (dmean > 1.5);
      domainResults[dom.label] = {
        applicable: true,
        mean: Math.round(dmean * 100) / 100,
        count: count,
        impaired: impaired
      };
      if (impaired) impairedDomains.push(dom.label);
    }

    var overallMean = grandCount > 0 ? (grandSum / grandCount) : 0;
    var band, bandLabel, interp;
    // Bands reflect overall mean; the clinically meaningful unit is the per-domain
    // impairment flag above, surfaced explicitly.
    if (impairedDomains.length === 0) { band = 0; bandLabel = 'No domain impaired'; interp = 'no functional domain reached the validated impairment threshold'; }
    else if (impairedDomains.length <= 2) { band = 1; bandLabel = 'Impairment in some domains'; interp = 'functional impairment in ' + impairedDomains.length + ' domain(s)'; }
    else { band = 2; bandLabel = 'Impairment across multiple domains'; interp = 'functional impairment across ' + impairedDomains.length + ' domains'; }

    return {
      overallMean: Math.round(overallMean * 100) / 100,
      itemsScored: grandCount,
      band: band, bandLabel: bandLabel, interpretation: interp,
      domainResults: domainResults,
      impairedDomains: impairedDomains,
      flags: []
    };
  },
  chartLanguage: function (s) {
    var t = 'WFIRS-S administered (Weiss Functional Impairment Rating Scale, Self-Report; \u00a9 University of British Columbia). ';
    t += 'Overall mean item score ' + s.overallMean + ' across ' + s.itemsScored + ' applicable items. ';
    if (s.impairedDomains && s.impairedDomains.length) {
      t += 'Domains meeting the validated impairment threshold (\u22652 items rated 2, \u22651 item rated 3, or domain mean >1.5): ' + s.impairedDomains.join(', ') + '. ';
    } else {
      t += 'No domain met the validated impairment threshold. ';
    }
    t += 'Per-domain means: ';
    var parts = [];
    for (var label in s.domainResults) {
      if (!Object.prototype.hasOwnProperty.call(s.domainResults, label)) continue;
      var dr = s.domainResults[label];
      parts.push(label + ': ' + (dr.applicable ? dr.mean : 'n/a'));
    }
    t += parts.join(', ') + '. ';
    t += 'The WFIRS-S measures functional impairment, not symptoms, and is not diagnostic on its own; it documents real-world impact to support diagnostic formulation and to track change with treatment.';
    return t;
  }
};

// ── MSI-BPD (McLean Screening Instrument for BPD) — free with attribution ─────
// Own-wording note: items below probe the DSM-5 BPD criteria. Standard MSI-BPD
// wording is reproduced here under free-with-citation status (Zanarini 2003).
INSTRUMENTS['msibpd'] = {
  id: 'msibpd',
  name: 'MSI-BPD',
  fullName: 'McLean Screening Instrument for Borderline Personality Disorder',
  domain: 'Personality (BPD screen)',
  attribution: 'Zanarini et al. (2003). Free for clinical use with citation.',
  itemCount: 10,
  instructionText: 'Please answer the following questions about your experiences, thinking about your life in general rather than just recently. Answer each Yes or No.',
  options: YES_NO,
  items: [
    { id: 'msibpd_1', text: 'Have any of your closest relationships been troubled by a lot of arguments or repeated breakups?' },
    { id: 'msibpd_2', text: 'Have you deliberately hurt yourself physically (e.g., punched yourself, cut yourself, burned yourself)? Or made a suicide attempt?' },
    { id: 'msibpd_3', text: 'Have you had at least two other problems with impulsivity (e.g., eating binges and spending sprees, drinking too much and verbal outbursts)?' },
    { id: 'msibpd_4', text: 'Have you been extremely moody?' },
    { id: 'msibpd_5', text: 'Have you felt very angry a lot of the time? Or often acted in an angry or sarcastic manner?' },
    { id: 'msibpd_6', text: 'Have you often been distrustful of other people?' },
    { id: 'msibpd_7', text: 'Have you frequently felt unreal or as if things around you were unreal?' },
    { id: 'msibpd_8', text: 'Have you chronically felt empty?' },
    { id: 'msibpd_9', text: 'Have you often felt that you had no idea of who you are or that you have no identity?' },
    { id: 'msibpd_10', text: 'Have you made desperate efforts to avoid feeling abandoned or being abandoned (e.g., repeatedly called someone to reassure yourself that they still cared, begged them not to leave you, clung to them physically)?' }
  ],
  score: function (responses) {
    var total = sumItems(responses, allItemIds(this));
    // Cutoff of 7 per the validated instrument.
    var band, bandLabel, interp;
    if (total >= 7) { band = 2; bandLabel = 'Positive screen'; interp = 'a positive screen for borderline personality disorder (≥7); clinical diagnostic interview indicated'; }
    else if (total >= 5) { band = 1; bandLabel = 'Subthreshold'; interp = 'a subthreshold result (5–6); BPD cannot be ruled out and further evaluation is recommended'; }
    else { band = 0; bandLabel = 'Negative screen'; interp = 'a negative screen for borderline personality disorder'; }

    // Item 2 includes self-harm/suicide attempt content — surface as a flag.
    var flags = [];
    var item2 = responses['msibpd_2'];
    if (typeof item2 === 'number' && item2 === 1) {
      flags.push({
        type: 'self_harm_history',
        severity: 'review',
        label: 'MSI-BPD Item 2 endorsed',
        detail: 'Patient endorsed history of deliberate self-harm and/or suicide attempt (Item 2). Clinical review of self-harm/suicide history indicated.'
      });
    }
    return { total: total, max: 10, band: band, bandLabel: bandLabel, interpretation: interp, flags: flags };
  },
  chartLanguage: function (s) {
    var t = 'MSI-BPD administered. Total score ' + s.total + '/10, indicating ' + s.interpretation + '. Screening result only; BPD diagnosis requires clinical interview.';
    if (s.flags && s.flags.length) {
      t += ' NOTE: Item 2 (deliberate self-harm and/or suicide attempt history) was endorsed; clinical review indicated.';
    }
    return t;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATIENT-SEND ALLOWLIST
// C-SSRS and ASQ are intentionally NOT here (clinician-administered only).
// ─────────────────────────────────────────────────────────────────────────────
var PATIENT_SEND_IDS = [
  'phq9', 'gad7', 'auditc', 'dast10', 'epds', 'pcl5', 'ace10', 'asrs', 'wfirs', 'msibpd'
];

// ── Public API ──────────────────────────────────────────────────────────────

// Returns the sanitized definition the patient form needs to render an
// instrument (no scoring logic, no chart language, no band thresholds).
function getRenderDef(id) {
  var inst = INSTRUMENTS[id];
  if (!inst) return null;
  return {
    id: inst.id,
    name: inst.name,
    fullName: inst.fullName,
    domain: inst.domain,
    instructionText: inst.instructionText,
    options: inst.options,
    naAllowed: inst.naAllowed || false,
    domains: inst.domains || null, // for domain-grouped/conditional rendering (WFIRS-S)
    items: inst.items.map(function (it) {
      return {
        id: it.id,
        text: it.text,
        options: it.options || null,
        itemDomain: it.domain || null // domain label for grouping/gating
      };
    })
  };
}

// Validates an instrument id is allowed in the patient-send pipeline.
function isPatientSendAllowed(id) {
  return PATIENT_SEND_IDS.indexOf(id) !== -1;
}

// Scores a single instrument given a responses map.
function scoreInstrument(id, responses) {
  var inst = INSTRUMENTS[id];
  if (!inst) return null;
  var scored = inst.score(responses || {});
  scored.instrumentId = inst.id;
  scored.instrumentName = inst.name;
  scored.domain = inst.domain;
  scored.chartLanguage = inst.chartLanguage(scored);
  return scored;
}

// Scores a full battery. Input: { instrumentId: { itemId: value } }.
// Returns array of scored results plus an aggregate risk-flag list.
function scoreBattery(responsesByInstrument) {
  var results = [];
  var allFlags = [];
  for (var id in responsesByInstrument) {
    if (!Object.prototype.hasOwnProperty.call(responsesByInstrument, id)) continue;
    if (!INSTRUMENTS[id]) continue;
    var scored = scoreInstrument(id, responsesByInstrument[id]);
    if (scored) {
      results.push(scored);
      if (scored.flags && scored.flags.length) {
        for (var f = 0; f < scored.flags.length; f++) {
          allFlags.push(Object.assign({ instrument: scored.instrumentName }, scored.flags[f]));
        }
      }
    }
  }
  return { results: results, flags: allFlags };
}

// De-identified metadata for retention past PHI deletion: which instruments,
// their score totals and bands, and any flag types — no item-level responses.
function deidentifiedMetadata(scoredBattery) {
  return (scoredBattery.results || []).map(function (r) {
    return {
      instrumentId: r.instrumentId,
      instrumentName: r.instrumentName,
      domain: r.domain,
      total: r.total,
      max: r.max,
      band: r.band,
      bandLabel: r.bandLabel,
      flagTypes: (r.flags || []).map(function (f) { return f.type; })
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SYMPTOM MAP + CHART BLURBS
// ─────────────────────────────────────────────────────────────────────────────
//
// Two copyable outputs are generated from a completed battery:
//   1. screenerReviewBlurb  - concise first-person "I reviewed screeners..." note
//                             documenting scores, severity, screen result, risk.
//   2. hpiSymptomBlurb       - narrative, ENDORSED-ONLY, screening-provenance
//                             framing ("screening responses reviewed as part of
//                             the interview; endorsed items include ..."). Maps
//                             endorsed items to short clinical symptom phrases by
//                             domain. Feeds the Clinical Note Builder.
//
// Design rules baked in (locked decisions):
//   - ENDORSED-ONLY: the HPI blurb names only items the patient actually endorsed.
//   - SCREENING-PROVENANCE: never asserts symptoms as interview-confirmed; always
//     frames them as screening responses to be integrated with the interview.
//
// SYMPTOM_MAP[instrumentId] = {
//   domainLabel: string,                 // narrative domain header
//   endorsedThreshold: number,           // item value at/above which = endorsed
//   reverseEndorsed: { itemId: true },   // items where endorsement is INVERTED
//   phrases: { itemId: 'short symptom phrase' }
// }

var SYMPTOM_MAP = {
  phq9: {
    domainLabel: 'Depression',
    endorsedThreshold: 1, // 0-3 freq scale; >=1 (Several days+) counts as present
    phrases: {
      phq9_1: 'anhedonia (little interest or pleasure in doing things)',
      phq9_2: 'depressed mood (feeling down, depressed, or hopeless)',
      phq9_3: 'sleep disturbance',
      phq9_4: 'low energy or fatigue',
      phq9_5: 'appetite change',
      phq9_6: 'feelings of worthlessness or excessive guilt',
      phq9_7: 'impaired concentration',
      phq9_8: 'psychomotor change (slowing or restlessness)',
      phq9_9: 'thoughts of being better off dead or of self-harm'
    }
  },
  gad7: {
    domainLabel: 'Anxiety',
    endorsedThreshold: 1,
    phrases: {
      gad7_1: 'feeling nervous, anxious, or on edge',
      gad7_2: 'inability to stop or control worrying',
      gad7_3: 'excessive worry about different things',
      gad7_4: 'difficulty relaxing',
      gad7_5: 'restlessness',
      gad7_6: 'irritability',
      gad7_7: 'a sense that something awful might happen'
    }
  },
  auditc: {
    domainLabel: 'Alcohol use',
    endorsedThreshold: 1,
    phrases: {
      auditc_1: 'regular alcohol consumption',
      auditc_2: 'elevated quantity per drinking occasion',
      auditc_3: 'episodes of heavy (binge) drinking'
    }
  },
  dast10: {
    domainLabel: 'Substance use',
    endorsedThreshold: 1, // yes/no (1/0); yes = endorsed
    reverseEndorsed: { dast10_3: true }, // "always able to stop" -> a NO is the concern
    phrases: {
      dast10_1: 'non-medical drug use',
      dast10_2: 'polysubstance use',
      dast10_3: 'difficulty stopping drug use when desired',
      dast10_4: 'blackouts or flashbacks related to drug use',
      dast10_5: 'guilt about drug use',
      dast10_6: 'family or partner concern about drug use',
      dast10_7: 'neglect of family due to drug use',
      dast10_8: 'illegal activity to obtain drugs',
      dast10_9: 'withdrawal symptoms on stopping',
      dast10_10: 'medical problems resulting from drug use'
    }
  },
  epds: {
    domainLabel: 'Perinatal mood',
    endorsedThreshold: 1, // EPDS items are 0-3 after directional scoring
    phrases: {
      epds_1: 'reduced ability to laugh or see the funny side of things',
      epds_2: 'reduced anticipation or enjoyment',
      epds_3: 'self-blame',
      epds_4: 'anxiety or worry without clear cause',
      epds_5: 'feeling scared or panicky',
      epds_6: 'feeling overwhelmed or unable to cope',
      epds_7: 'sleep disturbance due to unhappiness',
      epds_8: 'sadness',
      epds_9: 'tearfulness',
      epds_10: 'thoughts of self-harm'
    }
  },
  pcl5: {
    domainLabel: 'Trauma / PTSD',
    endorsedThreshold: 2, // PCL-5 0-4; DSM-5 endorsement convention is >=2 (Moderately+)
    phrases: {
      pcl5_1: 'intrusive memories',
      pcl5_2: 'distressing dreams',
      pcl5_3: 'dissociative reactions or flashbacks',
      pcl5_4: 'psychological distress to reminders',
      pcl5_5: 'physiological reactivity to reminders',
      pcl5_6: 'avoidance of internal reminders',
      pcl5_7: 'avoidance of external reminders',
      pcl5_8: 'dissociative amnesia for the event',
      pcl5_9: 'persistent negative beliefs',
      pcl5_10: 'distorted blame',
      pcl5_11: 'persistent negative emotional state',
      pcl5_12: 'diminished interest in activities',
      pcl5_13: 'detachment or estrangement from others',
      pcl5_14: 'restricted positive affect',
      pcl5_15: 'irritability or angry outbursts',
      pcl5_16: 'reckless or self-destructive behavior',
      pcl5_17: 'hypervigilance',
      pcl5_18: 'exaggerated startle response',
      pcl5_19: 'concentration difficulty',
      pcl5_20: 'sleep disturbance'
    }
  },
  ace10: {
    domainLabel: 'Childhood adversity',
    endorsedThreshold: 1, // yes/no
    phrases: {
      ace_1: 'recurrent emotional abuse',
      ace_2: 'recurrent physical abuse',
      ace_3: 'sexual abuse',
      ace_4: 'emotional neglect',
      ace_5: 'physical neglect',
      ace_6: 'parental separation or divorce',
      ace_7: 'witnessing intimate-partner violence in the home',
      ace_8: 'household substance use',
      ace_9: 'household mental illness or suicide attempt',
      ace_10: 'household incarceration'
    }
  },
  asrs: {
    domainLabel: 'ADHD',
    endorsedThreshold: 2, // 0-4; >=2 (Sometimes+) as a narrative-presence floor
    phrases: {
      asrs_1: 'difficulty completing the final details of projects',
      asrs_2: 'difficulty with organization',
      asrs_3: 'problems remembering appointments or obligations',
      asrs_4: 'avoidance or delay of tasks requiring sustained mental effort',
      asrs_5: 'fidgetiness or restlessness',
      asrs_6: 'feeling overly active or driven by a motor'
    }
  },
  wfirs: {
    domainLabel: 'Functional impairment',
    domainBased: true, // special: HPI blurb uses scored impairedDomains, not item phrases
    domainPhrases: {
      'Family': 'family / home-life impairment',
      'Work': 'occupational impairment',
      'School': 'academic / learning impairment',
      'Life skills': 'life-skills impairment (time, money, self-care, sleep)',
      'Self-concept': 'impaired self-concept or confidence',
      'Social': 'social impairment',
      'Risk': 'risk-related or impulse-control problems'
    }
  },
  msibpd: {
    domainLabel: 'Personality (borderline features)',
    endorsedThreshold: 1, // yes/no
    phrases: {
      msibpd_1: 'unstable, conflictual relationships',
      msibpd_2: 'deliberate self-harm and/or past suicide attempt',
      msibpd_3: 'impulsivity across multiple domains',
      msibpd_4: 'marked mood reactivity',
      msibpd_5: 'inappropriate or intense anger',
      msibpd_6: 'pervasive distrust of others',
      msibpd_7: 'dissociative or derealization experiences',
      msibpd_8: 'chronic emptiness',
      msibpd_9: 'identity disturbance',
      msibpd_10: 'frantic efforts to avoid abandonment'
    }
  }
};

// Determine whether an item value counts as "endorsed" for narrative purposes.
function isEndorsed(instId, itemId, value) {
  if (typeof value !== 'number') return false;
  var map = SYMPTOM_MAP[instId];
  if (!map) return false;
  var reverse = map.reverseEndorsed && map.reverseEndorsed[itemId];
  if (reverse) {
    // Inverted item (e.g., "able to stop"): a low/"no" answer is the concern.
    return value < map.endorsedThreshold;
  }
  return value >= map.endorsedThreshold;
}

// Returns the list of endorsed symptom phrases for one instrument given its
// raw responses map.
function endorsedPhrases(instId, responses) {
  var map = SYMPTOM_MAP[instId];
  if (!map || !map.phrases || !responses) return [];
  var out = [];
  var inst = INSTRUMENTS[instId];
  var order = inst ? inst.items.map(function (it) { return it.id; }) : Object.keys(map.phrases);
  for (var i = 0; i < order.length; i++) {
    var itemId = order[i];
    if (!map.phrases[itemId]) continue;
    if (isEndorsed(instId, itemId, responses[itemId])) {
      out.push(map.phrases[itemId]);
    }
  }
  return out;
}

function joinClause(items) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return items[0] + ' and ' + items[1];
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

// 1) Concise first-person screener-review blurb (results documentation).
// Input: scoredBattery from scoreBattery(). Returns a clean paragraph string.
function screenerReviewBlurb(scoredBattery, reasonSent) {
  var results = (scoredBattery && scoredBattery.results) || [];
  if (!results.length) return '';
  var names = results.map(function (r) { return r.instrumentName; });
  var reasonClause = {
    intake: ' as part of the intake assessment',
    monitoring: ' for interval symptom monitoring',
    medchange: ' to monitor response following a medication change',
    worsening: ' in the context of worsening symptoms',
    annual: ' as part of an annual screen',
    documentation: ' for documentation update'
  }[reasonSent] || '';
  var lead = 'I reviewed patient-completed screeners' + reasonClause + ', including ' + joinClause(names) + '. ';
  var sentences = results.map(function (r) {
    // Reuse each instrument's own chart language (already score-accurate).
    return r.chartLanguage;
  });
  var closing = ' Screening results are not diagnostic and were reviewed in the context of the clinical interview, history, risk assessment, and diagnostic formulation.';
  return lead + sentences.join(' ') + closing;
}

// 2) Narrative endorsed-only HPI symptom-domain blurb (screening-provenance).
// Input: scoredBattery + the raw responsesByInstrument map. Returns a paragraph.
function hpiSymptomBlurb(scoredBattery, responsesByInstrument) {
  var results = (scoredBattery && scoredBattery.results) || [];
  if (!results.length) return '';
  var parts = [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var instId = r.instrumentId;
    var map = SYMPTOM_MAP[instId];
    if (!map) continue;

    // Domain-based instruments (WFIRS-S): use the scored impaired domains, not
    // per-item phrases.
    if (map.domainBased) {
      var impaired = r.impairedDomains || [];
      if (!impaired.length) {
        parts.push('On ' + r.instrumentName + ' (functional impairment), no domain reached the validated impairment threshold.');
      } else {
        var domPhrases = impaired.map(function (d) { return (map.domainPhrases && map.domainPhrases[d]) || d.toLowerCase(); });
        parts.push('Functional impairment endorsed on ' + r.instrumentName + ' reaches the validated threshold in: ' + joinClause(domPhrases) + '.');
      }
      continue;
    }

    var resp = (responsesByInstrument && responsesByInstrument[instId]) || {};
    var phrases = endorsedPhrases(instId, resp);
    if (!phrases.length) {
      parts.push('On ' + r.instrumentName + ' screening (' + map.domainLabel.toLowerCase() + '), the patient did not endorse symptoms above the screening threshold.');
      continue;
    }
    parts.push(map.domainLabel + ' symptoms endorsed on ' + r.instrumentName + ' screening include ' + joinClause(phrases) + '.');
  }
  var lead = 'Screening responses were reviewed as part of the diagnostic interview. ';
  var closing = ' These are screening-derived self-report findings, not stand-alone diagnoses, and were integrated with interview data, history, and clinical judgment.';
  return lead + parts.join(' ') + closing;
}

module.exports = {
  INSTRUMENTS: INSTRUMENTS,
  PATIENT_SEND_IDS: PATIENT_SEND_IDS,
  SYMPTOM_MAP: SYMPTOM_MAP,
  getRenderDef: getRenderDef,
  isPatientSendAllowed: isPatientSendAllowed,
  scoreInstrument: scoreInstrument,
  scoreBattery: scoreBattery,
  deidentifiedMetadata: deidentifiedMetadata,
  endorsedPhrases: endorsedPhrases,
  screenerReviewBlurb: screenerReviewBlurb,
  hpiSymptomBlurb: hpiSymptomBlurb
};
