/* ═══════════════════════════════════════════════════════════════════════════
   clinical-sim-scripts.js — scripted clinician transcripts for the adversarial
   harness.

   Three arms per scenario, eight turns each:

     bad      MI non adherent throughout. Warning, persuading without
              permission, confronting, runs of closed questions, the righting
              reflex. The patient SHOULD get worse.
     good     Complex reflection, affirmation, explicit autonomy support,
              asking permission before informing, evocation. The patient
              SHOULD get better, slowly.
     neutral  The control that matters. On topic, polite, reflection SHAPED,
              and empty. Formulaic simple reflections, no autonomy, no
              permission, no real curiosity. This arm separates "the model
              rewards anything that looks like MI" from "the model tracks
              whether it was earned." If neutral scores like good, the
              simulator is a mirror and not a teacher.

   The lines are deliberately written in a real prescriber's voice, not as
   textbook exemplars, because the coach has to code prose that sounds like a
   person and not like a manual.
   ═══════════════════════════════════════════════════════════════════════════ */

var SIMSCRIPTS = {

'mi-weight': {
  bad: [
    "I hear you, but I need you to understand something first. You were hospitalized twice in two years before this medication. If you stop it, you are very likely to end up back in the hospital.",
    "Have you been taking it every day? Yes or no?",
    "Do you remember what happened in 2024? Do you remember how sick you actually were?",
    "Twenty eight pounds is not worth a manic episode. That is just the reality here. Most people would make that trade without thinking about it.",
    "I understand your fiancee said something, but she is going to be a lot more upset if you end up back on a psychiatric unit. You need to think about that.",
    "So what you are telling me is that you would rather be thin and psychotic than heavier and stable?",
    "I am going to be honest with you. If you stop this on your own I cannot be responsible for what happens next. I need you to commit to staying on it until we meet again.",
    "Alright. I am going to document that you were advised to continue and that you declined. Can you at least agree to call me if you start feeling off?"
  ],
  good: [
    "You came anyway, even though you had already decided and you knew roughly how this conversation was going to go. That took something.",
    "So it is not that the medication is not working. It is that it is working and it is costing you something real at the same time, and so far nobody has treated that second part as a legitimate problem.",
    "Whatever happens in the next fifteen minutes, stopping it is your call to make and I am not going to try to take that away from you. What I would like is to understand the whole thing before you do.",
    "Twenty eight pounds. What is the part of that that actually gets to you? Not the number, the part underneath it.",
    "You said your fiancee thinks you are not the same. That one landed differently than the scale did.",
    "You are carrying two things you cannot put down at the same time. You do not want to go back to the hospital, and you cannot keep living in a body you do not recognize. Most people would just pick one and pretend the other one was not there.",
    "Would it be alright if I told you what I know about the options here? You can throw all of it out. I just do not want you making this decision with half the information.",
    "So where does that leave you, in your own words? Not what you think I want to hear."
  ],
  neutral: [
    "It sounds like you have made up your mind.",
    "You are feeling frustrated about the weight gain.",
    "So you are saying you do not want to take the aripiprazole anymore.",
    "That sounds hard.",
    "You mentioned your fiancee. Tell me more about that.",
    "It sounds like this has been really difficult for you.",
    "So you are concerned about the weight and you want to come off the medication.",
    "What do you want to do?"
  ]
},

'mi-alcohol': {
  bad: [
    "Before we talk about the dose, I have to tell you that alcohol is a depressant and it is almost certainly why you are waking up at three in the morning.",
    "How much are you actually drinking? Be honest with me.",
    "Your liver enzymes are up. That does not happen from one glass of wine, so let us try that question again.",
    "I am not going to increase the sertraline while you are drinking every night. It would not be safe and it would not work anyway.",
    "Do you ever drink alone? Do you drink more than you planned to? Have you ever tried to cut back and not managed it?",
    "You need to stop drinking for a month and then we will see where your mood actually is.",
    "I think you are minimizing this. A lot of people in your situation do the same thing.",
    "So can I count on you to leave it alone until our next visit?"
  ],
  good: [
    "Before we get to the dose, can I ask about the three in the morning thing? That is the same detail you brought me last time, and it has not shifted at all.",
    "Every single night, and then you are wrecked all day. So the sertraline is doing something for your mood and nothing at all for the part that is actually wrecking you.",
    "You run a school district. You are the person everybody else brings the broken thing to. And this one thing you cannot get on top of, and it has been seven months.",
    "Can I ask you something that might sound off topic? In an ordinary week, walk me through an evening. What does it actually look like between dinner and bed?",
    "Two, sometimes three. What size glass are we talking about, roughly? I am asking because I genuinely do not know what you are picturing.",
    "You did that arithmetic out loud and something crossed your face.",
    "Would it be okay if I showed you a lab from last month and told you what I make of it? You are allowed to tell me I am reading too much into it.",
    "Given all of that, what do you make of it? I want your read on it, not mine."
  ],
  neutral: [
    "You would like to increase the sertraline.",
    "It sounds like sleep is the main issue.",
    "Tell me more about the waking up.",
    "That sounds frustrating.",
    "So you are still depressed even on the medication.",
    "Do you drink alcohol?",
    "It sounds like you have a lot going on.",
    "What would you like to do about it?"
  ]
},

'mi-cannabis': {
  bad: [
    "Your mother is worried about you. Do you think she has a point?",
    "How much are you smoking? Is it every day?",
    "I need to tell you that daily cannabis at your age affects the developing brain, and there is good evidence that it makes anxiety worse over time, not better.",
    "Do you think you might be using it to avoid things?",
    "Are you smoking before class? Is that why you dropped two of them?",
    "If you want the anxiety to get better you are going to have to stop the cannabis. That is just how this works.",
    "I would like to start you on a medication and have you stop smoking, and I think you would be surprised how much better you feel in a month.",
    "Can you commit to cutting down before I see you next?"
  ],
  good: [
    "Your mother booked this, and then you confirmed it yourself. Those are two different things and only one of them was up to you.",
    "I am not going to tell you to quit anything. That is not what this is. I would rather know what it is actually like to be you right now.",
    "The noise in your chest. Say more about that, because that is a very specific way to put it.",
    "So it is the one thing that has ever reliably made that stop. That is not nothing. That is the best evidence you have got about your own head.",
    "Somebody already did the brain lecture at you, did they not.",
    "You tried. Twice. And you did not tell anybody you tried, which means it never counted as trying to anyone except you.",
    "We have got about four minutes and I am not going to try to solve anything in four minutes. Is there one thing you would want a person sitting in this chair to actually know?",
    "Whatever you do about the smoking is yours to decide. Would you be willing to come back once, so that this is not the only conversation we ever have?"
  ],
  neutral: [
    "So your mom set this up.",
    "It sounds like you do not really want to be here.",
    "Tell me about your anxiety.",
    "That sounds difficult.",
    "You mentioned panic attacks. Tell me more about those.",
    "So you smoke cannabis every day.",
    "It sounds like the cannabis helps you.",
    "What do you think you want to do?"
  ]
}

};
