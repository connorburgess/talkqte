// Reviews a recorded take after it is made: does it show the product as it
// is, were the cues any good, and what does it suggest improving? It reads
// the take's manifest and the simulation results it was recorded from, and
// writes a short report beside the take. It asks no model and sends
// nothing; every statement comes from numbers in those two files.
//
//   node scripts/cue-sim-review.mjs --take <take .json> --results <cue-sim results .json>
//
// The recorder also writes a review for every take it saves.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { outputDirectory, parseFlags } from './cue-lab-output.mjs';
import { isMain } from './is-main.mjs';

const BUDGET_MS = 5_000; // Line said to cue on screen, docs/budgets.md.
const GLANCE_WORDS = 10;
// A rough allowance for noticing a card and reading it: about a second,
// plus a quarter of a second a word. Not a measurement of any reader.
const readingMs = (words) => 1_000 + 250 * words;
const words = (text) => text.trim().split(/\s+/).length;
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];

/** Everything the review can say about one take, as data. */
export function reviewTake(manifest, results, replay) {
  const timeline = replay.timeline;
  const line = new Map(replay.lines.map((item) => [item.id, item]));
  const decisions = timeline.filter((e) => e.type === 'decision');
  const shown = timeline.filter(
    (e) => e.type === 'cue-shown' && e.origin === 'evaluator',
  );
  const cleared = new Map(
    timeline.filter((e) => e.type === 'cue-cleared').map((e) => [e.cueId, e]),
  );
  const moments = replay.metrics.opportunities.detail;
  const end = Math.max(...timeline.map((e) => e.atMs));

  // --- Does the take show the product as it is? ---------------------------
  const represents = [];
  const check = (name, ok, detail) => represents.push({ name, ok, detail });
  check(
    'Says what it is',
    manifest.simulated === true && manifest.fictional === true,
    `Labelled simulated and fictional; cue decisions: ${manifest.decisions}.`,
  );
  check(
    'Shows a known version of the app',
    Boolean(manifest.app?.commit) && !manifest.app.uncommittedChanges,
    manifest.app?.commit
      ? `Checkout ${manifest.app.commit.slice(0, 7)}${manifest.app.includes?.length ? `, including ${manifest.app.includes.join(', ')}` : ''}${manifest.app.uncommittedChanges ? ', with uncommitted changes, so the commit alone does not describe it' : ''}.`
      : 'The take does not say which version of the app it shows.',
  );
  if (manifest.companionStatus !== undefined)
    check(
      'Does not claim a microphone or a live session',
      !/mic on|\blive\b/i.test(manifest.companionStatus ?? ''),
      `The companion's own status read "${manifest.companionStatus}".`,
    );
  check(
    'The whole conversation was played',
    !results.stopped,
    results.stopped
      ? `The run stopped after ${results.stopped.afterCalls} requests (${results.stopped.category ?? 'kind not recorded'}); only ${replay.lines.length} lines were heard.`
      : `${replay.lines.length} lines, ${decisions.length} decisions.`,
  );
  const drawnLate = manifest.cues.filter(
    (cue) => cue.seenAtMs - cue.expectedAtMs > 500,
  );
  check(
    'Cues were drawn when the results say',
    drawnLate.length === 0,
    manifest.cues.length
      ? `Largest gap between the results and the screen: ${Math.max(...manifest.cues.map((cue) => cue.seenAtMs - cue.expectedAtMs))} ms.`
      : 'No cue was shown.',
  );
  const unfit = manifest.cues.filter((cue) => cue.fits === false);
  if (manifest.cues.some((cue) => cue.fits !== undefined))
    check(
      'The card fits its window',
      unfit.length === 0,
      unfit.length
        ? `${unfit.length} of ${manifest.cues.length} cues did not fit the companion window without scrolling.`
        : 'Every cue fitted the companion window.',
    );
  // Can the words be read at a glance? WCAG asks for 4.5:1 between text and
  // what is behind it, or 3:1 for large text (24 px, or about 19 px bold).
  const measured = manifest.cues.filter((cue) => cue.legibility);
  if (measured.length) {
    const needs = ({ fontPx, bold }) =>
      fontPx >= 24 || (bold && fontPx >= 18.66) ? 3 : 4.5;
    const weak = measured.filter(
      (cue) =>
        cue.legibility.settled.weakestContrast < needs(cue.legibility.settled),
    );
    const settled = measured.map((cue) => cue.legibility.settled);
    const appearing = measured.map((cue) => cue.legibility.atAppearance);
    check(
      "The cue's words stand out from the card",
      weak.length === 0,
      `Cue text is ${Math.min(...settled.map((s) => s.fontPx))} px. Its weakest word stands at ${Math.min(...appearing.map((s) => s.weakestContrast))}:1 against the card as it appears and ${Math.min(...settled.map((s) => s.weakestContrast))}:1 a second later; the accessibility guideline asks for ${needs(settled[0])}:1 at that size.`,
    );
  }
  if (manifest.audio)
    check(
      'Sound is intact',
      manifest.audio.check ? manifest.audio.check.passed : false,
      manifest.audio.check
        ? `Measured against its clips: ${manifest.audio.check.dropouts} dropouts, ${manifest.audio.check.clipsCutShort} clips cut short, ${manifest.audio.check.overlaps} overlaps; ${manifest.audio.endLate.length} lines end later than the simulation's line end${manifest.audio.endLate.length ? ` (by up to ${Math.max(...manifest.audio.endLate.map((l) => l.endsLateMs))} ms)` : ''}.`
        : 'The sound was not measured for this take.',
    );

  // --- Were the cues any good? --------------------------------------------
  const cues = shown.map((event) => {
    const gone = cleared.get(event.cueId);
    const moment = moments.find((m) => m.cueId === event.cueId);
    const count = words(event.text);
    const onScreenMs = (gone?.atMs ?? end) - event.atMs;
    return {
      text: event.text,
      words: count,
      glance: count <= GLANCE_WORDS,
      shownAtMs: event.atMs,
      onScreenMs,
      clearedBy: gone?.why ?? 'still on screen at the end',
      readable: onScreenMs >= readingMs(count),
      moment: moment
        ? {
            lineId: moment.lineId,
            about: moment.about,
            outcome: moment.outcome,
            afterSaidMs: moment.afterSaidMs,
            withinBudget: moment.afterSaidMs <= BUDGET_MS,
          }
        : null,
    };
  });
  const missed = moments
    .filter((m) => m.outcome === 'missed')
    .map((m) => ({ lineId: m.lineId, about: m.about }));
  const dropped = decisions.filter((d) => d.outcome === 'superseded');
  const timed = decisions.filter((d) => d.latency !== 'none');

  // --- What it suggests improving, each with its evidence -----------------
  const observations = [];
  const observe = (area, text) => observations.push({ area, text });
  const delay = results.settings.transcriptDelayMs;
  if (timed.length) {
    const typical = median(timed.map((d) => d.latencyMs));
    if (delay + typical > BUDGET_MS)
      observe(
        'Timing',
        `A line reaches the evaluator ${seconds(delay)} after it is said and a decision then takes a median ${seconds(typical)}, so a cue cannot be on screen inside the ${seconds(BUDGET_MS)} budget (${seconds(delay + typical)} at best). The budget is only reachable by shortening one of the two.`,
      );
  }
  for (const decision of dropped.filter((d) => d.action === 'show')) {
    const at = replay.lines.findIndex((item) => item.id === decision.lineId);
    const after = replay.lines
      .slice(at + 1)
      .filter(
        (item) =>
          item.arrivesAtMs > decision.startedAtMs &&
          item.arrivesAtMs <= decision.atMs,
      );
    const small = after.filter((item) => words(item.text) <= 3);
    observe(
      'Timing',
      small.length === after.length && after.length
        ? `The evaluator chose a cue for line ${decision.lineId.slice(1)}, but it was thrown away because ${after.length === 1 ? 'a short acknowledgement' : `${after.length} short acknowledgements`} (${after.map((item) => `"${item.text}"`).join(', ')}) arrived first. A word or two of agreement changes nothing about the conversation; it should probably not cancel a decision in flight.`
        : `The evaluator chose a cue for line ${decision.lineId.slice(1)}, but it was thrown away because newer speech arrived ${seconds(decision.latencyMs)} into the decision.`,
    );
  }
  for (const cue of cues) {
    if (cue.moment?.outcome === 'late')
      observe(
        'Timing',
        `"${cue.text}" came on screen ${seconds(cue.moment.afterSaidMs)} after its line was said, after the moment it was for had passed.`,
      );
    if (!cue.glance)
      observe(
        'Card',
        `"${cue.text}" is ${cue.words} words. A card read at a glance needs about ${GLANCE_WORDS} or fewer.`,
      );
    if (!cue.readable)
      observe(
        'Card',
        `"${cue.text}" was on screen for ${seconds(cue.onScreenMs)} and then ${cue.clearedBy === 'expired' ? 'expired' : `was cleared (${cue.clearedBy})`}; noticing and reading ${cue.words} words needs roughly ${seconds(readingMs(cue.words))}.`,
      );
  }
  const faint = manifest.cues.filter(
    (cue) => cue.legibility && cue.legibility.atAppearance.weakestContrast < 3,
  );
  if (faint.length)
    observe(
      'Card',
      `As ${faint.length === 1 ? 'a cue appears' : `${faint.length} cues appear`}, the faintest word is at ${Math.min(...faint.map((cue) => cue.legibility.atAppearance.weakestContrast))}:1 against the card, below the 3:1 that even large text needs. A glance in the first moment may not be able to read it; the words are at full strength about a second later.`,
    );
  const repeats = decisions.filter((d, i) => {
    if (d.action !== 'show' || d.outcome === 'applied') return false;
    const earlier = decisions
      .slice(0, i)
      .some(
        (e) =>
          ['withdraw', 'resolved'].includes(e.action) &&
          e.outcome === 'applied',
      );
    return earlier && d.outcome === 'too-late';
  });
  if (repeats.length)
    observe(
      'Evaluator',
      `After a cue was cleared, the evaluator proposed a cue again from the same earlier lines (${repeats.length} time${repeats.length === 1 ? '' : 's'}; refused only because those lines were too old). It is not told which cues it has already shown and cleared, so nothing stops it bringing one back.`,
    );
  const named = missed.filter((m) => /\basked\b/i.test(m.about ?? ''));
  if (named.length && results.settings.input === 'app')
    observe(
      'Evaluator',
      `${named.length} question${named.length === 1 ? '' : 's'} put to the listener by name got no cue. With one "Speaker" label and no name, the evaluator cannot tell who is being asked.`,
    );
  if (replay.metrics.unexpectedShows)
    observe(
      'Evaluator',
      `${replay.metrics.unexpectedShows} cue${replay.metrics.unexpectedShows === 1 ? '' : 's'} appeared where the labels expected none.`,
    );
  if (replay.metrics.flips)
    observe(
      'Evaluator',
      `${replay.metrics.flips} cue${replay.metrics.flips === 1 ? ' was' : 's were'} shown and then taken back with no labelled reason.`,
    );
  for (const item of represents.filter((r) => !r.ok))
    observe('Recording', `${item.name}: ${item.detail}`);

  // --- Is the take worth drawing conclusions from? ------------------------
  const thin = [];
  if (results.stopped) thin.push('the run stopped early');
  if (cues.length < 2)
    thin.push(
      `only ${cues.length} cue was shown`.replace(
        'only 0 cue was',
        'no cue was',
      ),
    );
  if (results.evaluator.kind !== 'model')
    thin.push('the decisions did not come from a model');
  if (cues.length && cues.every((cue) => !cue.readable || !cue.glance))
    thin.push('no cue was both short enough and on screen long enough to read');
  return {
    conversation: manifest.conversation,
    video: manifest.video,
    decisions: manifest.decisions,
    represents,
    cues,
    missed,
    counts: {
      lines: replay.lines.length,
      decisions: decisions.length,
      dropped: dropped.length,
      labelledMoments: moments.length,
      inTime: moments.filter((m) => m.outcome === 'in-time').length,
      late: moments.filter((m) => m.outcome === 'late').length,
      missed: missed.length,
      quietKept: replay.metrics.quiet.kept,
      quietEvaluated: replay.metrics.quiet.evaluated,
    },
    observations,
    evidence: {
      useful: thin.length === 0,
      why: thin.length
        ? `Not much to learn from: ${thin.join('; ')}.`
        : 'A complete run with several readable cues.',
    },
    limits:
      'Counts against the lab lane\'s own labels on an invented conversation. "Readable" uses a rough allowance, not a measurement of anyone reading. Nothing here says a cue helped a person.',
  };
}

