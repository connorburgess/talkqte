// Scenario briefs for the dialogue lab: what one fictional meeting is
// about, who is in it, what each person privately knows, which moments are
// planted, and the success criteria a judge checks afterwards. A brief is
// not a script: the lines are generated turn by turn from it.
//
// A real run asks the generator agent for its briefs. The hand-written
// briefs in scripts/fixtures/cue-dialogue-briefs.json only feed the
// deterministic fakes in offline tests and CI.
//
// Every brief, however it was made, passes validateBrief before it is used,
// and each agent is given only its own slice of it (castView, listenerView,
// judgeView). Moments and criteria never reach a participant or the cue
// evaluator; the generation plan never reaches anyone but the generator.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const DOMAINS = ['software', 'ai', 'hiring', 'customer', 'planning'];
/** Moments that leave something open: where context might help. */
export const OPEN_MOMENTS = [
  'unowned-task',
  'question-to-focus',
  'wrong-figure',
  'date-slip',
];
/** Moments the conversation settles by itself, and decoys that only look
 * open. Help at these is at best redundant. */
export const SETTLED_MOMENTS = ['settled', 'decoy'];
export const MOMENT_KINDS = [...OPEN_MOMENTS, ...SETTLED_MOMENTS];

const MAX_PEOPLE = 5;
const MAX_MOMENTS = 6;
const MAX_CRITERIA = 8;
const MAX_CALL_MS = 15 * 60_000;

/** Common real companies and products, matched case-sensitively as whole
 * words. A brief that names one is rejected, never edited. Common English
 * words that are also brand names are left out, so the check misses them;
 * the generator is told to invent every name. */
export const DENY_LIST = [
  'Adobe',
  'Airbnb',
  'Alibaba',
  'Amazon',
  'Anthropic',
  'Apple',
  'Asana',
  'Atlassian',
  'AWS',
  'Azure',
  'Baidu',
  'Bitbucket',
  'ByteDance',
  'ChatGPT',
  'Cisco',
  'Claude',
  'Cloudflare',
  'Coinbase',
  'Confluence',
  'Databricks',
  'Datadog',
  'Deloitte',
  'DeepMind',
  'Dell',
  'Discord',
  'Dropbox',
  'Facebook',
  'Figma',
  'Gemini',
  'GitHub',
  'GitLab',
  'Gmail',
  'Google',
  'Granola',
  'HubSpot',
  'IBM',
  'Instagram',
  'Intel',
  'Jira',
  'KPMG',
  'LinkedIn',
  'Lyft',
  'McKinsey',
  'Meta',
  'Microsoft',
  'Mistral',
  'Netflix',
  'Nvidia',
  'NVIDIA',
  'OpenAI',
  'Oracle',
  'Outlook',
  'PayPal',
  'Pinterest',
  'PwC',
  'Reddit',
  'Salesforce',
  'Samsung',
  'SAP',
  'Shopify',
  'Siemens',
  'Slack',
  'Snowflake',
  'Spotify',
  'Stripe',
  'TalkQTE',
  'Tesla',
  'TikTok',
  'Twitter',
  'Uber',
  'Vercel',
  'WhatsApp',
  'Workday',
  'YouTube',
  'Zendesk',
  'Zoom',
];

// Judging from a transcript means judging what is said. A criterion about
// thoughts, feelings, knowledge or intent, or about the card, cannot be
// checked from the words alone.
const UNOBSERVABLE =
  /\b(?:feels?|felt|thinks?|thought|believes?|believed|knows?|knew|wants?|wanted|intends?|intended|reali[sz]es?|reali[sz]ed|understands?|understood|privately|secretly|card|cue|cues|screen|glance[sd]?|notes?)\b/i;
const GROUP = /\b(?:someone|anyone|nobody|no one|the group|everyone)\b/i;
const CONTACT = /(?:https?:\/\/|www\.|@|\b\d{3}[-. ]\d{3,4}[-. ]\d{4}\b)/i;
const NAME = /^[A-Z][a-z]{1,11}$/;
export const VOICES = ['feminine', 'masculine', 'neutral'];
const AGE = /^(\d{2})-(\d{2})$/;
// A portrait describes an invented person, never a likeness of a real one.
const LIKENESS =
  /\b(?:looks? like|resembl\w*|lookalike|celebrit\w*|famous|actor|actress|singer|politician|athlete|influencer)\b/i;

/** How a person is cast for a synthetic voice and portrait: set by the
 * generator, so casting never guesses from a name. */
