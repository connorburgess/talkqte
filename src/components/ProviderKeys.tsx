import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import {
  CURATED_CUE_MODELS,
  cueProviderName,
  cueUsage,
  defaultCueModel,
  keyStoreLabel,
  keyStoreName,
  keysStatus,
  providerPreferences,
  removeKey,
  setCueModelOverride,
  setCueProvider,
  setKey,
  setTranscriptionLanguage,
  setTranscriptionProvider,
  testKey,
  transcriptionLanguage,
  transcriptionProvider,
  watchKeys,
  watchPreviewPreferences,
  type CueProvider,
  type CueUsage,
  type KeyProvider,
  type KeyStatus,
  type KeyStore,
  type KeysStatus,
  type ProviderPreferences,
  type TranscriptionLanguage,
  type TranscriptionProvider,
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
    role: 'Decides when a cue would help, from recent lines, or writes meeting notes. Billed by Anthropic per token.',
    whereToGet: 'Anthropic Console (console.anthropic.com) → API Keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    role: 'Decides when a cue would help or writes meeting notes, if selected. Billed by OpenAI per token.',
    whereToGet: 'OpenAI Platform (platform.openai.com) → API keys',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    role: 'Decides when a cue would help or writes meeting notes, if selected. Billed by Google per token.',
    whereToGet: 'Google AI Studio (aistudio.google.com) → API keys',
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
    key(candidate.anthropic) &&
    (!candidate.openai || key(candidate.openai)) &&
    (!candidate.gemini || key(candidate.gemini))
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

const SAVED_KEY_MASK = '••••••••••••••••••••••••';
const SAVED_KEY_PLACEHOLDER = 'Paste a new key to replace the saved one';
const REJECTED_KEY_PLACEHOLDER = 'Paste a new key to replace the rejected one';
const UNREADABLE_KEY_PLACEHOLDER = 'Paste a key to save it again';

function stateText(
  name: string,
  status: KeyStatus | undefined,
  store: KeyStore | undefined,
  unavailable = false,
) {
  if (unavailable) return 'Unavailable';
  if (!status) return 'Checking…';
  if (status.state === 'notSet') return 'Not set';
  if (status.state === 'unreadable') return unreadableText(store);
  if (status.state === 'rejected')
    return `Rejected by ${name}. Replace it with a new key.`;
  return status.verified ? 'Saved · checked' : 'Saved · not checked yet';
}

function stateClass(status: KeyStatus | undefined, unavailable = false) {
  if (unavailable) return 'is-unreadable';
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

function useProviderKeysData(
  includeUsage: boolean,
  onKeysChanged?: () => void,
) {
  const [status, setStatus] = useState<KeysStatus>();
  const [unavailable, setUnavailable] = useState(false);
  const [usage, setUsage] = useState<CueUsage | null>(null);
  const onKeysChangedRef = useRef(onKeysChanged);
  onKeysChangedRef.current = onKeysChanged;

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const receive = (next: unknown, fromWatch: boolean) => {
      if (!live) return;
      if (isKeysStatus(next)) {
        setStatus(next);
        setUnavailable(false);
        if (fromWatch) onKeysChangedRef.current?.();
      } else setUnavailable(true);
    };
    keysStatus().then(
      (next) => receive(next, false),
      () => live && setUnavailable(true),
    );
    if (includeUsage) {
      cueUsage().then(
        (next) => live && setUsage(next ?? null),
        () => {},
      );
    }
    watchKeys((next) => receive(next, true)).then(
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

/** The person's own provider keys, active transcription & cue/notes provider &
 * model choices, and this session's use of them. Keys go to the secret store
 * through Rust and are never shown again; only their state comes back. */
export function ProviderKeys({
  onPreferencesChange,
  onKeysChanged,
}: {
  onPreferencesChange?: () => void;
  onKeysChanged?: () => void;
}) {
  const { status, setStatus, unavailable, setUnavailable, usage } =
    useProviderKeysData(true, onKeysChanged);
  const [selectedSttProvider, setSelectedSttProvider] =
    useState<TranscriptionProvider>('deepgram');
  const [prefs, setPrefs] = useState<ProviderPreferences | null>(null);

  useEffect(() => {
    let live = true;
    providerPreferences().then(
      (next) => live && setPrefs(next),
      () => {},
    );
    const stopPreview = watchPreviewPreferences((next) => {
      if (live) setPrefs(next);
    });
    return () => {
      live = false;
      stopPreview();
    };
  }, []);

  const activeProvider: CueProvider = prefs?.cueProvider ?? 'anthropic';
  const activeProviderName = cueProviderName(activeProvider);

  const usageLine = () => {
    if (!usage) {
      return `No session has used your ${activeProviderName} key yet.`;
    }
    if (
      usage.customModel ||
      usage.spentMicroUsd === null ||
      usage.spentMicroUsd === undefined ||
      usage.spendCapMicroUsd === null ||
      usage.spendCapMicroUsd === undefined
    ) {
      return `This session: ${usage.requests} of ${usage.requestCap} cue requests. Estimated spend unavailable for custom model ${usage.model}.`;
    }
    return `This session: ${usage.requests} of ${usage.requestCap} cue requests, about ${dollars(usage.spentMicroUsd)} of ${dollars(usage.spendCapMicroUsd)} (an estimate, not your bill), model ${usage.model}.`;
  };

  const applyPrefs = (next: ProviderPreferences) => {
    setPrefs(next);
    onPreferencesChange?.();
  };

  return (
    <section className="provider-keys" aria-labelledby="provider-keys-title">
      <div className="provider-keys-intro">
        <h2 id="provider-keys-title">Your API keys</h2>
        <p>
          TalkQTE runs on your own accounts. Live sessions need a transcription
          key (Deepgram or ElevenLabs) and a key for your chosen cue provider.
          Each is kept in {keyStoreName(status?.store?.kind)} and is never shown
          again. Nothing is sent until you start a live session (or press Test
          key).
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
            unavailable={unavailable}
            onStatus={(next) => {
              setStatus(next);
              setUnavailable(false);
              onKeysChanged?.();
              onPreferencesChange?.();
            }}
          />
        ))}
        <p className="provider-keys-usage" role="status">
          {usageLine()}
        </p>
        <ProviderChoice
          onChanged={(next) => {
            setSelectedSttProvider(next);
            onPreferencesChange?.();
          }}
        />
        <CueProviderAndModelChoice prefs={prefs} onChange={applyPrefs} />
        <LanguageChoice provider={selectedSttProvider} />
        <MeetingNotesModel
          provider={activeProvider}
          prefs={prefs}
          onChange={applyPrefs}
        />
      </div>
    </section>
  );
}

function CueProviderAndModelChoice({
  prefs,
  onChange,
}: {
  prefs: ProviderPreferences | null;
  onChange: (next: ProviderPreferences) => void;
}) {
  const id = useId();
  const provider: CueProvider = prefs?.cueProvider ?? 'anthropic';
  const testedDefault = defaultCueModel(provider);
  const curated = CURATED_CUE_MODELS[provider];
  const effectiveCue = prefs?.effectiveCueModel ?? testedDefault;
  const isCuratedSelected = curated.some((m) => m.id === effectiveCue);
  const [customDraft, setCustomDraft] = useState(
    prefs?.effectiveCueCustom ? (prefs.cueModelOverride ?? '') : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    setCustomDraft(
      prefs?.effectiveCueCustom ? (prefs.cueModelOverride ?? '') : '',
    );
  }, [prefs?.cueProvider, prefs?.cueModelOverride, prefs?.effectiveCueCustom]);

  const changeProvider = async (next: CueProvider) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const updated = await setCueProvider(next);
      onChange(updated);
      setNote(
        `Cue and meeting notes provider set to ${cueProviderName(next)} (${updated.effectiveCueModel} for cues).`,
      );
    } catch (failure) {
      setError(message(failure, 'The provider was not changed.'));
    } finally {
      setBusy(false);
    }
  };

  const changeCuratedCue = async (modelId: string) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const override = modelId === testedDefault ? null : modelId;
      const updated = await setCueModelOverride(override);
      onChange(updated);
      setNote(`Cue model set to ${updated.effectiveCueModel}.`);
    } catch (failure) {
      setError(message(failure, 'The cue model was not changed.'));
    } finally {
      setBusy(false);
    }
  };

  const saveCustomCue = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNote('');
    try {
      const trimmed = customDraft.trim();
      const updated = await setCueModelOverride(trimmed || null);
      onChange(updated);
      setNote(
        updated.effectiveCueCustom
          ? `Custom cue model saved: ${updated.effectiveCueModel}.`
          : `Using tested default cue model: ${updated.effectiveCueModel}.`,
      );
    } catch (failure) {
      setError(message(failure, 'The custom model ID was not saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="provider-key provider-language">
        <label htmlFor={`${id}-cue-provider`}>Cue &amp; notes provider</label>
        <select
          id={`${id}-cue-provider`}
          value={provider}
          disabled={!prefs || busy}
          aria-describedby={`${id}-cue-provider-help${error ? ` ${id}-cue-error` : ''}`}
          onChange={(event) =>
            void changeProvider(event.target.value as CueProvider)
          }
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
        </select>
        <p id={`${id}-cue-provider-help`} className="provider-key-role">
          Applies to the next live session and next meeting notes request. Never
          falls back to another service if a request fails.
        </p>
      </div>

      <form className="provider-key provider-language" onSubmit={saveCustomCue}>
        <label htmlFor={`${id}-cue-model`}>Cue model</label>
        <select
          id={`${id}-cue-model`}
          value={isCuratedSelected ? effectiveCue : '__custom__'}
          disabled={!prefs || busy}
          onChange={(event) => {
            if (event.target.value !== '__custom__') {
              void changeCuratedCue(event.target.value);
            }
          }}
        >
          {curated.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          {!isCuratedSelected && (
            <option value="__custom__">Custom: {effectiveCue}</option>
          )}
        </select>

        <label htmlFor={`${id}-custom-cue-model`}>
          Custom cue model ID (optional)
        </label>
        <input
          id={`${id}-custom-cue-model`}
          type="text"
          value={customDraft}
          maxLength={96}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={!prefs || busy}
          placeholder={`Leave blank for tested default (${testedDefault})`}
          aria-describedby={`${id}-custom-cue-help${error ? ` ${id}-cue-error` : ''}`}
          onChange={(event) => setCustomDraft(event.target.value)}
        />
        <p id={`${id}-custom-cue-help`} className="provider-key-role">
          Leave blank to use the tested default ({testedDefault}). Custom model
          IDs keep the 400-request cap; estimated dollar spend is unavailable
          for models outside the built-in price table.
        </p>
        <div className="provider-key-actions">
          <button
            type="submit"
            className="secondary-button provider-key-btn"
            disabled={!prefs || busy}
          >
            Save cue model
          </button>
          {prefs?.cueModelOverride && (
            <button
              type="button"
              className="secondary-button provider-key-btn"
              disabled={busy}
              onClick={() => {
                setCustomDraft('');
                void changeCuratedCue(testedDefault);
              }}
            >
              Use tested default
            </button>
          )}
        </div>
        {error ? (
          <p
            id={`${id}-cue-error`}
            className="provider-keys-error"
            role="alert"
          >
            {error}
          </p>
        ) : (
          note && (
            <p className="provider-key-note" role="status">
              {note}
            </p>
          )
        )}
      </form>
    </>
  );
}

/** Provider key rows reused inside onboarding step 2 with identical behavior
 * and controls to Settings -> Your API keys. */
export function ProviderKeysRows({
  showWhereToGet = false,
  onKeysChanged,
}: {
  showWhereToGet?: boolean;
  onKeysChanged?: () => void;
}) {
  const { status, setStatus, unavailable, setUnavailable } =
    useProviderKeysData(false, onKeysChanged);

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
          unavailable={unavailable}
          showWhereToGet={showWhereToGet}
          embedded
          onStatus={(next) => {
            setStatus(next);
            setUnavailable(false);
            onKeysChanged?.();
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
  unavailable = false,
  showWhereToGet = false,
  embedded = false,
  onStatus,
}: {
  provider: (typeof providers)[number];
  status: KeyStatus | undefined;
  store: KeyStore | undefined;
  unavailable?: boolean;
  showWhereToGet?: boolean;
  /** In setup, directly under the step's level-one heading. */
  embedded?: boolean;
  onStatus: (status: KeysStatus) => void;
}) {
  const id = useId();
  const Heading = embedded ? 'h2' : 'h3';
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<'input' | 'replace' | null>(null);
  const [draft, setDraft] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const noStore = !!store && !store.available;
  const stored = !!status && status.state !== 'notSet' && !noStore;
  const badgeClass =
    busy === 'test' ? 'is-checking' : stateClass(status, unavailable);
  const isSaved = status?.state === 'set' && !noStore && !unavailable;
  const isRejected = status?.state === 'rejected' && !noStore && !unavailable;
  const isWarningBadge =
    badgeClass === 'is-rejected' || badgeClass === 'is-unreadable';
  const showInput = !isSaved || replacing;
  const inputPlaceholder = noStore
    ? 'Cannot be saved on this system yet'
    : isSaved
      ? SAVED_KEY_PLACEHOLDER
      : isRejected
        ? REJECTED_KEY_PLACEHOLDER
        : status?.state === 'unreadable' && !unavailable
          ? UNREADABLE_KEY_PLACEHOLDER
          : undefined;

  useEffect(() => {
    if (!isSaved) setReplacing(false);
  }, [isSaved]);

  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target || busy !== null) return;
    if (target === 'input' && showInput && inputRef.current) {
      pendingFocusRef.current = null;
      inputRef.current.focus();
    } else if (target === 'replace' && !showInput && replaceButtonRef.current) {
      pendingFocusRef.current = null;
      replaceButtonRef.current.focus();
    }
  }, [showInput, busy]);

  const startReplace = () => {
    pendingFocusRef.current = 'input';
    setReplacing(true);
    setError('');
    setNote('');
  };

  const cancelReplace = () => {
    pendingFocusRef.current = 'replace';
    setReplacing(false);
    setDraft('');
    setError('');
  };

  const run = async (
    action: 'save' | 'test' | 'remove',
    work: () => Promise<KeysStatus>,
    done: (status: KeysStatus) => string,
  ) => {
    const focusInRow = !!formRef.current?.contains(document.activeElement);
    if (action === 'save' && focusInRow) {
      pendingFocusRef.current = 'replace';
    }
    setBusy(action);
    setError('');
    setNote('');
    try {
      const next = await work();
      if (action === 'save') {
        setDraft('');
        setReplacing(false);
      }
      if (isKeysStatus(next)) {
        onStatus(next);
        setNote(done(next));
      }
    } catch (failure) {
      if (action === 'save') {
        pendingFocusRef.current = null;
        // A refused key is not kept on screen or in memory longer than needed.
        setDraft('');
      }
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
      ref={formRef}
      className="provider-key"
      aria-labelledby={`${id}-name`}
      onSubmit={save}
    >
      <div className="provider-key-head">
        <Heading id={`${id}-name`}>{provider.name}</Heading>
        <p id={`${id}-state`} className={`provider-key-state ${badgeClass}`}>
          {badgeClass === 'is-set' && (
            <Check size={13} strokeWidth={2.5} aria-hidden="true" />
          )}
          {isWarningBadge && (
            <TriangleAlert size={14} strokeWidth={2.25} aria-hidden="true" />
          )}
          <span>
            {busy === 'test'
              ? 'Checking…'
              : stateText(provider.name, status, store, unavailable)}
          </span>
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
      {showInput ? (
        <>
          <label htmlFor={`${id}-input`}>
            {stored
              ? `Replace ${provider.name} key`
              : `${provider.name} API key`}
          </label>
          <input
            ref={inputRef}
            id={`${id}-input`}
            type="password"
            className={isRejected ? 'is-rejected' : undefined}
            value={draft}
            placeholder={inputPlaceholder}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={512}
            disabled={noStore}
            aria-describedby={`${id}-state${error ? ` ${id}-error` : ''}`}
            onChange={(event) => setDraft(event.target.value)}
          />
        </>
      ) : (
        <div className="provider-key-stored">
          <span className="provider-key-mask" aria-hidden="true">
            {SAVED_KEY_MASK}
          </span>
          <span className="provider-key-stored-note">
            <span className="visually-hidden">{provider.name} key </span>
            Stored in {keyStoreLabel(store?.kind)}
          </span>
        </div>
      )}
      <div className="provider-key-actions">
        {showInput ? (
          <>
            <button
              type="submit"
              className="primary-button provider-key-btn"
              disabled={noStore || !draft.trim() || busy !== null}
            >
              {busy === 'save' ? 'Saving…' : 'Save key'}
            </button>
            {isSaved && (
              <button
                type="button"
                className="secondary-button provider-key-btn"
                disabled={busy !== null}
                onClick={cancelReplace}
              >
                Cancel
              </button>
            )}
          </>
        ) : (
          <button
            ref={replaceButtonRef}
            type="button"
            className="secondary-button provider-key-btn"
            disabled={busy !== null}
            onClick={startReplace}
          >
            Replace key
          </button>
        )}
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