/** The review as a short page a person can read beside the video. */
export function reviewMarkdown(review) {
  const out = [
    `# Review of ${review.video}`,
    '',
    `Conversation: ${review.conversation}. Cue decisions: ${review.decisions}.`,
    '',
    `**Worth drawing conclusions from?** ${review.evidence.useful ? 'Yes.' : 'No.'} ${review.evidence.why}`,
    '',
    '## Does it show the product as it is?',
    '',
    ...review.represents.map(
      (item) =>
        `- ${item.ok ? 'Yes' : '**No**'} · ${item.name}. ${item.detail}`,
    ),
    '',
    '## The cues',
    '',
    `${review.counts.labelledMoments} labelled moments: ${review.counts.inTime} cued in time, ${review.counts.late} late, ${review.counts.missed} missed. ${review.counts.decisions} decisions, ${review.counts.dropped} dropped because newer speech arrived. Quiet kept on ${review.counts.quietKept} of ${review.counts.quietEvaluated} quiet lines asked about.`,
    '',
  ];
  if (!review.cues.length) out.push('No cue was shown.', '');
  for (const cue of review.cues)
    out.push(
      `- "${cue.text}" (${cue.words} words${cue.glance ? '' : ', too long for a glance'}). ${cue.moment ? `For line ${cue.moment.lineId.slice(1)}: ${cue.moment.outcome === 'in-time' ? 'in time' : 'late'}, ${seconds(cue.moment.afterSaidMs)} after the line was said (${cue.moment.withinBudget ? 'inside' : 'over'} the ${seconds(BUDGET_MS)} budget).` : 'Not for any labelled moment.'} On screen ${seconds(cue.onScreenMs)}, then ${cue.clearedBy}${cue.readable ? '' : '; probably not long enough to read'}.`,
    );
  if (review.missed.length)
    out.push(
      '',
      'Missed:',
      ...review.missed.map(
        (m) => `- Line ${m.lineId.slice(1)}: ${m.about ?? 'a labelled moment'}`,
      ),
    );
  out.push('', '## What it suggests improving', '');
  if (!review.observations.length)
    out.push('Nothing stood out in the numbers.');
  for (const area of [...new Set(review.observations.map((o) => o.area))]) {
    out.push(`**${area}**`, '');
    for (const item of review.observations.filter((o) => o.area === area))
      out.push(`- ${item.text}`);
    out.push('');
  }
  out.push('## Limits', '', review.limits, '');
  return out.join('\n');
}

