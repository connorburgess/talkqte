import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  cueUsage,
  keyStoreName,
  keysStatus,
  removeKey,
  setKey,
  setTranscriptionLanguage,
  setTranscriptionProvider,
  testKey,
  transcriptionLanguage,
  transcriptionProvider,
  watchKeys,
  type TranscriptionLanguage,
  type TranscriptionProvider,
  type CueUsage,
  type KeyProvider,
  type KeyStatus,
  type KeyStore,
  type KeysStatus,
} from '../lib/providerKeys';
import { MeetingNotesModel } from './MeetingNotesModel';
import './provider-keys.css';

const providers: {
  id: KeyProvider;
  name: string;
  role: string;
  whereToGet: string;
}[] = [
  {
    id: 'deepgram',
    name: 'Deepgram',
    role: "Transcribes a live session's audio. Billed by Deepgram per minute, at most 120 minutes per session.",
    whereToGet: 'Deepgram Console (console.deepgram.com) → API Keys',
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    role: "Alternative to Deepgram: transcribes a live session's audio using Scribe v2 Realtime. Billed by ElevenLabs per your account, at most 120 minutes per session.",
    whereToGet: 'ElevenLabs (elevenlabs.io) → Developers → API Keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    role: 'Decides when a cue would help, from recent lines. Billed by Anthropic per token.',
    whereToGet: 'Anthropic Console (console.anthropic.com) → API Keys',
  },
];

export function isKeysStatus(value: unknown): value is KeysStatus {
  const key = (v: unknown) =>
    !!v &&
    typeof v === 'object' &&
    ['notSet', 'set', 'rejected', 'unreadable'].includes(
      (v as KeyStatus).state,
    ) &&
    typeof (v as KeyStatus).verified === 'boolean';
  const candidate = value as KeysStatus | null;
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    key(candidate.deepgram) &&
    (candidate.elevenlabs === undefined || key(candidate.elevenlabs)) &&
    key(candidate.anthropic)
  );
}

function unreadableText(store: KeyStore | undefined) {
  if (store && !store.available) return 'Cannot be saved on this system yet';
  switch (store?.kind) {
    case 'credentialManager':
      return 'Could not be read from Windows Credential Manager. Save the key again.';
    case 'secretService':
      return 'Could not be read from the keyring. Unlock it or allow access, or save the key again.';
    default:
      return 'Could not be read from the Keychain. Unlock it or allow access, or save the key again.';
  }
}

function stateText(
  name: string,
  status: KeyStatus | undefined,
  store: KeyStore | undefined,
) {
  if (!status) return 'Checking…';
  if (status.state === 'notSet') return 'Not set';
  if (status.state === 'unreadable') return unreadableText(store);
  if (status.state === 'rejected')
    return `Rejected by ${name}. Replace it with a new key.`;
  return status.verified ? 'Set and checked' : 'Set, not checked yet';
}

function stateClass(status: KeyStatus | undefined) {
  if (!status) return 'is-checking';
  if (status.state === 'notSet') return 'is-not-set';
  if (status.state === 'set') return 'is-set';
  if (status.state === 'rejected') return 'is-rejected';
  return 'is-unreadable';
}

function message(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function removedFrom(kind: KeyStore['kind'] | undefined) {
  if (kind === 'credentialManager') return 'Windows Credential Manager';
  if (kind === 'secretService') return 'the keyring';
  return 'the Keychain';
}

/** Shown instead of a per-key error when this system has no store to keep
 * keys in (Linux without a keyring service). Nothing is kept elsewhere. */
function NoKeyStore({ store }: { store: KeyStore | undefined }) {
  if (!store || store.available) return null;
  return (
    <p className="provider-keys-error" role="status">
      Keys cannot be saved on this system yet. TalkQTE keeps them only in{' '}
      {keyStoreName(store.kind)}, and none answered for this login. On Ubuntu,
      sign in to a desktop session with GNOME Keyring (Passwords and Keys)
      unlocked, then reopen Settings. Live sessions need a transcription key and
      an Anthropic key.
    </p>
  );
}

const dollars = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

function useProviderKeysData(includeUsage: boolean) {
  const [status, setStatus] = useState<KeysStatus>();
  const [unavailable, setUnavailable] = useState(false);
  const [usage, setUsage] = useState<CueUsage | null>(null);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const receive = (next: unknown) => {
      if (!live) return;
      if (isKeysStatus(next)) {
        setStatus(next);
        setUnavailable(false);
      } else setUnavailable(true);
    };
    keysStatus().then(receive, () => live && setUnavailable(true));
    if (includeUsage) {
      cueUsage().then(
        (next) => live && setUsage(next ?? null),
        () => {},
      );
    }
    watchKeys(receive).then(
      (unlisten) => (live ? (stop = unlisten) : unlisten()),
      () => {},
    );
    return () => {
      live = false;
      stop?.();
    };
  }, [includeUsage]);

  return { status, setStatus, unavailable, setUnavailable, usage };
}