function castingProblem(casting) {
  if (!exactKeys(casting, ['voice', 'age', 'portrait']))
    return 'needs casting with exactly voice, age and portrait';
  if (!VOICES.includes(casting.voice))
    return `casting voice must be ${VOICES.join(', ')}`;
  const age = AGE.exec(casting.age ?? '');
  if (
    !age ||
    Number(age[1]) < 18 ||
    Number(age[2]) > 80 ||
    Number(age[2]) <= Number(age[1]) ||
    Number(age[2]) - Number(age[1]) > 15
  )
    return 'casting age must be a range such as 30-39, within 18-80';
  if (!isText(casting.portrait, 200))
    return 'casting portrait must be a short description';
  if (LIKENESS.test(casting.portrait))
    return 'casting portrait must not compare the person to anyone real';
  return null;
}
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isText = (value, max) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= max &&
  value === value.trim();
const isTextList = (value, max, most) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= most &&
  value.every((item) => isText(item, max));
const exactKeys = (value, required, optional = []) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );

/** Every string a brief holds, wherever it is, for the name checks. */
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(strings);
  return [];
}

/** The reasons a brief cannot be used, or an empty list. Nothing is fixed
 * up: a brief either passes as it is or is rejected with every reason.
 * `plan` (from a generation request) also checks the moment counts asked
 * for; `source` 'fixture' allows the offline block the fakes read. */
export function briefProblems(
  brief,
  { plan = null, source = 'generated' } = {},
) {
  const problems = [];
  const fail = (text) => problems.push(text);
  if (
    !exactKeys(
      brief,
      [
        'id',
        'domain',
        'title',
        'setting',
        'focus',
        'people',
        'moments',
        'criteria',
      ],
      source === 'fixture' ? ['offline'] : [],
    )
  )
    return [
      'The brief does not have exactly the fields id, domain, title, setting, focus, people, moments and criteria.',
    ];
  if (!ID.test(brief.id) || brief.id.length > 48)
    fail('id must be short kebab-case.');
  if (!DOMAINS.includes(brief.domain))
    fail(`domain must be one of ${DOMAINS.join(', ')}.`);
  if (plan?.domain && brief.domain !== plan.domain)
    fail(`domain must be ${plan.domain}, as asked.`);
  if (!isText(brief.title, 80)) fail('title must be short text.');
  if (!isText(brief.setting, 300))
    fail('setting must be one or two sentences.');

  const { focus } = brief;
  if (
    !exactKeys(focus, [
      'name',
      'role',
      'goal',
      'knows',
      'distracted',
      'casting',
    ]) ||
    !NAME.test(focus.name) ||
    !isText(focus.role, 80) ||
    !isText(focus.goal, 300) ||
    !isTextList(focus.knows, 240, 5) ||
    !Array.isArray(focus.distracted) ||
    focus.distracted.length > 3 ||
    !focus.distracted.every(
      (window) =>
        exactKeys(window, ['fromMs', 'toMs', 'doing']) &&
        Number.isInteger(window.fromMs) &&
        Number.isInteger(window.toMs) &&
        window.fromMs >= 0 &&
        window.toMs > window.fromMs &&
        window.toMs <= MAX_CALL_MS &&
        isText(window.doing, 120),
    )
  )
    fail(
      'focus must have a first name, role, goal, one to five facts they know, up to three distracted windows in milliseconds, and casting.',
    );

  const people = Array.isArray(brief.people) ? brief.people : [];
  if (
    people.length < 2 ||
    people.length > MAX_PEOPLE - 1 ||
    !people.every(
      (person) =>
        exactKeys(person, ['name', 'role', 'goal', 'privately', 'casting']) &&
        NAME.test(person.name) &&
        isText(person.role, 80) &&
        isText(person.goal, 300) &&
        isTextList(person.privately, 240, 5),
    )
  )
    fail(
      `people must list two to ${MAX_PEOPLE - 1} others, each with a first name, role, goal, one to five private facts and casting.`,
    );
  for (const person of [focus, ...people]) {
    const problem =
      person && typeof person === 'object' && castingProblem(person.casting);
    if (problem) fail(`${person.name ?? 'A person'} ${problem}.`);
  }
  const names = [focus?.name, ...people.map((person) => person?.name)];
  if (new Set(names).size !== names.length)
    fail('Every person needs a different first name.');

  const moments = Array.isArray(brief.moments) ? brief.moments : [];
  const momentIds = new Set();
  if (
    moments.length < 1 ||
    moments.length > MAX_MOMENTS ||
    !moments.every(
      (moment) =>
        exactKeys(moment, ['id', 'kind', 'by', 'description']) &&
        ID.test(moment.id) &&
        !momentIds.has(moment.id) &&
        momentIds.add(moment.id) &&
        MOMENT_KINDS.includes(moment.kind) &&
        names.includes(moment.by) &&
        isText(moment.description, 300),
    )
  )
    fail(
      `moments must list one to ${MAX_MOMENTS}, each with a unique id, a kind (${MOMENT_KINDS.join(', ')}), the person whose words carry it, and a description.`,
    );
  if (plan) {
    const count = (kinds) =>
      moments.filter((moment) => kinds.includes(moment?.kind)).length;
    if (count(OPEN_MOMENTS) !== plan.open)
      fail(`Asked for ${plan.open} open moments; got ${count(OPEN_MOMENTS)}.`);
    if (count(['settled']) !== plan.settled)
      fail(
        `Asked for ${plan.settled} settled moments; got ${count(['settled'])}.`,
      );
    if (count(['decoy']) !== plan.decoys)
      fail(`Asked for ${plan.decoys} decoys; got ${count(['decoy'])}.`);
  }

  const criteria = Array.isArray(brief.criteria) ? brief.criteria : [];
  const criterionIds = new Set();
  if (
    criteria.length < 1 ||
    criteria.length > MAX_CRITERIA ||
    !criteria.every(
      (criterion) =>
        exactKeys(
          criterion,
          ['id', 'moment', 'text'],
          source === 'fixture' ? ['offline'] : [],
        ) &&
        ID.test(criterion.id) &&
        !criterionIds.has(criterion.id) &&
        criterionIds.add(criterion.id) &&
        momentIds.has(criterion.moment) &&
        isText(criterion.text, 240),
    )
  )
    fail(
      `criteria must list one to ${MAX_CRITERIA}, each with a unique id, the id of its moment, and its text.`,
    );
  for (const moment of moments)
    if (moment?.id && !criteria.some((c) => c?.moment === moment.id))
      fail(`Moment ${moment.id} has no criterion.`);
  // Judgeable from a transcript: about someone's words, not their mind.
  for (const criterion of criteria) {
    if (typeof criterion?.text !== 'string') continue;
    if (UNOBSERVABLE.test(criterion.text))
      fail(
        `Criterion ${criterion.id} is about thoughts, feelings, knowledge, intent or the card, which a transcript cannot show.`,
      );
    if (
      !GROUP.test(criterion.text) &&
      !names.some(
        (name) => name && new RegExp(`\\b${name}\\b`).test(criterion.text),
      )
    )
      fail(
        `Criterion ${criterion.id} names nobody in the meeting, so what would show it is unclear.`,
      );
  }

  // No real people, organizations or contact details.
  const text = strings({ ...brief, offline: undefined }).join('\n');
  const named = DENY_LIST.filter((word) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'u').test(text),
  );
  if (named.length)
    fail(`The brief names real companies or products: ${named.join(', ')}.`);
  if (CONTACT.test(text))
    fail('The brief contains a web address, email, handle or phone number.');
  return problems;
}