/** One run's numbers for one conversation, for setting runs side by side. */
function runRow(results, replay) {
  const timeline = replay.timeline;
  const decisions = timeline.filter((e) => e.type === 'decision');
  const shown = timeline.filter(
    (e) => e.type === 'cue-shown' && e.origin === 'evaluator',
  );
  const moments = replay.metrics.opportunities.detail;
  const timed = decisions.filter((d) => d.latency !== 'none');
  // A cue brought back: the same words shown twice, a second cue for one
  // moment, or one proposed again after a cue had been cleared.
  const cleared = (i) =>
    decisions
      .slice(0, i)
      .some(
        (d) =>
          ['withdraw', 'resolved'].includes(d.action) &&
          d.outcome === 'applied',
      );
  const reproposed = decisions.filter(
    (d, i) => d.action === 'show' && d.outcome === 'too-late' && cleared(i),
  ).length;
  return {
    evaluator: results.evaluator.label,
    model: results.evaluator.model ?? null,
    stopped: Boolean(results.stopped),
    decisions: decisions.length,
    medianDecisionMs: timed.length
      ? median(timed.map((d) => d.latencyMs))
      : null,
    labelledMoments: moments.length,
    // Matches the label: a cue for a labelled moment, in time or late.
    cued: moments.filter((m) => m.outcome !== 'missed').length,
    inTime: moments.filter((m) => m.outcome === 'in-time').length,
    withinBudget: moments.filter(
      (m) => m.afterSaidMs !== null && m.afterSaidMs <= BUDGET_MS,
    ).length,
    cuesShown: shown.length,
    glance: shown.filter((e) => words(e.text) <= GLANCE_WORDS).length,
    longestCueWords: Math.max(0, ...shown.map((e) => words(e.text))),
    unexpected: replay.metrics.unexpectedShows,
    repeats: replay.metrics.duplicates + reproposed,
    takenBack: replay.metrics.flips,
    quietKept: replay.metrics.quiet.kept,
    quietAsked: replay.metrics.quiet.evaluated,
  };
}