/** The person's own provider keys, and this session's use of them. Keys go
 * to the Keychain through Rust and are never shown again; only their state
 * comes back. */
export function ProviderKeys({ onLiveChange }: { onLiveChange?: () => void }) {
  const { status, setStatus, unavailable, setUnavailable, usage } =
    useProviderKeysData(true);
  const [selectedProvider, setSelectedProvider] =
    useState<TranscriptionProvider>('deepgram');

  return (
    <section className="provider-keys" aria-labelledby="provider-keys-title">
      <div className="provider-keys-intro">
        <h2 id="provider-keys-title">Your API keys</h2>
        <p>
          TalkQTE runs on your own accounts. Live sessions need a transcription
          key (Deepgram or ElevenLabs) and an Anthropic key. Each is kept in{' '}
          {keyStoreName(status?.store?.kind)} and is never shown again. Nothing
          is sent to either provider until you approve a session's processing
          review.
        </p>
        <NoKeyStore store={status?.store} />
        {unavailable && (
          <p className="provider-keys-error" role="alert">
            Your keys could not be read. Try again later.
          </p>
        )}
      </div>
      <div className="provider-keys-list">
        {providers.map((provider) => (
          <KeyRow
            key={provider.id}
            provider={provider}
            status={status?.[provider.id]}
            store={status?.store}
            onStatus={(next) => {
              setStatus(next);
              setUnavailable(false);
              onLiveChange?.();
            }}
          />
        ))}
        <p className="provider-key-usage" role="status">
          {usage
            ? `This session: ${usage.requests} of ${usage.requestCap} cue requests, about ${dollars(usage.spentMicroUsd)} of ${dollars(usage.spendCapMicroUsd)} (an estimate, not your bill), model ${usage.model}.`
            : 'No session has used your Anthropic key yet.'}
        </p>
        <ProviderChoice
          onChanged={(next) => {
            setSelectedProvider(next);
            onLiveChange?.();
          }}
        />
        <LanguageChoice provider={selectedProvider} />
        <MeetingNotesModel />
      </div>
    </section>
  );
}

/** Provider key rows reused inside onboarding step 2 with identical behavior
 * and controls to Settings -> Your API keys. */
export function ProviderKeysRows({
  showWhereToGet = false,
}: {
  showWhereToGet?: boolean;
}) {
  const { status, setStatus, unavailable, setUnavailable } =
    useProviderKeysData(false);

  return (
    <div className="provider-keys-list provider-keys-embedded">
      {unavailable && (
        <p className="provider-keys-error" role="alert">
          Your keys could not be read. Try again later.
        </p>
      )}
      <NoKeyStore store={status?.store} />
      {providers.map((provider) => (
        <KeyRow
          key={provider.id}
          provider={provider}
          status={status?.[provider.id]}
          store={status?.store}
          showWhereToGet={showWhereToGet}
          embedded
          onStatus={(next) => {
            setStatus(next);
            setUnavailable(false);
          }}
        />
      ))}
    </div>
  );
}

function KeyRow({
  provider,
  status,
  store,
  showWhereToGet = false,
  embedded = false,
  onStatus,
}: {
  provider: (typeof providers)[number];
  status: KeyStatus | undefined;
  store: KeyStore | undefined;
  showWhereToGet?: boolean;
  /** In setup, directly under the step's level-one heading. */
  embedded?: boolean;
  onStatus: (status: KeysStatus) => void;
}) {
  const id = useId();
  const Heading = embedded ? 'h2' : 'h3';
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const noStore = !!store && !store.available;
  const stored = !!status && status.state !== 'notSet' && !noStore;

  const run = async (
    action: 'save' | 'test' | 'remove',
    work: () => Promise<KeysStatus>,
    done: (status: KeysStatus) => string,
  ) => {
    setBusy(action);
    setError('');
    setNote('');
    try {
      const next = await work();
      if (action === 'save') setDraft('');
      if (isKeysStatus(next)) {
        onStatus(next);
        setNote(done(next));
      }
    } catch (failure) {
      // A refused key is not kept on screen or in memory longer than needed.
      if (action === 'save') setDraft('');
      setError(message(failure, 'Nothing was changed. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    void run(
      'save',
      () => setKey(provider.id, draft),
      () => `${provider.name} key saved. It was not checked.`,
    );
  };

  return (
    <form
      className="provider-key"
      aria-labelledby={`${id}-name`}
      onSubmit={save}
    >
      <div className="provider-key-head">
        <Heading id={`${id}-name`}>{provider.name}</Heading>
        <p
          id={`${id}-state`}
          className={`provider-key-state ${
            busy === 'test' ? 'is-checking' : stateClass(status)
          }`}
        >
          {busy === 'test'
            ? 'Checking…'
            : stateText(provider.name, status, store)}
        </p>
      </div>
      <p id={`${id}-role`} className="provider-key-role">
        {provider.role}
      </p>
      {showWhereToGet && (
        <p className="provider-key-where">
          <strong>Where to get one:</strong> {provider.whereToGet}
        </p>
      )}
      <label htmlFor={`${id}-input`}>
        {stored ? `Replace ${provider.name} key` : `${provider.name} API key`}
      </label>
      <input
        id={`${id}-input`}
        type="password"
        value={draft}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={512}
        disabled={noStore}
        aria-describedby={`${id}-state${error ? ` ${id}-error` : ''}`}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="provider-key-actions">
        <button
          type="submit"
          className="primary-button provider-key-btn"
          disabled={noStore || !draft.trim() || busy !== null}
        >
          {busy === 'save' ? 'Saving…' : 'Save key'}
        </button>
        <button
          type="button"
          className="secondary-button provider-key-btn"
          disabled={!stored || busy !== null}
          onClick={() =>
            void run(
              'test',
              () => testKey(provider.id),
              (next) =>
                next[provider.id]?.state === 'rejected'
                  ? `${provider.name} rejected the key.`
                  : `${provider.name} accepted the key.`,
            )
          }
        >
          {busy === 'test' ? 'Checking…' : 'Test key'}
        </button>
        <button
          type="button"
          className="secondary-button provider-key-btn provider-key-remove"
          disabled={!stored || busy !== null}
          onClick={() =>
            void run(
              'remove',
              () => removeKey(provider.id),
              () =>
                `${provider.name} key removed from ${removedFrom(store?.kind)}.`,
            )
          }
        >
          {busy === 'remove' ? 'Removing…' : 'Remove key'}
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="provider-keys-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="provider-key-note" role="status">
          {note}
        </p>
      )}
    </form>
  );
}

