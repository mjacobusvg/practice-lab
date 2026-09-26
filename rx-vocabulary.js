// GENERATED FILE - do not edit by hand.
//   node tools/gen-rx-vocabulary.js
// Source: pm-interaction-checker.html, var MEDICATIONS (210 entries).
//
// A CANDIDATE-DETECTION vocabulary and interaction-engine key map. NOT medication identity.
// The dictionary works at the ingredient level because CYP and serotonergic relationships do,
// so "methylphenidate" covers both Ritalin and Concerta and "amphetamine_mixed_salts" covers
// both Adderall IR and Adderall XR. Those are different products with different labels and
// different maximum doses. A hit here means "this text probably mentions this ingredient". It
// never establishes what product the patient is taking. Prescribing identity comes from the
// clinician's confirmation of the text they actually wrote, resolved through RxNorm/DailyMed.
//
// entries[].substance marks things that are not medications (tobacco, alcohol, grapefruit).
// They matter to the interaction engine and must never appear as a line on a medication list.

(function(){
  var VOCAB = {
   "source": "pm-interaction-checker.html",
   "count": 210,
   "entries": [
    {
     "key": "fluoxetine",
     "generics": [
      "fluoxetine"
     ],
     "brands": [
      "Prozac"
     ],
     "cls": "SSRI"
    },
    {
     "key": "sertraline",
     "generics": [
      "sertraline"
     ],
     "brands": [
      "Zoloft"
     ],
     "cls": "SSRI"
    },
    {
     "key": "paroxetine",
     "generics": [
      "paroxetine"
     ],
     "brands": [
      "Paxil"
     ],
     "cls": "SSRI"
    },
    {
     "key": "escitalopram",
     "generics": [
      "escitalopram"
     ],
     "brands": [
      "Lexapro"
     ],
     "cls": "SSRI"
    },
    {
     "key": "citalopram",
     "generics": [
      "citalopram"
     ],
     "brands": [
      "Celexa"
     ],
     "cls": "SSRI"
    },
    {
     "key": "fluvoxamine",
     "generics": [
      "fluvoxamine"
     ],
     "brands": [
      "Luvox"
     ],
     "cls": "SSRI"
    },
    {
     "key": "venlafaxine",
     "generics": [
      "venlafaxine"
     ],
     "brands": [
      "Effexor"
     ],
     "cls": "SNRI"
    },
    {
     "key": "duloxetine",
     "generics": [
      "duloxetine"
     ],
     "brands": [
      "Cymbalta"
     ],
     "cls": "SNRI"
    },
    {
     "key": "desvenlafaxine",
     "generics": [
      "desvenlafaxine"
     ],
     "brands": [
      "Pristiq"
     ],
     "cls": "SNRI"
    },
    {
     "key": "levomilnacipran",
     "generics": [
      "levomilnacipran"
     ],
     "brands": [
      "Fetzima"
     ],
     "cls": "SNRI"
    },
    {
     "key": "bupropion",
     "generics": [
      "bupropion"
     ],
     "brands": [
      "Wellbutrin"
     ],
     "cls": "Atypical Antidepressant (NDRI)"
    },
    {
     "key": "mirtazapine",
     "generics": [
      "mirtazapine"
     ],
     "brands": [
      "Remeron"
     ],
     "cls": "Atypical Antidepressant (NaSSA)"
    },
    {
     "key": "trazodone",
     "generics": [
      "trazodone"
     ],
     "brands": [
      "Desyrel"
     ],
     "cls": "SARI"
    },
    {
     "key": "vilazodone",
     "generics": [
      "vilazodone"
     ],
     "brands": [
      "Viibryd"
     ],
     "cls": "SSRI/5HT1A partial agonist"
    },
    {
     "key": "vortioxetine",
     "generics": [
      "vortioxetine"
     ],
     "brands": [
      "Trintellix"
     ],
     "cls": "Multimodal Antidepressant"
    },
    {
     "key": "amitriptyline",
     "generics": [
      "amitriptyline"
     ],
     "brands": [
      "Elavil"
     ],
     "cls": "TCA"
    },
    {
     "key": "nortriptyline",
     "generics": [
      "nortriptyline"
     ],
     "brands": [
      "Pamelor"
     ],
     "cls": "TCA"
    },
    {
     "key": "amphetamine_mixed_salts",
     "generics": [
      "amphetamine",
      "mixed amphetamine salts",
      "amphetamine salts",
      "dextroamphetamine-amphetamine",
      "dextroamphetamine/amphetamine"
     ],
     "brands": [
      "Adderall"
     ],
     "cls": "Stimulant"
    },
    {
     "key": "methylphenidate",
     "generics": [
      "methylphenidate"
     ],
     "brands": [
      "Ritalin",
      "Concerta"
     ],
     "cls": "Stimulant"
    },
    {
     "key": "lisdexamfetamine",
     "generics": [
      "lisdexamfetamine"
     ],
     "brands": [
      "Vyvanse"
     ],
     "cls": "Stimulant (prodrug)"
    },
    {
     "key": "atomoxetine",
     "generics": [
      "atomoxetine"
     ],
     "brands": [
      "Strattera"
     ],
     "cls": "Non-Stimulant ADHD (NRI)"
    },
    {
     "key": "guanfacine",
     "generics": [
      "guanfacine"
     ],
     "brands": [
      "Intuniv"
     ],
     "cls": "Alpha-2 Agonist"
    },
    {
     "key": "clonidine",
     "generics": [
      "clonidine"
     ],
     "brands": [
      "Catapres",
      "Kapvay"
     ],
     "cls": "Alpha-2 Agonist"
    },
    {
     "key": "quetiapine",
     "generics": [
      "quetiapine"
     ],
     "brands": [
      "Seroquel"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "olanzapine",
     "generics": [
      "olanzapine"
     ],
     "brands": [
      "Zyprexa"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "risperidone",
     "generics": [
      "risperidone"
     ],
     "brands": [
      "Risperdal"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "aripiprazole",
     "generics": [
      "aripiprazole"
     ],
     "brands": [
      "Abilify"
     ],
     "cls": "Second-Generation Antipsychotic (partial D2 agonist)"
    },
    {
     "key": "cariprazine",
     "generics": [
      "cariprazine"
     ],
     "brands": [
      "Vraylar"
     ],
     "cls": "Second-Generation Antipsychotic (partial D2/D3 agonist)"
    },
    {
     "key": "ziprasidone",
     "generics": [
      "ziprasidone"
     ],
     "brands": [
      "Geodon"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "lurasidone",
     "generics": [
      "lurasidone"
     ],
     "brands": [
      "Latuda"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "clozapine",
     "generics": [
      "clozapine"
     ],
     "brands": [
      "Clozaril"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "paliperidone",
     "generics": [
      "paliperidone"
     ],
     "brands": [
      "Invega"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "brexpiprazole",
     "generics": [
      "brexpiprazole"
     ],
     "brands": [
      "Rexulti"
     ],
     "cls": "Second-Generation Antipsychotic (partial D2 agonist)"
    },
    {
     "key": "pimozide",
     "generics": [
      "pimozide"
     ],
     "brands": [
      "Orap"
     ],
     "cls": "First-Generation Antipsychotic"
    },
    {
     "key": "haloperidol",
     "generics": [
      "haloperidol"
     ],
     "brands": [
      "Haldol"
     ],
     "cls": "First-Generation Antipsychotic"
    },
    {
     "key": "lithium",
     "generics": [
      "lithium"
     ],
     "brands": [
      "Lithobid",
      "Eskalith"
     ],
     "cls": "Mood Stabilizer"
    },
    {
     "key": "valproate",
     "generics": [
      "valproate"
     ],
     "brands": [
      "Depakote"
     ],
     "cls": "Mood Stabilizer / Anticonvulsant"
    },
    {
     "key": "lamotrigine",
     "generics": [
      "lamotrigine"
     ],
     "brands": [
      "Lamictal"
     ],
     "cls": "Mood Stabilizer / Anticonvulsant"
    },
    {
     "key": "carbamazepine",
     "generics": [
      "carbamazepine"
     ],
     "brands": [
      "Tegretol"
     ],
     "cls": "Anticonvulsant / Mood Stabilizer"
    },
    {
     "key": "oxcarbazepine",
     "generics": [
      "oxcarbazepine"
     ],
     "brands": [
      "Trileptal"
     ],
     "cls": "Anticonvulsant"
    },
    {
     "key": "alprazolam",
     "generics": [
      "alprazolam"
     ],
     "brands": [
      "Xanax"
     ],
     "cls": "Benzodiazepine"
    },
    {
     "key": "lorazepam",
     "generics": [
      "lorazepam"
     ],
     "brands": [
      "Ativan"
     ],
     "cls": "Benzodiazepine"
    },
    {
     "key": "clonazepam",
     "generics": [
      "clonazepam"
     ],
     "brands": [
      "Klonopin"
     ],
     "cls": "Benzodiazepine"
    },
    {
     "key": "diazepam",
     "generics": [
      "diazepam"
     ],
     "brands": [
      "Valium"
     ],
     "cls": "Benzodiazepine"
    },
    {
     "key": "zolpidem",
     "generics": [
      "zolpidem"
     ],
     "brands": [
      "Ambien"
     ],
     "cls": "Z-drug (GABA-A agonist)"
    },
    {
     "key": "suvorexant",
     "generics": [
      "suvorexant"
     ],
     "brands": [
      "Belsomra"
     ],
     "cls": "Orexin Receptor Antagonist (DORA)"
    },
    {
     "key": "lemborexant",
     "generics": [
      "lemborexant"
     ],
     "brands": [
      "Dayvigo"
     ],
     "cls": "Orexin Receptor Antagonist (DORA)"
    },
    {
     "key": "hydroxyzine",
     "generics": [
      "hydroxyzine"
     ],
     "brands": [
      "Vistaril",
      "Atarax"
     ],
     "cls": "Antihistamine"
    },
    {
     "key": "gabapentin",
     "generics": [
      "gabapentin"
     ],
     "brands": [
      "Neurontin"
     ],
     "cls": "Gabapentinoid"
    },
    {
     "key": "pregabalin",
     "generics": [
      "pregabalin"
     ],
     "brands": [
      "Lyrica"
     ],
     "cls": "Gabapentinoid"
    },
    {
     "key": "linezolid",
     "generics": [
      "linezolid"
     ],
     "brands": [
      "Zyvox"
     ],
     "cls": "Antibiotic (reversible MAOI)"
    },
    {
     "key": "methylene_blue",
     "generics": [],
     "brands": [
      "ProvayBlue"
     ],
     "cls": "Diagnostic/Therapeutic (MAOI activity)"
    },
    {
     "key": "buprenorphine",
     "generics": [
      "buprenorphine"
     ],
     "brands": [
      "Suboxone",
      "Sublocade"
     ],
     "cls": "Opioid Partial Agonist"
    },
    {
     "key": "naltrexone",
     "generics": [
      "naltrexone"
     ],
     "brands": [
      "Vivitrol",
      "ReVia"
     ],
     "cls": "Opioid Antagonist"
    },
    {
     "key": "ibuprofen",
     "generics": [
      "ibuprofen"
     ],
     "brands": [
      "Advil",
      "Motrin"
     ],
     "cls": "NSAID"
    },
    {
     "key": "naproxen",
     "generics": [
      "naproxen"
     ],
     "brands": [
      "Aleve"
     ],
     "cls": "NSAID"
    },
    {
     "key": "phenelzine",
     "generics": [
      "phenelzine"
     ],
     "brands": [
      "Nardil"
     ],
     "cls": "MAOI"
    },
    {
     "key": "tranylcypromine",
     "generics": [
      "tranylcypromine"
     ],
     "brands": [
      "Parnate"
     ],
     "cls": "MAOI"
    },
    {
     "key": "selegiline_transdermal",
     "generics": [
      "selegiline"
     ],
     "brands": [
      "EMSAM"
     ],
     "cls": "MAOI (transdermal)"
    },
    {
     "key": "buspirone",
     "generics": [
      "buspirone"
     ],
     "brands": [
      "Buspar"
     ],
     "cls": "Azapirone (5HT1A partial agonist)"
    },
    {
     "key": "prazosin",
     "generics": [
      "prazosin"
     ],
     "brands": [
      "Minipress"
     ],
     "cls": "Alpha-1 Blocker"
    },
    {
     "key": "propranolol",
     "generics": [
      "propranolol"
     ],
     "brands": [
      "Inderal"
     ],
     "cls": "Beta Blocker"
    },
    {
     "key": "dextromethorphan_bupropion",
     "generics": [
      "dextromethorphan-bupropion"
     ],
     "brands": [
      "Auvelity"
     ],
     "cls": "NMDA antagonist / NDRI combination"
    },
    {
     "key": "chlorpromazine",
     "generics": [
      "chlorpromazine"
     ],
     "brands": [
      "Thorazine"
     ],
     "cls": "First-Generation Antipsychotic"
    },
    {
     "key": "fluphenazine",
     "generics": [
      "fluphenazine"
     ],
     "brands": [
      "Prolixin"
     ],
     "cls": "First-Generation Antipsychotic"
    },
    {
     "key": "thiothixene",
     "generics": [
      "thiothixene"
     ],
     "brands": [
      "Navane"
     ],
     "cls": "First-Generation Antipsychotic"
    },
    {
     "key": "eszopiclone",
     "generics": [
      "eszopiclone"
     ],
     "brands": [
      "Lunesta"
     ],
     "cls": "Z-drug (GABA-A agonist)"
    },
    {
     "key": "ramelteon",
     "generics": [
      "ramelteon"
     ],
     "brands": [
      "Rozerem"
     ],
     "cls": "Melatonin Receptor Agonist"
    },
    {
     "key": "doxepin_low_dose",
     "generics": [
      "doxepin"
     ],
     "brands": [
      "Silenor"
     ],
     "cls": "TCA (low-dose sleep)"
    },
    {
     "key": "topiramate",
     "generics": [
      "topiramate"
     ],
     "brands": [
      "Topamax"
     ],
     "cls": "Anticonvulsant"
    },
    {
     "key": "codeine",
     "generics": [
      "codeine"
     ],
     "brands": [],
     "cls": "Opioid (prodrug)"
    },
    {
     "key": "tamoxifen",
     "generics": [
      "tamoxifen"
     ],
     "brands": [
      "Nolvadex"
     ],
     "cls": "SERM (prodrug)"
    },
    {
     "key": "modafinil",
     "generics": [
      "modafinil"
     ],
     "brands": [
      "Provigil"
     ],
     "cls": "Wakefulness-Promoting Agent"
    },
    {
     "key": "armodafinil",
     "generics": [
      "armodafinil"
     ],
     "brands": [
      "Nuvigil"
     ],
     "cls": "Wakefulness-Promoting Agent"
    },
    {
     "key": "benztropine",
     "generics": [
      "benztropine"
     ],
     "brands": [
      "Cogentin"
     ],
     "cls": "Anticholinergic (EPS treatment)"
    },
    {
     "key": "trihexyphenidyl",
     "generics": [
      "trihexyphenidyl"
     ],
     "brands": [
      "Artane"
     ],
     "cls": "Anticholinergic (EPS treatment)"
    },
    {
     "key": "diphenhydramine",
     "generics": [
      "diphenhydramine"
     ],
     "brands": [
      "Benadryl"
     ],
     "cls": "Antihistamine / Anticholinergic"
    },
    {
     "key": "ketamine",
     "generics": [
      "ketamine"
     ],
     "brands": [
      "Ketalar"
     ],
     "cls": "NMDA Antagonist (dissociative)"
    },
    {
     "key": "esketamine",
     "generics": [
      "esketamine"
     ],
     "brands": [
      "Spravato"
     ],
     "cls": "NMDA Antagonist (intranasal)"
    },
    {
     "key": "cannabis_thc",
     "generics": [
      "cannabis",
      "marijuana",
      "thc"
     ],
     "brands": [],
     "cls": "Cannabinoid",
     "substance": true
    },
    {
     "key": "asenapine",
     "generics": [
      "asenapine"
     ],
     "brands": [
      "Saphris"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "iloperidone",
     "generics": [
      "iloperidone"
     ],
     "brands": [
      "Fanapt"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "lumateperone",
     "generics": [
      "lumateperone"
     ],
     "brands": [
      "Caplyta"
     ],
     "cls": "Second-Generation Antipsychotic"
    },
    {
     "key": "thyroid_levothyroxine",
     "generics": [
      "levothyroxine"
     ],
     "brands": [
      "Synthroid",
      "Levoxyl"
     ],
     "cls": "Thyroid Hormone"
    },
    {
     "key": "omeprazole",
     "generics": [
      "omeprazole"
     ],
     "brands": [
      "Prilosec"
     ],
     "cls": "Proton Pump Inhibitor"
    },
    {
     "key": "tobacco_smoking",
     "generics": [
      "tobacco",
      "nicotine",
      "smoking"
     ],
     "brands": [],
     "cls": "1A2 Inducer (non-medication)",
     "substance": true
    },
    {
     "key": "caffeine",
     "generics": [
      "caffeine"
     ],
     "brands": [],
     "cls": "1A2 Substrate (non-medication)",
     "substance": true
    },
    {
     "key": "alcohol_ethanol",
     "generics": [
      "alcohol",
      "ethanol"
     ],
     "brands": [],
     "cls": "CNS Depressant (non-medication)",
     "substance": true
    },
    {
     "key": "tramadol",
     "generics": [
      "tramadol"
     ],
     "brands": [
      "Ultram"
     ],
     "cls": "Opioid analgesic (weak mu-agonist + SNRI properties)"
    },
    {
     "key": "tizanidine",
     "generics": [
      "tizanidine"
     ],
     "brands": [
      "Zanaflex"
     ],
     "cls": "Muscle relaxant (alpha-2 adrenergic agonist)"
    },
    {
     "key": "ciprofloxacin",
     "generics": [
      "ciprofloxacin"
     ],
     "brands": [
      "Cipro"
     ],
     "cls": "Fluoroquinolone antibiotic"
    },
    {
     "key": "ondansetron",
     "generics": [
      "ondansetron"
     ],
     "brands": [
      "Zofran"
     ],
     "cls": "Antiemetic (5-HT3 antagonist)"
    },
    {
     "key": "fluconazole",
     "generics": [
      "fluconazole"
     ],
     "brands": [
      "Diflucan"
     ],
     "cls": "Antifungal (azole)"
    },
    {
     "key": "methadone",
     "generics": [
      "methadone"
     ],
     "brands": [
      "Dolophine",
      "Methadose"
     ],
     "cls": "Opioid agonist (full mu-agonist, NMDA antagonist)"
    },
    {
     "key": "warfarin",
     "generics": [
      "warfarin"
     ],
     "brands": [
      "Coumadin"
     ],
     "cls": "Anticoagulant (vitamin K antagonist)"
    },
    {
     "key": "ketorolac",
     "generics": [
      "ketorolac"
     ],
     "brands": [
      "Toradol"
     ],
     "cls": "NSAID (non-selective COX inhibitor)"
    },
    {
     "key": "celecoxib",
     "generics": [
      "celecoxib"
     ],
     "brands": [
      "Celebrex"
     ],
     "cls": "NSAID (selective COX-2 inhibitor)"
    },
    {
     "key": "lisinopril",
     "generics": [
      "lisinopril"
     ],
     "brands": [
      "Prinivil",
      "Zestril"
     ],
     "cls": "ACE inhibitor (antihypertensive)"
    },
    {
     "key": "losartan",
     "generics": [
      "losartan"
     ],
     "brands": [
      "Cozaar"
     ],
     "cls": "ARB (antihypertensive)"
    },
    {
     "key": "hydrochlorothiazide",
     "generics": [
      "hydrochlorothiazide"
     ],
     "brands": [
      "Microzide"
     ],
     "cls": "Thiazide diuretic"
    },
    {
     "key": "furosemide",
     "generics": [
      "furosemide"
     ],
     "brands": [
      "Lasix"
     ],
     "cls": "Loop diuretic"
    },
    {
     "key": "hydrocodone",
     "generics": [
      "hydrocodone"
     ],
     "brands": [
      "Vicodin",
      "Norco"
     ],
     "cls": "Opioid analgesic"
    },
    {
     "key": "oxycodone",
     "generics": [
      "oxycodone"
     ],
     "brands": [
      "OxyContin",
      "Percocet"
     ],
     "cls": "Opioid analgesic"
    },
    {
     "key": "morphine",
     "generics": [
      "morphine"
     ],
     "brands": [
      "MS Contin"
     ],
     "cls": "Opioid analgesic"
    },
    {
     "key": "sumatriptan",
     "generics": [
      "sumatriptan"
     ],
     "brands": [
      "Imitrex"
     ],
     "cls": "Triptan (5-HT1B/1D agonist, migraine)"
    },
    {
     "key": "cyclobenzaprine",
     "generics": [
      "cyclobenzaprine"
     ],
     "brands": [
      "Flexeril"
     ],
     "cls": "Muscle relaxant (TCA-related structure)"
    },
    {
     "key": "dextromethorphan",
     "generics": [
      "dextromethorphan"
     ],
     "brands": [
      "OTC cough",
      "Auvelity component"
     ],
     "cls": "Antitussive (NMDA antagonist, sigma-1 agonist)"
    },
    {
     "key": "metoclopramide",
     "generics": [
      "metoclopramide"
     ],
     "brands": [
      "Reglan"
     ],
     "cls": "Antiemetic / prokinetic (D2 antagonist)"
    },
    {
     "key": "levofloxacin",
     "generics": [
      "levofloxacin"
     ],
     "brands": [
      "Levaquin"
     ],
     "cls": "Fluoroquinolone antibiotic"
    },
    {
     "key": "moxifloxacin",
     "generics": [
      "moxifloxacin"
     ],
     "brands": [
      "Avelox"
     ],
     "cls": "Fluoroquinolone antibiotic"
    },
    {
     "key": "azithromycin",
     "generics": [
      "azithromycin"
     ],
     "brands": [
      "Zithromax",
      "Z-pack"
     ],
     "cls": "Macrolide antibiotic"
    },
    {
     "key": "erythromycin",
     "generics": [
      "erythromycin"
     ],
     "brands": [],
     "cls": "Macrolide antibiotic"
    },
    {
     "key": "clarithromycin",
     "generics": [
      "clarithromycin"
     ],
     "brands": [
      "Biaxin"
     ],
     "cls": "Macrolide antibiotic"
    },
    {
     "key": "rifampin",
     "generics": [
      "rifampin"
     ],
     "brands": [
      "Rifadin"
     ],
     "cls": "Antibiotic (antimycobacterial)"
    },
    {
     "key": "ketoconazole",
     "generics": [
      "ketoconazole"
     ],
     "brands": [
      "Nizoral"
     ],
     "cls": "Antifungal (azole)"
    },
    {
     "key": "itraconazole",
     "generics": [
      "itraconazole"
     ],
     "brands": [
      "Sporanox"
     ],
     "cls": "Antifungal (azole)"
    },
    {
     "key": "diltiazem",
     "generics": [
      "diltiazem"
     ],
     "brands": [
      "Cardizem"
     ],
     "cls": "Calcium channel blocker (non-dihydropyridine)"
    },
    {
     "key": "verapamil",
     "generics": [
      "verapamil"
     ],
     "brands": [
      "Calan",
      "Verelan"
     ],
     "cls": "Calcium channel blocker (non-dihydropyridine)"
    },
    {
     "key": "cimetidine",
     "generics": [
      "cimetidine"
     ],
     "brands": [
      "Tagamet"
     ],
     "cls": "H2 blocker (OTC antacid)"
    },
    {
     "key": "phenytoin",
     "generics": [
      "phenytoin"
     ],
     "brands": [
      "Dilantin"
     ],
     "cls": "Anticonvulsant (hydantoin)"
    },
    {
     "key": "phenobarbital",
     "generics": [
      "phenobarbital"
     ],
     "brands": [],
     "cls": "Barbiturate anticonvulsant"
    },
    {
     "key": "st_johns_wort",
     "generics": [
      "st john's wort",
      "st johns wort",
      "st. john's wort"
     ],
     "brands": [],
     "cls": "Herbal supplement (Hypericum perforatum)",
     "substance": true
    },
    {
     "key": "grapefruit_juice",
     "generics": [
      "grapefruit"
     ],
     "brands": [
      "food",
      "beverage"
     ],
     "cls": "CYP3A4 inhibitor (dietary)",
     "substance": true
    },
    {
     "key": "ethinyl_estradiol_oral_contraceptive",
     "generics": [
      "ethinyl estradiol",
      "oral contraceptive"
     ],
     "brands": [],
     "cls": "Estrogen-containing hormonal contraceptive"
    },
    {
     "key": "prednisone",
     "generics": [
      "prednisone"
     ],
     "brands": [
      "Deltasone"
     ],
     "cls": "Corticosteroid (systemic)"
    },
    {
     "key": "dexamethasone",
     "generics": [
      "dexamethasone"
     ],
     "brands": [
      "Decadron"
     ],
     "cls": "Corticosteroid (systemic, high-potency)"
    },
    {
     "key": "baclofen",
     "generics": [
      "baclofen"
     ],
     "brands": [
      "Lioresal"
     ],
     "cls": "Muscle relaxant (GABA-B agonist)"
    },
    {
     "key": "carisoprodol",
     "generics": [
      "carisoprodol"
     ],
     "brands": [
      "Soma"
     ],
     "cls": "Muscle relaxant (carbamate derivative)"
    },
    {
     "key": "prochlorperazine",
     "generics": [
      "prochlorperazine"
     ],
     "brands": [
      "Compazine"
     ],
     "cls": "Antiemetic (phenothiazine, D2 antagonist)"
    },
    {
     "key": "promethazine",
     "generics": [
      "promethazine"
     ],
     "brands": [
      "Phenergan"
     ],
     "cls": "Antiemetic / antihistamine (phenothiazine)"
    },
    {
     "key": "doxylamine",
     "generics": [
      "doxylamine"
     ],
     "brands": [
      "Unisom SleepTabs"
     ],
     "cls": "Antihistamine (H1 antagonist, OTC sleep aid)"
    },
    {
     "key": "apixaban",
     "generics": [
      "apixaban"
     ],
     "brands": [
      "Eliquis"
     ],
     "cls": "DOAC (direct factor Xa inhibitor)"
    },
    {
     "key": "rivaroxaban",
     "generics": [
      "rivaroxaban"
     ],
     "brands": [
      "Xarelto"
     ],
     "cls": "DOAC (direct factor Xa inhibitor)"
    },
    {
     "key": "aspirin",
     "generics": [
      "aspirin"
     ],
     "brands": [
      "Bayer"
     ],
     "cls": "Antiplatelet / NSAID"
    },
    {
     "key": "amlodipine",
     "generics": [
      "amlodipine"
     ],
     "brands": [
      "Norvasc"
     ],
     "cls": "Calcium channel blocker (dihydropyridine)"
    },
    {
     "key": "metoprolol",
     "generics": [
      "metoprolol"
     ],
     "brands": [
      "Lopressor",
      "Toprol XL"
     ],
     "cls": "Beta blocker (cardioselective, beta-1)"
    },
    {
     "key": "atenolol",
     "generics": [
      "atenolol"
     ],
     "brands": [
      "Tenormin"
     ],
     "cls": "Beta blocker (cardioselective, beta-1)"
    },
    {
     "key": "pseudoephedrine",
     "generics": [
      "pseudoephedrine"
     ],
     "brands": [
      "Sudafed"
     ],
     "cls": "Sympathomimetic decongestant"
    },
    {
     "key": "spironolactone",
     "generics": [
      "spironolactone"
     ],
     "brands": [
      "Aldactone"
     ],
     "cls": "Potassium-sparing diuretic (aldosterone antagonist)"
    },
    {
     "key": "meperidine",
     "generics": [
      "meperidine"
     ],
     "brands": [
      "Demerol"
     ],
     "cls": "Opioid analgesic"
    },
    {
     "key": "fentanyl",
     "generics": [
      "fentanyl"
     ],
     "brands": [
      "Duragesic",
      "Sublimaze"
     ],
     "cls": "Opioid analgesic (synthetic, high potency)"
    },
    {
     "key": "theophylline",
     "generics": [
      "theophylline"
     ],
     "brands": [
      "Theo-24"
     ],
     "cls": "Methylxanthine bronchodilator"
    },
    {
     "key": "isoniazid",
     "generics": [
      "isoniazid"
     ],
     "brands": [
      "INH"
     ],
     "cls": "Antimycobacterial antibiotic"
    },
    {
     "key": "metformin",
     "generics": [
      "metformin"
     ],
     "brands": [
      "Glucophage"
     ],
     "cls": "Antidiabetic (biguanide)"
    },
    {
     "key": "acetaminophen",
     "generics": [
      "acetaminophen"
     ],
     "brands": [
      "Tylenol"
     ],
     "cls": "Analgesic / antipyretic"
    },
    {
     "key": "cetirizine",
     "generics": [
      "cetirizine"
     ],
     "brands": [
      "Zyrtec"
     ],
     "cls": "Second-generation antihistamine"
    },
    {
     "key": "loratadine",
     "generics": [
      "loratadine"
     ],
     "brands": [
      "Claritin"
     ],
     "cls": "Second-generation antihistamine"
    },
    {
     "key": "fexofenadine",
     "generics": [
      "fexofenadine"
     ],
     "brands": [
      "Allegra"
     ],
     "cls": "Second-generation antihistamine"
    },
    {
     "key": "melatonin",
     "generics": [
      "melatonin"
     ],
     "brands": [],
     "cls": "Supplement (endogenous hormone analog)"
    },
    {
     "key": "valerian",
     "generics": [
      "valerian"
     ],
     "brands": [],
     "cls": "Herbal supplement (GABA-ergic)"
    },
    {
     "key": "kratom",
     "generics": [
      "kratom"
     ],
     "brands": [
      "unregulated substance"
     ],
     "cls": "Herbal substance (mitragynine, opioid/stimulant properties)",
     "substance": true
    },
    {
     "key": "clopidogrel",
     "generics": [
      "clopidogrel"
     ],
     "brands": [
      "Plavix"
     ],
     "cls": "Antiplatelet (P2Y12 inhibitor, thienopyridine prodrug)"
    },
    {
     "key": "carvedilol",
     "generics": [
      "carvedilol"
     ],
     "brands": [
      "Coreg"
     ],
     "cls": "Beta blocker (non-selective beta + alpha-1 blocker)"
    },
    {
     "key": "semaglutide",
     "generics": [
      "semaglutide"
     ],
     "brands": [
      "Ozempic",
      "Wegovy",
      "Rybelsus"
     ],
     "cls": "GLP-1 receptor agonist"
    },
    {
     "key": "tirzepatide",
     "generics": [
      "tirzepatide"
     ],
     "brands": [
      "Mounjaro",
      "Zepbound"
     ],
     "cls": "GLP-1/GIP dual receptor agonist"
    },
    {
     "key": "atorvastatin",
     "generics": [
      "atorvastatin"
     ],
     "brands": [
      "Lipitor"
     ],
     "cls": "Statin (HMG-CoA reductase inhibitor)"
    },
    {
     "key": "simvastatin",
     "generics": [
      "simvastatin"
     ],
     "brands": [
      "Zocor"
     ],
     "cls": "Statin (HMG-CoA reductase inhibitor)"
    },
    {
     "key": "rosuvastatin",
     "generics": [
      "rosuvastatin"
     ],
     "brands": [
      "Crestor"
     ],
     "cls": "Statin (HMG-CoA reductase inhibitor)"
    },
    {
     "key": "pravastatin",
     "generics": [
      "pravastatin"
     ],
     "brands": [
      "Pravachol"
     ],
     "cls": "Statin (HMG-CoA reductase inhibitor)"
    },
    {
     "key": "valsartan",
     "generics": [
      "valsartan"
     ],
     "brands": [
      "Diovan"
     ],
     "cls": "ARB (angiotensin II receptor blocker)"
    },
    {
     "key": "olmesartan",
     "generics": [
      "olmesartan"
     ],
     "brands": [
      "Benicar"
     ],
     "cls": "ARB (angiotensin II receptor blocker)"
    },
    {
     "key": "irbesartan",
     "generics": [
      "irbesartan"
     ],
     "brands": [
      "Avapro"
     ],
     "cls": "ARB (angiotensin II receptor blocker)"
    },
    {
     "key": "benazepril",
     "generics": [
      "benazepril"
     ],
     "brands": [
      "Lotensin"
     ],
     "cls": "ACE inhibitor"
    },
    {
     "key": "enalapril",
     "generics": [
      "enalapril"
     ],
     "brands": [
      "Vasotec"
     ],
     "cls": "ACE inhibitor"
    },
    {
     "key": "chlorthalidone",
     "generics": [
      "chlorthalidone"
     ],
     "brands": [
      "Hygroton",
      "Thalitone"
     ],
     "cls": "Thiazide-like diuretic"
    },
    {
     "key": "torsemide",
     "generics": [
      "torsemide"
     ],
     "brands": [
      "Demadex"
     ],
     "cls": "Loop diuretic"
    },
    {
     "key": "nifedipine",
     "generics": [
      "nifedipine"
     ],
     "brands": [
      "Procardia",
      "Adalat"
     ],
     "cls": "Calcium channel blocker (dihydropyridine)"
    },
    {
     "key": "amiodarone",
     "generics": [
      "amiodarone"
     ],
     "brands": [
      "Cordarone",
      "Pacerone"
     ],
     "cls": "Class III antiarrhythmic"
    },
    {
     "key": "sotalol",
     "generics": [
      "sotalol"
     ],
     "brands": [
      "Betapace"
     ],
     "cls": "Class III antiarrhythmic + non-selective beta blocker"
    },
    {
     "key": "digoxin",
     "generics": [
      "digoxin"
     ],
     "brands": [
      "Lanoxin"
     ],
     "cls": "Cardiac glycoside"
    },
    {
     "key": "nitroglycerin",
     "generics": [
      "nitroglycerin"
     ],
     "brands": [
      "Nitrostat",
      "NitroBid"
     ],
     "cls": "Nitrate vasodilator"
    },
    {
     "key": "empagliflozin",
     "generics": [
      "empagliflozin"
     ],
     "brands": [
      "Jardiance"
     ],
     "cls": "SGLT2 inhibitor"
    },
    {
     "key": "dapagliflozin",
     "generics": [
      "dapagliflozin"
     ],
     "brands": [
      "Farxiga"
     ],
     "cls": "SGLT2 inhibitor"
    },
    {
     "key": "sitagliptin",
     "generics": [
      "sitagliptin"
     ],
     "brands": [
      "Januvia"
     ],
     "cls": "DPP-4 inhibitor"
    },
    {
     "key": "glipizide",
     "generics": [
      "glipizide"
     ],
     "brands": [
      "Glucotrol"
     ],
     "cls": "Sulfonylurea"
    },
    {
     "key": "insulin_glargine",
     "generics": [],
     "brands": [
      "Lantus",
      "Basaglar",
      "Semglee"
     ],
     "cls": "Long-acting basal insulin analog"
    },
    {
     "key": "insulin_lispro",
     "generics": [],
     "brands": [
      "Humalog",
      "Admelog"
     ],
     "cls": "Rapid-acting insulin analog"
    },
    {
     "key": "pioglitazone",
     "generics": [
      "pioglitazone"
     ],
     "brands": [
      "Actos"
     ],
     "cls": "Thiazolidinedione (TZD / PPAR-gamma agonist)"
    },
    {
     "key": "pantoprazole",
     "generics": [
      "pantoprazole"
     ],
     "brands": [
      "Protonix"
     ],
     "cls": "Proton pump inhibitor"
    },
    {
     "key": "esomeprazole",
     "generics": [
      "esomeprazole"
     ],
     "brands": [
      "Nexium"
     ],
     "cls": "Proton pump inhibitor (S-isomer of omeprazole)"
    },
    {
     "key": "famotidine",
     "generics": [
      "famotidine"
     ],
     "brands": [
      "Pepcid"
     ],
     "cls": "H2 receptor antagonist"
    },
    {
     "key": "sucralfate",
     "generics": [
      "sucralfate"
     ],
     "brands": [
      "Carafate"
     ],
     "cls": "GI protectant (mucosal barrier)"
    },
    {
     "key": "albuterol",
     "generics": [
      "albuterol"
     ],
     "brands": [
      "Ventolin",
      "ProAir"
     ],
     "cls": "Short-acting beta-2 agonist (SABA)"
    },
    {
     "key": "montelukast",
     "generics": [
      "montelukast"
     ],
     "brands": [
      "Singulair"
     ],
     "cls": "Leukotriene receptor antagonist"
    },
    {
     "key": "fluticasone_nasal",
     "generics": [
      "fluticasone"
     ],
     "brands": [
      "Flonase"
     ],
     "cls": "Intranasal corticosteroid"
    },
    {
     "key": "fluticasone_salmeterol",
     "generics": [],
     "brands": [
      "Advair"
     ],
     "cls": "Inhaled corticosteroid + long-acting beta-2 agonist (ICS/LABA)"
    },
    {
     "key": "budesonide_formoterol",
     "generics": [],
     "brands": [
      "Symbicort"
     ],
     "cls": "Inhaled corticosteroid + long-acting beta-2 agonist (ICS/LABA)"
    },
    {
     "key": "tiotropium",
     "generics": [
      "tiotropium"
     ],
     "brands": [
      "Spiriva"
     ],
     "cls": "Long-acting muscarinic antagonist (LAMA) — inhaled anticholinergic"
    },
    {
     "key": "ipratropium",
     "generics": [
      "ipratropium"
     ],
     "brands": [
      "Atrovent"
     ],
     "cls": "Short-acting muscarinic antagonist (SAMA) — inhaled anticholinergic"
    },
    {
     "key": "meloxicam",
     "generics": [
      "meloxicam"
     ],
     "brands": [
      "Mobic"
     ],
     "cls": "NSAID (preferential COX-2)"
    },
    {
     "key": "diclofenac",
     "generics": [
      "diclofenac"
     ],
     "brands": [
      "Voltaren"
     ],
     "cls": "NSAID (non-selective COX inhibitor)"
    },
    {
     "key": "methocarbamol",
     "generics": [
      "methocarbamol"
     ],
     "brands": [
      "Robaxin"
     ],
     "cls": "Centrally-acting muscle relaxant"
    },
    {
     "key": "lidocaine_topical",
     "generics": [
      "lidocaine"
     ],
     "brands": [
      "Lidoderm"
     ],
     "cls": "Local anesthetic (topical)"
    },
    {
     "key": "amoxicillin",
     "generics": [
      "amoxicillin"
     ],
     "brands": [
      "Amoxil"
     ],
     "cls": "Aminopenicillin antibiotic"
    },
    {
     "key": "amoxicillin_clavulanate",
     "generics": [],
     "brands": [
      "Augmentin"
     ],
     "cls": "Aminopenicillin + beta-lactamase inhibitor"
    },
    {
     "key": "cephalexin",
     "generics": [
      "cephalexin"
     ],
     "brands": [
      "Keflex"
     ],
     "cls": "First-generation cephalosporin"
    },
    {
     "key": "doxycycline",
     "generics": [
      "doxycycline"
     ],
     "brands": [
      "Vibramycin",
      "Doryx"
     ],
     "cls": "Tetracycline antibiotic"
    },
    {
     "key": "trimethoprim_sulfamethoxazole",
     "generics": [],
     "brands": [
      "Bactrim",
      "Septra"
     ],
     "cls": "Antibiotic (folate antagonist combination)"
    },
    {
     "key": "nitrofurantoin",
     "generics": [
      "nitrofurantoin"
     ],
     "brands": [
      "Macrobid",
      "Macrodantin"
     ],
     "cls": "Nitrofuran antibiotic (urinary antiseptic)"
    },
    {
     "key": "metronidazole",
     "generics": [
      "metronidazole"
     ],
     "brands": [
      "Flagyl"
     ],
     "cls": "Nitroimidazole antibiotic/antiprotozoal"
    },
    {
     "key": "valacyclovir",
     "generics": [
      "valacyclovir"
     ],
     "brands": [
      "Valtrex"
     ],
     "cls": "Antiviral (acyclovir prodrug)"
    },
    {
     "key": "liothyronine",
     "generics": [
      "liothyronine"
     ],
     "brands": [
      "Cytomel"
     ],
     "cls": "Thyroid hormone (T3)"
    },
    {
     "key": "testosterone",
     "generics": [
      "testosterone"
     ],
     "brands": [],
     "cls": "Androgen hormone"
    },
    {
     "key": "estradiol",
     "generics": [
      "estradiol"
     ],
     "brands": [
      "Estrace",
      "various patches"
     ],
     "cls": "Estrogen hormone"
    },
    {
     "key": "progesterone",
     "generics": [
      "progesterone"
     ],
     "brands": [
      "Prometrium"
     ],
     "cls": "Progestogen hormone"
    },
    {
     "key": "levetiracetam",
     "generics": [
      "levetiracetam"
     ],
     "brands": [
      "Keppra"
     ],
     "cls": "Antiepileptic (SV2A binding)"
    },
    {
     "key": "zonisamide",
     "generics": [
      "zonisamide"
     ],
     "brands": [
      "Zonegran"
     ],
     "cls": "Antiepileptic (sulfonamide derivative)"
    },
    {
     "key": "rimegepant",
     "generics": [
      "rimegepant"
     ],
     "brands": [
      "Nurtec ODT"
     ],
     "cls": "CGRP receptor antagonist (gepant)"
    },
    {
     "key": "ubrogepant",
     "generics": [
      "ubrogepant"
     ],
     "brands": [
      "Ubrelvy"
     ],
     "cls": "CGRP receptor antagonist (gepant)"
    },
    {
     "key": "erenumab",
     "generics": [
      "erenumab"
     ],
     "brands": [
      "Aimovig"
     ],
     "cls": "CGRP monoclonal antibody"
    }
   ]
  };
  if (typeof window !== "undefined") window.TBP_RX_VOCAB = VOCAB;
  if (typeof module !== "undefined" && module.exports) module.exports = VOCAB;
})();
