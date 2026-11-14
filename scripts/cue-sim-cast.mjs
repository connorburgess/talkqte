// Casting for recordings of the bundled fictional conversations: which
// preset voice reads each invented speaker and how their invented portrait
// is described. Every person here is made up. No description names or
// resembles a real person, and nothing is cloned.
import { createHash } from 'node:crypto';

// How each invented name is cast, so a voice and a portrait agree.
const WOMEN =
  'Priya Lena Dana Yuki Bea Ines June Aiko Noor Hana Elif Sofia Ilse Amara Renata Paula Tess Marta Zara Odette Wren Mina Maya'.split(
    ' ',
  );
// The provider's preset voices, by how they sound.
const VOICES = {
  woman: ['marin', 'coral', 'sage', 'shimmer'],
  man: ['cedar', 'ash', 'verse', 'echo'],
};
const AGES = [
  'in their late twenties',
  'in their mid thirties',
  'around forty',
  'in their late forties',
  'in their early thirties',
  'in their early fifties',
];
const LOOKS = {
  woman: [
    'a woman with shoulder-length dark curly hair and brown skin',
    'a woman with straight black hair and East Asian features',
    'a woman with red hair tied back, light skin and freckles',
    'a woman with a short grey bob, light skin and glasses',
    'a woman with long dark hair and South Asian features',
    'a woman with braided black hair and dark skin',
    'a woman with wavy brown hair and olive skin',
    'a woman with a blonde ponytail and light skin',
  ],
  man: [
    'a man with short grey hair, light skin and glasses',
    'a man with a short beard, dark skin and a shaved head',
    'a man with wavy dark hair and olive skin',
    'a man with black hair and South Asian features',
    'a man with short black hair and East Asian features',
    'a man with curly brown hair, light skin and stubble',
    'a man with a trimmed grey beard and brown skin',
    'a man with sandy hair and light skin',
  ],
};
const CLOTHES = [
  'a plain dark jumper',
  'a casual button-up shirt',
  'a simple t-shirt under an open overshirt',
  'a soft grey cardigan',
  'a navy crew-neck top',
  'a casual collared shirt',
];
const ROOMS = [
  'a tidy home office with a bookshelf',
  'a bright kitchen table by a window',
  'a small study with plants',
  'a plain meeting room with a whiteboard',
  'a living room with a lamp and a sofa',
  'a shared office with desks behind',
];

const pick = (list, seed) =>
  list[
    parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) %
      list.length
  ];

/** For each speaker of a conversation: how they are cast, their preset
 * voice, and the description of their invented portrait. The same speaker
 * in the same conversation always gets the same answer. */
// Preset voices by the kind of voice a brief asks for. Nothing is cloned.
const CAST_VOICES = {
  feminine: ['marin', 'coral', 'sage', 'shimmer'],
  masculine: ['cedar', 'ash', 'verse', 'echo'],
  neutral: ['alloy', 'fable'],
};
const PERSON = {
  feminine: 'a woman',
  masculine: 'a man',
  neutral: 'a person',
};

/** Casting written by a brief: each person's voice, age range and portrait
 * description come from the brief's own fields, never from the name. */
function castFromBrief(conversation) {
  const used = { feminine: 0, masculine: 0, neutral: 0 };
  return Object.fromEntries(
    conversation.participants.map((person) => {
      const { voice: kind, age, portrait } = person.casting;
      const voices = CAST_VOICES[kind];
      if (!voices) throw new Error(`No preset voice for "${kind}".`);
      const voice = voices[used[kind]++ % voices.length];
      const prompt = [
        `A photorealistic still from a laptop webcam during a work video call, showing ${PERSON[kind]} aged ${age}. ${portrait.trim()}`,
        'Head and shoulders, centred, looking toward the camera with a relaxed, attentive expression, mouth closed, mid-conversation.',
        'Soft natural daylight from the side, slightly soft background, ordinary webcam quality, 3:2 landscape framing.',
        'This is an invented person who does not exist: not a real, famous or recognisable person. No text, captions, logos or watermarks.',
      ].join(' ');
      return [person.name, { presents: kind, voice, prompt }];
    }),
  );
}

export function castFor(conversation) {
  const people = conversation.participants ?? [];
  const briefed = people.filter((person) => person.casting);
  // A conversation whose people carry casting is cast from it, and only
  // from it; the name list below serves the bundled conversations alone.
  if (briefed.length) {
    if (briefed.length !== people.length)
      throw new Error(
        'Some people in this conversation carry casting and some do not.',
      );
    return castFromBrief(conversation);
  }
  const speakers = [
    ...new Set([
      ...conversation.participants.map((p) => p.name),
      ...conversation.lines.map((line) => line.speaker),
    ]),
  ];
  const used = { woman: 0, man: 0 };
  const looks = { woman: new Set(), man: new Set() };
  return Object.fromEntries(
    speakers.map((name) => {
      const presents = WOMEN.includes(name) ? 'woman' : 'man';
      const seed = `${conversation.id}/${name}`;
      // No two people in one call share a description.
      let look = pick(LOOKS[presents], seed);
      for (let i = 1; looks[presents].has(look); i++)
        look = pick(LOOKS[presents], `${seed}/${i}`);
      looks[presents].add(look);
      const voice =
        VOICES[presents][used[presents]++ % VOICES[presents].length];
      const prompt = [
        `A photorealistic still from a laptop webcam during a work video call, showing ${look}, ${pick(AGES, `${seed}/age`)}, wearing ${pick(CLOTHES, `${seed}/clothes`)}, sitting in ${pick(ROOMS, `${seed}/room`)}.`,
        'Head and shoulders, centred, looking toward the camera with a relaxed, attentive expression, mouth closed, mid-conversation.',
        'Soft natural daylight from the side, slightly soft background, ordinary webcam quality, 3:2 landscape framing.',
        'This is an invented person who does not exist: not a real, famous or recognisable person. No text, captions, logos or watermarks.',
      ].join(' ');
      return [name, { presents, voice, prompt }];
    }),
  );
}