/** Sets two or more runs of the same conversations side by side: for each
 * conversation, each run's cues against the labels, the budget, the glance
 * length, and repeats. It reads only results files; no model is asked. */
export function compareRuns(runs) {
  const ids = runs[0].conversations.map((c) => c.id);
  const conversations = ids
    .filter((id) => runs.every((r) => r.conversations.some((c) => c.id === id)))
    .map((id) => ({
      id,
      runs: runs.map((results) =>
        runRow(
          results,
          results.conversations.find((c) => c.id === id),
        ),
      ),
    }));
  return {
    conversations,
    // Conversations one run reached and another did not are left out.
    leftOut: [
      ...new Set(runs.flatMap((r) => r.conversations.map((c) => c.id))),
    ].filter((id) => !conversations.some((c) => c.id === id)),
    limits:
      'Counts against the lab lane\'s own labels on invented conversations. One run of each model: a difference here may not repeat. "Matches the label" means a cue was shown for a moment the labels marked, not that it helped anyone.',
  };
}

export function comparisonMarkdown(comparison) {
  const out = ['# Comparison of runs', ''];
  for (const conversation of comparison.conversations) {
    out.push(
      `## ${conversation.id}`,
      '',
      '| | ' + conversation.runs.map((r) => r.evaluator).join(' | ') + ' |',
      '| --- |' + conversation.runs.map(() => ' --- |').join(''),
    );
    const row = (name, pick) =>
      out.push(`| ${name} | ${conversation.runs.map(pick).join(' | ')} |`);
    row('Completed', (r) => (r.stopped ? 'stopped early' : 'yes'));
    row('Decisions', (r) => r.decisions);
    row('Median decision time', (r) =>
      r.medianDecisionMs === null ? 'none' : seconds(r.medianDecisionMs),
    );
    row(
      'Labelled moments cued (matches the label)',
      (r) => `${r.cued} of ${r.labelledMoments}`,
    );
    row('Cued in time', (r) => `${r.inTime} of ${r.labelledMoments}`);
    row(
      `On screen within ${seconds(BUDGET_MS)}`,
      (r) => `${r.withinBudget} of ${r.labelledMoments}`,
    );
    row(
      `Cues of ${GLANCE_WORDS} words or fewer`,
      (r) => `${r.glance} of ${r.cuesShown} (longest ${r.longestCueWords})`,
    );
    row('Cues where the labels expected none', (r) => r.unexpected);
    row('Repeats', (r) => r.repeats);
    row('Shown and taken back', (r) => r.takenBack);
    row('Quiet kept', (r) => `${r.quietKept} of ${r.quietAsked}`);
    out.push('');
  }
  if (comparison.leftOut.length)
    out.push(
      `Not compared, because not every run reached them: ${comparison.leftOut.join(', ')}.`,
      '',
    );
  out.push('## Limits', '', comparison.limits, '');
  return out.join('\n');
}

