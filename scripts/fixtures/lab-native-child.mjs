// Harmless launcher fixture: writes synthetic control evidence only. It never
// opens an app, media device, model, credential or network connection. The
// descriptor-peer case alone connects to the test's own local broker socket.
import {
  appendFileSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
const path = process.env.TALKQTE_TIMING_LOG;
const run = process.env.TALKQTE_DEV_LAB_RUN_ID;
const mode = process.env.TALKQTE_FIXTURE_CASE;
if (
  mode === 'capture-only' &&
  Object.keys(process.env).some(
    (key) =>
      /MODEL|PROVIDER|BACKEND|DESCRIPTOR|CODEX|CLAUDE/.test(key) &&
      // A capture-only launch carries only the transcription setting.
      key !== 'TALKQTE_DEV_STT_BACKEND',
  )
)
  process.exit(3);
const frame = (step) =>
  JSON.stringify({
    event: 'dev_stop',
    run_id: run,
    step,
    wall_ms: 1,
    mono_ms: 1,
  }) + '\n';
const put = (step) => appendFileSync(path, frame(step));
process.on('SIGUSR2', () => {
  put('latched');
  put('stopping');
  if (mode !== 'lost-released') put('released');
  setTimeout(() => process.exit(0), 25);
});
if (
  !/^[1-9][0-9]*$/.test(process.env.TALKQTE_DEV_STOP_AFTER_S ?? '') ||
  process.env.TALKQTE_DEV_APPLICATION_SOURCE !== 'QuickTime Player' ||
  process.env.TALKQTE_DEV_STOP_SIGNAL !== 'usr2'
)
  process.exit(2);
if (mode === 'partial') {
  const text = frame('armed');
  appendFileSync(path, text.slice(0, 10));
  setTimeout(() => appendFileSync(path, text.slice(10)), 40);
} else if (mode === 'wrong-run')
  appendFileSync(
    path,
    JSON.stringify({ event: 'dev_stop', run_id: 'foreign', step: 'armed' }) +
      '\n',
  );
else if (mode === 'lost-armed')
  appendFileSync(
    path,
    JSON.stringify({
      event: 'segment',
      text: 'Fictional speech discarded by parser.',
    }) + '\n',
  );
else if (mode === 'duplicate-fields')
  appendFileSync(
    path,
    '{"event":"dev_stop","run_id":"' +
      run +
      '","run_id":"' +
      run +
      '","step":"armed"}\n',
  );
else if (mode === 'frame-oversize')
  appendFileSync(path, 'x'.repeat(65 * 1024) + '\n');
else if (mode === 'bad-utf8') appendFileSync(path, Buffer.from([255, 10]));
else if (mode === 'stall-partial') appendFileSync(path, '{"event":');
else put('armed');
if (mode === 'listening') {
  for (const event of [
    {
      event: 'dev_source',
      step: 'acknowledged',
      application: 'QuickTime Player',
    },
    {
      event: 'session',
      state: 'started',
      session: 1,
      live: true,
      commit: 'b'.repeat(40),
      features: [
        'cloud-transcription',
        'lab-evaluator',
        'native-audio-spike',
        'timing-log',
      ],
    },
    { event: 'dev_source', step: 'started', application: 'QuickTime Player' },
  ])
    appendFileSync(path, JSON.stringify(event) + '\n');
}
if (mode === 'truncate') setTimeout(() => writeFileSync(path, ''), 80);
if (mode === 'rotate')
  setTimeout(() => {
    renameSync(path, path + '.old');
    writeFileSync(path, frame('armed'), { mode: 0o600 });
  }, 80);
if (mode === 'oversize')
  setTimeout(() => appendFileSync(path, 'x'.repeat(9 * 1024 * 1024)), 80);
if (mode === 'exit') setTimeout(() => process.exit(0), 80);
if (mode === 'descriptor-peer') {
  // Mirrors the native descriptor reader: the socket must be a lexical sibling
  // of the descriptor path received, compared before any connection attempt.
  const path = process.env.TALKQTE_DEV_LAB_DESCRIPTOR;
  const descriptor = JSON.parse(readFileSync(path, 'utf8'));
  if (dirname(descriptor.socketPath) !== dirname(path)) process.exit(4);
  const socket = createConnection({ path: descriptor.socketPath });
  const send = (type, fields) =>
    socket.write(
      JSON.stringify({
        schema: 'talkqte.lab.v1',
        type,
        runId: run,
        sessionId: '7',
        ...fields,
      }) + '\n',
    );
  socket.once('connect', () =>
    send('hello', {
      nonce: descriptor.nonce,
      expectedProvider: process.env.TALKQTE_DEV_LAB_PROVIDER,
      expectedModel: process.env.TALKQTE_DEV_LAB_MODEL,
      expectedEffort: process.env.TALKQTE_DEV_LAB_EFFORT,
    }),
  );
  let partial = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    partial += chunk;
    for (let end; (end = partial.indexOf('\n')) !== -1;) {
      const frame = JSON.parse(partial.slice(0, end));
      partial = partial.slice(end + 1);
      if (frame.type === 'clock_probe')
        send('clock_sample', {
          probeId: frame.probeId,
          nativeSessionElapsedMs: 1000,
        });
    }
  });
  // Only a failed connection ends the child; a reset during owned Stop must
  // not pre-empt the release steps written by the USR2 handler.
  let connected = false;
  socket.once('connect', () => (connected = true));
  socket.on('error', () => {
    if (!connected) process.exit(5);
  });
}
if (
  mode === 'cloud-transcription' ||
  mode === 'cloud-early' ||
  mode === 'cloud-other-session' ||
  mode === 'cloud-reconnect' ||
  mode === 'cloud-reconnect-thrice' ||
  mode === 'cloud-reconnect-pending' ||
  mode === 'cloud-reconnect-pending-thrice' ||
  mode === 'cloud-reconnect-before-first' ||
  mode === 'cloud-reconnect-other-session' ||
  mode === 'cloud-reconnect-changed-query'
) {
  // Mirrors the app's cloud transcription settings and token-file rules
  // (#344): at session start the token file exists as an owner-only file in
  // an owner-only folder (here still the empty placeholder); after the
  // review the stream starts, polls the file until it holds a token, then
  // connects and reports the query it used.
  const file = process.env.TALKQTE_DEV_STT_TOKEN_FILE ?? '';
  const usableFile = () => {
    try {
      const f = lstatSync(file),
        d = lstatSync(dirname(file));
      return (
        f.isFile() &&
        (f.mode & 0o777) === 0o600 &&
        f.uid === process.getuid() &&
        f.size <= 4096 &&
        d.isDirectory() &&
        (d.mode & 0o777) === 0o700 &&
        d.uid === process.getuid()
      );
    } catch {
      return false;
    }
  };
  const settings =
    process.env.TALKQTE_DEV_STT_BACKEND === 'deepgram' &&
    /^[1-9][0-9]?$/.test(process.env.TALKQTE_DEV_STT_MINUTE_CAP ?? '') &&
    Number(process.env.TALKQTE_DEV_STT_MINUTE_CAP) <= 60 &&
    file.startsWith('/') &&
    process.env.TALKQTE_WHISPER_MODEL === undefined;
  // Before the review the file must be the empty placeholder.
  if (!settings || !usableFile() || lstatSync(file).size !== 0) process.exit(6);
  // As the app's TALKQTE_DEV_USER_NAME (#363 follow-up): an unusable name
  // refuses the start; a usable one is in effect from the session's start.
  const name = process.env.TALKQTE_DEV_USER_NAME;
  if (
    name !== undefined &&
    !(
      name === name.trim() &&
      name.length >= 1 &&
      name.length <= 40 &&
      /\p{L}/u.test(name) &&
      /^[\p{L}\u0300-\u036f '\-\u2019]+$/u.test(name)
    )
  )
    process.exit(7);
  const row = (fields) =>
    appendFileSync(
      path,
      JSON.stringify({ wall_ms: 1, mono_ms: 2, ...fields }) + '\n',
    );
  const review = {
    event: 'evaluator',
    approval: 'review',
    session: 2,
    state: 'on',
    backend: 'lab-api',
    model: process.env.TALKQTE_DEV_LAB_MODEL,
    effort: 'low',
    elapsed_ms: 5,
  };
  const started = {
    event: 'stt_state',
    session: mode === 'cloud-other-session' ? 3 : 2,
    state: 'started',
    audio_ms: 0,
  };
  setTimeout(() => {
    row({ event: 'user_name_set', session: 2, set: name !== undefined });
    for (const fields of mode === 'cloud-early'
      ? [started, review]
      : [review, started])
      row(fields);
    const until = Date.now() + 3000;
    const poll = setInterval(() => {
      let token = '';
      try {
        token = usableFile() ? readFileSync(file, 'utf8').trim() : '';
      } catch {}
      if (/^[A-Za-z0-9._-]{20,4096}$/.test(token)) {
        clearInterval(poll);
        const connected = (changed = false) =>
          row({
            event: 'stt_state',
            session: started.session,
            state: 'connected',
            audio_ms: 0,
            query:
              'model=nova-3&language=' +
              (changed ? 'fr' : 'en') +
              '&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&diarize=true&endpointing=300&utterance_end_ms=1000&vad_events=true&mip_opt_out=true',
          });
        if (mode !== 'cloud-reconnect-before-first') connected();
        // As #357: a stalled stream is replaced by one that reads the token
        // file again; with the file gone, the replacement fails as settings.
        const times =
          {
            'cloud-reconnect': 2,
            'cloud-reconnect-thrice': 3,
            'cloud-reconnect-pending': 2,
            'cloud-reconnect-pending-thrice': 3,
            'cloud-reconnect-before-first': 1,
            'cloud-reconnect-other-session': 1,
            'cloud-reconnect-changed-query': 1,
          }[mode] ?? 0;
        for (let n = 1; n <= times; n++)
          setTimeout(() => {
            row({
              event: 'stt_state',
              session:
                mode === 'cloud-reconnect-other-session' ? 3 : started.session,
              state: 'reconnecting',
              code: 'stalled',
              gap_ms: 1200,
              audio_ms: 1000 * n,
            });
            let again = '';
            try {
              again = usableFile() ? readFileSync(file, 'utf8').trim() : '';
            } catch {}
            if (/^[A-Za-z0-9._-]{20,4096}$/.test(again)) {
              const pending =
                mode === 'cloud-reconnect-pending' ||
                mode === 'cloud-reconnect-pending-thrice';
              if (!pending || n === times)
                connected(mode === 'cloud-reconnect-changed-query');
            } else
              row({
                event: 'stt_state',
                session: started.session,
                state: 'stopped',
                code: 'settings',
                audio_ms: 1000 * n,
              });
          }, 60 * n);
      } else if (Date.now() > until) {
        clearInterval(poll);
        row({
          event: 'stt_state',
          session: started.session,
          state: 'stopped',
          code: 'settings',
          audio_ms: 0,
        });
      }
    }, 20);
  }, 40);
}
if (mode === 'source-gone')
  // Native loses its captured source mid-session and ends it itself.
  setTimeout(() => {
    for (const row of [
      { event: 'source_problem', problem: 'source_gone', os_code: -3815 },
      {
        event: 'source_ended',
        application: 'QuickTime Player',
        problem: 'applicationEnded',
      },
    ])
      appendFileSync(
        path,
        JSON.stringify({ wall_ms: 1, mono_ms: 2, ...row }) + '\n',
      );
  }, 60);
// Fixture only; never evidence of release.
setTimeout(() => process.exit(0), mode === 'descriptor-peer' ? 5000 : 1500);