export function validateBrief(brief, options) {
  const problems = briefProblems(brief, options);
  if (problems.length)
    throw Object.assign(new Error(`Brief rejected: ${problems.join(' ')}`), {
      problems,
    });
  return brief;
}

/** What the other participants' agent is given: the meeting, everyone
 * else's goals and private facts, and only the focus person's name and
 * role. No moments or criteria. */
export function castView(brief) {
  return {
    meeting: { title: brief.title, setting: brief.setting },
    people: brief.people.map(({ name, role, goal, privately }) => ({
      name,
      role,
      goal,
      privately,
    })),
    focus: { name: brief.focus.name, role: brief.focus.role },
  };
}

/** What the listener's agent is given: the meeting, their own goal and
 * facts, and the others' names and roles only. */
export function listenerView(brief) {
  return {
    meeting: { title: brief.title, setting: brief.setting },
    you: {
      name: brief.focus.name,
      role: brief.focus.role,
      goal: brief.focus.goal,
      knows: brief.focus.knows,
    },
    others: brief.people.map(({ name, role }) => ({ name, role })),
  };
}

/** What the judge is given besides a transcript: who was there, and the
 * criteria's ids and words. Nothing about moments, branches or cues. */
export function judgeView(brief) {
  return {
    meeting: { title: brief.title, setting: brief.setting },
    people: [
      { name: brief.focus.name, role: brief.focus.role },
      ...brief.people.map(({ name, role }) => ({ name, role })),
    ],
    criteria: brief.criteria.map(({ id, text }) => ({ id, text })),
  };
}

export const allNames = (brief) => [
  brief.focus.name,
  ...brief.people.map(({ name }) => name),
];

export async function loadFixtureBriefs() {
  const file = JSON.parse(
    await readFile(
      new URL('./fixtures/cue-dialogue-briefs.json', import.meta.url),
      'utf8',
    ),
  );
  for (const brief of file.briefs) validateBrief(brief, { source: 'fixture' });
  return file.briefs;
}

/** Saved briefs as one file's text, and its hash, so a recording can be
 * checked against the briefs its run used. */
export function briefsFile(briefs, meta) {
  const text = `${JSON.stringify({ schema: 'talkqte-cue-dialogue-briefs/1', fictional: true, ...meta, briefs }, null, 2)}\n`;
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}