/** Reviews a saved take and writes the report beside it. */
export function writeReview(manifestPath, results) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const replay = results.conversations.find(
    (item) => item.id === manifest.conversation,
  );
  if (!replay)
    throw new Error(
      'Those results do not contain the conversation this take shows.',
    );
  const review = reviewTake(manifest, results, replay);
  const base = manifestPath.replace(/\.json$/, '');
  writeFileSync(`${base}.review.md`, reviewMarkdown(review));
  writeFileSync(`${base}.review.json`, `${JSON.stringify(review, null, 2)}\n`);
  return review;
}

export async function main(args, { print = console.log } = {}) {
  const flags = parseFlags(args, {
    values: ['--take', '--results', '--compare', '--out'],
  });
  if (flags['--compare']) {
    // Two or more results files of the same conversations, side by side.
    const files = flags['--compare'].split(',');
    if (files.length < 2)
      throw new Error(
        '--compare takes two or more results files, separated by commas.',
      );
    const comparison = compareRuns(
      files.map((file) => JSON.parse(readFileSync(file, 'utf8'))),
    );
    const page = comparisonMarkdown(comparison);
    if (flags['--out'])
      writeFileSync(
        join(outputDirectory(flags['--out'], {}), 'comparison.md'),
        page,
      );
    print(page);
    return comparison;
  }
  if (!flags['--take'] || !flags['--results'])
    throw new Error(
      'Use --take <take .json> --results <the cue-sim results .json it was recorded from>, or --compare <results .json>,<results .json> [--out <directory outside the repository>].',
    );
  // Reviews are private working files too.
  outputDirectory(dirname(flags['--take']), {});
  const review = writeReview(
    flags['--take'],
    JSON.parse(readFileSync(flags['--results'], 'utf8')),
  );
  print(reviewMarkdown(review));
  return review;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