/** Which cloud service transcribes the next live session. */
function ProviderChoice({
  onChanged,
}: {
  onChanged: (provider: TranscriptionProvider) => void;
}) {
  const id = useId();
  const [provider, setProvider] = useState<TranscriptionProvider>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    transcriptionProvider().then(
      (value) => {
        if (!live) return;
        const normalized = value === 'elevenlabs' ? 'elevenlabs' : 'deepgram';
        setProvider(normalized);
        onChanged(normalized);
      },
      () => live && setProvider('deepgram'),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="provider-key provider-language">
      <label htmlFor={`${id}-provider`}>Transcription provider</label>
      <select
        id={`${id}-provider`}
        value={provider ?? 'deepgram'}
        disabled={provider === undefined}
        aria-describedby={`${id}-provider-help${error ? ` ${id}-provider-error` : ''}`}
        onChange={(event) => {
          const next =
            event.target.value === 'elevenlabs' ? 'elevenlabs' : 'deepgram';
          setError('');
          setTranscriptionProvider(next).then(
            (value) => {
              setProvider(value);
              onChanged(value);
            },
            (failure) =>
              setError(
                message(failure, 'The transcription provider was not changed.'),
              ),
          );
        }}
      >
        <option value="deepgram">Deepgram</option>
        <option value="elevenlabs">ElevenLabs</option>
      </select>
      <p id={`${id}-provider-help`} className="provider-key-role">
        Choose which service transcribes your audio (Deepgram Nova-3 or
        ElevenLabs Scribe v2 Realtime); saved in Settings and used from the next
        live session.
      </p>
      {error && (
        <p
          id={`${id}-provider-error`}
          className="provider-keys-error"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}

/** One plain control: which language the active provider transcribes in the
 * next live session. */
function LanguageChoice({ provider }: { provider: TranscriptionProvider }) {
  const id = useId();
  const [language, setLanguage] = useState<TranscriptionLanguage>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    transcriptionLanguage().then(
      (value) => live && setLanguage(value === 'multi' ? 'multi' : 'en'),
      () => live && setLanguage('en'),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="provider-key provider-language">
      <label htmlFor={`${id}-language`}>Transcription language</label>
      <select
        id={`${id}-language`}
        value={language ?? 'en'}
        disabled={language === undefined}
        aria-describedby={`${id}-language-help${error ? ` ${id}-language-error` : ''}`}
        onChange={(event) => {
          const next = event.target.value === 'multi' ? 'multi' : 'en';
          setError('');
          setTranscriptionLanguage(next).then(
            (value) => setLanguage(value),
            (failure) =>
              setError(message(failure, 'The language was not changed.')),
          );
        }}
      >
        <option value="en">English</option>
        <option value="multi">Multilingual</option>
      </select>
      <p id={`${id}-language-help`} className="provider-key-role">
        Applies to the next live session, never one already running.{' '}
        {provider === 'elevenlabs'
          ? 'English sets language_code=en; Multilingual lets ElevenLabs Scribe v2 Realtime detect languages automatically.'
          : 'Multilingual follows several languages and switches between them, and Deepgram bills it at a higher rate than English.'}{' '}
        Phrase-rule cues understand English only; a question that opens with
        your name and ends in a question mark is noticed in any language; model
        cues work on what the model understands.
      </p>
      {error && (
        <p
          id={`${id}-language-error`}
          className="provider-keys-error"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
