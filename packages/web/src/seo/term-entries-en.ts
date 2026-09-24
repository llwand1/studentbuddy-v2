import type { EnglishTerm } from './term-corpus-en';

/**
 * 英文词条语料（批次 H-1＝渠道 C1 英文侧，首版六条）。
 *
 * ★ 三条口径与中文侧同源，且在 `term-en.test.ts` 里各有锁：不写使用量数字、不许诺学习效果、
 *   不引用真实用户。★ 此外英文侧多一条：**不搬中文侧没有的“事实”**——这六条里的提出者、
 *   年份与实验描述都要经得起点进来看，宁可少写一句也不补一段看着像文献的话。
 * ★ `zhSlug` 是双向 hreflang 的唯一出处，一条英文挂一条中文；中文侧那 6 页凭它反查。
 */
export const ENTRIES_EN: readonly EnglishTerm[] = [
  {
    slug: 'spaced-repetition',
    title: 'Spaced repetition',
    alias: 'the spacing effect · distributed practice',
    searchPhrase: ': what it is and how to space your reviews',
    oneLine:
      'Spaced repetition spreads the same material over widening gaps, so each review lands before it is gone.',
    sections: [
      {
        h: 'What it is',
        p: [
          'Studying something three times in one evening and studying it three times across three weeks leave very different amounts behind. Spaced repetition is the second one, done on purpose.',
          'The idea was never the hard part; the scheduling is. A learner has dozens or hundreds of items, each sitting at its own point on its own forgetting curve, and nobody can track that many clocks by hand.',
        ],
      },
      {
        h: 'Why the gaps help',
        p: [
          'Retrieving something that has begun to fade takes more effort, and that effort is the active ingredient: a recall that nearly failed strengthens the memory more than one that came easily.',
          'Spacing also moves each review into a new context — another day, another room, other subjects in between — so the memory gets attached to more cues and stops depending on the desk you first met it at.',
        ],
      },
      {
        h: 'How long to wait',
        p: [
          'There is no universal number. A workable start: the same evening, then day three, then a week, then a fortnight. When a recall clearly fails, pull the next gap back shorter rather than pushing harder.',
          'The more common failure is the opposite one: gaps so short that you still remember the answer perfectly, which is not spacing at all. Judge it by the strain you feel at review time, not by days ticked off.',
        ],
      },
    ],
    pitfalls: [
      'Turning it into "look at every card every day". That is re-reading, and re-reading feels productive precisely because it asks so little.',
      'Adding new items endlessly while nothing old ever disappears, until the pile is too frightening to open.',
      'Reading a broken streak as a verdict. Falling behind for three days is the normal shape of this; shorten the gaps and resume instead of abandoning the set.',
    ],
    actions: [
      'Write the date of your last successful recall on each card and let anything older than three days come to the front.',
      'Put the items you keep missing into a separate small pile and meet them tomorrow, apart from the main queue.',
      'Cap the daily workload before you grow the deck. A queue you finish beats a bigger one you avoid.',
    ],
    related: ['retrieval-practice', 'forgetting-curve', 'interleaving'],
    productHint:
      'StudentBuddy keeps the schedule instead of you: each saved term gets its next review from your own recall record, so today’s queue is only the small part that is due.',
    zhSlug: 'jian-ge-chongfu',
  },
  {
    slug: 'retrieval-practice',
    title: 'Retrieval practice',
    alias: 'the testing effect · active recall',
    searchPhrase: ': what it is and why re-reading is not it',
    oneLine:
      'Retrieval practice means pulling an answer out of memory before checking it, rather than reading it again.',
    sections: [
      {
        h: 'What it is',
        p: [
          'Following a worked example and producing the answer unaided are two different achievements. Retrieval practice trains the second: close the book, answer, then open it and check.',
          'The difference from re-reading and highlighting is the direction of the effort. Re-reading pushes information in; retrieval pulls it out. Pulling changes the memory more, which is why it lasts longer.',
        ],
      },
      {
        h: 'Why it works',
        p: [
          'Each successful recall reactivates the path to that memory and ties it to whatever else was present at the time, so the next retrieval has more than one way in.',
          'Missing is not wasted. Struggling first and then seeing the answer beats reading the answer directly, because the miss marks the exact place where your version was wrong.',
        ],
      },
      {
        h: 'When to do it',
        p: [
          'Once the same day, before anything is fully memorised, and again a few days later. Starting self-tests in the week of the exam means starting when the effect is worth least.',
          'The format is casual and matters less than the order: questions on a blank sheet, telling it to someone, redrawing a diagram from memory. Answer first, check after.',
        ],
      },
    ],
    pitfalls: [
      'Mistaking "this looks familiar" for "I have it". The fluency you feel while re-reading belongs to the material, not to your ability to produce it.',
      'Recalling with the answer key open beside you. What you practise then is copying, and the exam does not come with the key.',
      'Only self-testing once you are sure you know it. The gains are largest exactly while you are not sure.',
    ],
    actions: [
      'After one section, close the book, write three points from memory, then compare. Whatever you missed is what to watch.',
      'After a question you got right, write the reasoning anyway. A right answer you cannot derive is a coin flip.',
      'Explain it out loud to someone and mark where you stall. That stall is a retrieval failure seen from the inside.',
    ],
    related: ['spaced-repetition', 'feynman-technique', 'interleaving'],
    productHint:
      'The quiz and duel rounds in StudentBuddy are retrieval by construction: questions are generated from your own terms, and the answer is only revealed after you submit.',
    zhSlug: 'tiqu-lixian',
  },
  {
    slug: 'forgetting-curve',
    title: 'The forgetting curve',
    alias: 'Ebbinghaus’s curve · retention over time',
    searchPhrase: ': what the curve actually shows',
    oneLine:
      'The forgetting curve is what survives of a memory as time passes without review — steepest in the first day.',
    sections: [
      {
        h: 'What it shows',
        p: [
          'Learn a list, then measure what survives an hour later, a day later, a week later, and you get a steep early fall that flattens out. That shape is the curve.',
          'The flattening matters as much as the fall. Most of the loss happens in the first day or two, so a first review inside that window does a different job from one a week later.',
        ],
      },
      {
        h: 'What the famous percentages are not',
        p: [
          'It is not a table of fixed rates. Hermann Ebbinghaus measured himself, on material invented to carry no prior meaning, in the 1880s. Anything quoted as "you forget 90% within a day" is somebody’s rounding of that.',
          'Meaningful material holds better. Something that connects to what you already know, or that carries an image or a story, decays far more slowly than nonsense syllables. The curve describes a tendency, not your exam.',
        ],
      },
      {
        h: 'How to use it',
        p: [
          'Read it as instruction about timing: review when the memory has weakened but not gone. A review that arrives after everything is lost is re-learning, and it costs what re-learning costs.',
          'Each recall that succeeds flattens the curve for that item, so the gaps can lengthen. That is the same phenomenon spaced repetition organises — one is the description, the other is the schedule.',
        ],
      },
    ],
    pitfalls: [
      'Using the curve as an excuse. The fall is steepest when reviews are absent, and that is the one variable you control.',
      'Scheduling by the calendar instead of by the item. Every card in a deck sits on its own curve.',
      'Treating a precise-looking percentage from a blog post as a fact about your own memory.',
    ],
    actions: [
      'Pick something you studied days ago and write down what is left, without notes. One point on your own curve beats the quoted ones.',
      'Put a first review inside a day of learning something new, before the steep part finishes.',
      'Lengthen a gap when review feels easy and shorten it when it fails. The strain is the readout.',
    ],
    related: ['spaced-repetition', 'retrieval-practice', 'interleaving'],
    productHint:
      'StudentBuddy applies the curve per term: the intervals come from when you actually recalled a given item, not from a schedule you set once and never revisited.',
    zhSlug: 'yiwang-quxian',
  },
  {
    slug: 'interleaving',
    title: 'Interleaving',
    alias: 'interleaved practice, against blocked practice',
    searchPhrase: ': why mixed practice feels worse than it is',
    oneLine:
      'Interleaving mixes problem types within one session instead of drilling one type at a time.',
    sections: [
      {
        h: 'What it is',
        p: [
          'Practising one type of problem until it is smooth and then moving to the next is blocking. Shuffling the types so that the next question is unpredictable is interleaving.',
          'The difference is not which problem you solve. Interleaving adds a step that blocking lets you skip: working out what kind of problem this is before solving it.',
        ],
      },
      {
        h: 'Why it feels worse',
        p: [
          'Blocked practice produces fast, visible improvement during the session — which is the easiest moment to measure and the least meaningful one. Interleaved practice feels jerkier and often scores lower while you are doing it.',
          'The difference shows up later, on material you did not just practise, where the hard part is choosing a procedure rather than executing one.',
        ],
      },
      {
        h: 'How to use it',
        p: [
          'Once you recognise each type at all, stop running them in blocks and mix the ones you confuse with each other. Shuffled decks and mixed problem sets both count.',
          'Keep the mixed set small enough to finish. Interleaving over a pile you never get through is procrastination with a theory attached.',
        ],
      },
    ],
    pitfalls: [
      'Interleaving brand-new material. Mixing two types you cannot yet tell apart teaches you which one you do not understand — useful, but not yet the training.',
      'Judging a session by how smooth it felt. Smoothness inside a blocked session is mostly familiarity.',
      'Applying it to everything. A skill that must be fluent under time pressure still needs timed repetition.',
    ],
    actions: [
      'Do next week’s mixed homework in shuffled order, without looking up which chapter each question came from.',
      'Before solving, say out loud which type the problem is and why. Naming is the step blocking never asks for.',
      'Alternate two topics you confuse, ten minutes each, for a week, then retest yourself on the distinction.',
    ],
    related: ['retrieval-practice', 'cognitive-load', 'spaced-repetition'],
    productHint:
      'Quizzes in StudentBuddy draw from your whole term library rather than the last few cards you added, so practice order is mixed without you building a shuffled deck.',
    zhSlug: 'jiao-cuo-lixian',
  },
  {
    slug: 'cognitive-load',
    title: 'Cognitive load',
    alias: 'working-memory limits in learning',
    searchPhrase: ': why some material will not go in',
    oneLine:
      'Cognitive load is how much your working memory holds at once — it fills up, and then nothing gets in.',
    sections: [
      {
        h: 'What it is',
        p: [
          'Working memory holds only a few elements at once. A lesson that asks you to hold more than that — new steps, new vocabulary, a diagram and a spoken explanation simultaneously — overflows rather than being difficult.',
          'The split worth remembering: the load inherent in the material, the load the presentation adds for no reason, and the load that actually builds understanding. Only the third is worth spending.',
        ],
      },
      {
        h: 'What makes lessons harder than they need to be',
        p: [
          'Split attention: the explanation here and the thing it refers to over there, so you must hold one while hunting for the other. Putting the caption inside the diagram removes a load that feels invisible until you measure it.',
          'Redundancy: text you both read and hear, a worked example restating a step already shown, decoration carrying no information. Each costs a little working memory and none gives anything back.',
        ],
      },
      {
        h: 'How to use it',
        p: [
          'When a page will not land, check the load before checking your effort: how many separate things must be held at once, and which of them the material put there for no reason.',
          'Study worked examples closely while you are new to a procedure, then gradually remove them. Keeping scaffolding after you have it wastes the session; dropping it before you have it overflows the session.',
        ],
      },
    ],
    pitfalls: [
      'Reading a hard session as a limit in yourself. Frequently it is the shape of the material, and reformatting it is cheaper than grinding.',
      'Treating multitasking as extra capacity. Splitting attention between a lecture and a phone does not use two channels; it halves one.',
      'Cutting everything that feels like filler — including the retrieval effort that was doing the work.',
    ],
    actions: [
      'Reopen notes you could not follow and count what you had to hold at once. Rewrite the two things that could sit side by side on the page.',
      'When learning a new procedure, keep the worked example and the problem on the same view, not on facing pages.',
      'If nothing is landing, take the smallest sub-part of it and finish only that.',
    ],
    related: ['interleaving', 'spaced-repetition', 'retrieval-practice'],
    productHint:
      'Explanations in StudentBuddy are written per term rather than per chapter, so a card you cannot follow can be re-explained at the size of one idea.',
    zhSlug: 'renzhi-fuhe',
  },
  {
    slug: 'feynman-technique',
    title: 'The Feynman technique',
    alias: 'explaining it in plain language',
    searchPhrase: ': the steps, and where people do it wrong',
    oneLine:
      'The Feynman technique is explaining a concept in plain language, then studying the places you stall.',
    sections: [
      {
        h: 'What it is',
        p: [
          'Pick a concept, write the explanation without jargon, read it back. It is a diagnostic dressed up as a study method: the sentence you cannot finish shows where the understanding is not there.',
          'The name is a nickname applied after the fact. No four-step protocol of this kind comes out of Richard Feynman’s own work, which is worth knowing before anyone sells it as a genius’s private routine.',
        ],
      },
      {
        h: 'Why stalling is the point',
        p: [
          'Technical vocabulary can carry an explanation a long way without any mechanism being understood — a term standing in for the thing it names is easy to mistake for knowing it. Plain language takes that cover away.',
          'Where you stall, you have a specific hole and a specific thing to go back to the source for. It is retrieval practice with an answer check attached, in a format that does not need a classmate.',
        ],
      },
      {
        h: 'How to run it',
        p: [
          'Write the explanation, find the stalls, return to the source for those passages only, rewrite them. The loop is the method; the first draft is not the deliverable.',
          'Saying it to an actual person is the stronger version of the same loop: you get interrupted exactly where the explanation was hand-wavy.',
        ],
      },
    ],
    pitfalls: [
      'Writing the summary you already had instead of producing an explanation from memory. That is copying with extra steps, and it stalls nowhere.',
      'Stopping after a smooth draft. A smooth first draft usually means you wrote about something you already knew.',
      'Treating jargon as precision. If the technical term is what you would have to look up in order to explain it, it has explained nothing yet.',
    ],
    actions: [
      'Take the concept you studied most this week and write it for a bright twelve-year-old. Underline every sentence you had to abandon.',
      'For each underlined sentence, go back to the source and rewrite that passage without the term you hid behind.',
      'Say the whole thing out loud to someone and let them interrupt. Note the questions you cannot answer.',
    ],
    related: ['retrieval-practice', 'cognitive-load', 'forgetting-curve'],
    productHint:
      'StudentBuddy can re-explain a term at a level you choose and then ask you about it, which turns the same loop into a session you can repeat without a partner.',
    zhSlug: 'fei-man-xuexi-fa',
  },
];
