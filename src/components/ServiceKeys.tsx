import { useEffect, useId, useRef, useState } from 'react';
import {
  DEFAULT_REQUEST_CAP,
  DEFAULT_SPEND_CAP_MICRO_USD,
  type KeyStatus,
  type Provider,
  type ProviderKeysController,
} from '../lib/keys';
import './service-keys.css';

interface ProviderCopy {
  id: Provider;
  name: string;
  role: string;
  whereToGet: string;
  dataStatement: string;
  removeWarning: string;
}

const PROVIDERS: ProviderCopy[] = [
  {
    id: 'deepgram',
    name: 'Deepgram',
    role: 'Transcription',
    whereToGet:
      'Deepgram Console (console.deepgram.com) → API Keys. No link is fetched by TalkQTE.',
    dataStatement:
      "Receives the session's audio (microphone or the application you chose), only after you approve cue processing for that session; at most 120 minutes per session. Billed to your own Deepgram account.",
    removeWarning: 'Live transcription will stop until a key is added again.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    role: 'Cue decisions',
    whereToGet:
      'Anthropic Console (console.anthropic.com) → API Keys. No link is fetched by TalkQTE.',
    dataStatement:
      'Receives up to six recent transcript lines, the cue on screen and earlier cues, and your session name if set, for cue decisions; never audio, your notes or focus lines. Billed to your own Anthropic account.',
    removeWarning: 'Cue decisions will stop until a key is added again.',
  },
];

function formatMicroUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

function chipLabel(keyStatus: KeyStatus, checking: boolean): string {
  if (checking) return 'Checking…';
  switch (keyStatus.state) {
    case 'notSet':
      return 'Not set';
    case 'set':
      return 'Set';
    case 'rejected':
      return 'Rejected';
  }
}

function chipClass(keyStatus: KeyStatus, checking: boolean): string {
  if (checking) return 'sk-chip is-checking';
  switch (keyStatus.state) {
    case 'set':
      return 'sk-chip is-set';
    case 'rejected':
      return 'sk-chip is-rejected';
    default:
      return 'sk-chip';
  }
}

function ProviderRow({
  provider,
  keyStatus,
  checking,
  busy,
  errorMessage,
  showWhereToGet,
  onSave,
  onTest,
  onRemove,
}: {
  provider: ProviderCopy;
  keyStatus: KeyStatus;
  checking: boolean;
  busy: boolean;
  errorMessage: string;
  showWhereToGet: boolean;
  onSave: (key: string) => Promise<boolean>;
  onTest: () => Promise<void>;
  onRemove: () => Promise<boolean>;
}) {
  const [entering, setEntering] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Keep only a non-empty flag in React state; never store the secret itself
  // in component state and clear the DOM input immediately on submit/cancel.
  const [hasInput, setHasInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const headingId = useId();

  useEffect(() => {
    if (entering) {
      inputRef.current?.focus();
    }
  }, [entering]);

  useEffect(() => {
    if (confirmingRemove) {
      cancelRemoveRef.current?.focus();
    }
  }, [confirmingRemove]);

  useEffect(() => {
    return () => {
      if (inputRef.current) inputRef.current.value = '';
    };
  }, []);

  const locked = checking || busy;
  const hasKey = keyStatus.state === 'set' || keyStatus.state === 'rejected';
  const showVerified =
    !checking && keyStatus.state === 'set' && keyStatus.verified;

  const closeEntry = () => {
    if (inputRef.current) inputRef.current.value = '';
    setHasInput(false);
    setEntering(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const raw = inputRef.current?.value ?? '';
    const trimmed = raw.trim();
    if (inputRef.current) inputRef.current.value = '';
    setHasInput(false);
    if (!trimmed) return;
    const saved = await onSave(trimmed);
    if (saved) setEntering(false);
  };

  const alertText =
    errorMessage ||
    (!checking && keyStatus.state === 'rejected'
      ? `Refused by the service. Check the key in your ${provider.name} account and replace it here.`
      : '');

  return (
    <section
      className="sk-row"
      data-provider={provider.id}
      aria-labelledby={headingId}
      aria-busy={locked || undefined}
    >
      <div className="sk-row-head">
        <div className="sk-provider">
          <h3 id={headingId}>{provider.name}</h3>
          <span className="sk-role">{provider.role}</span>
        </div>
        <div className="sk-status-group" aria-live="polite">
          <span className={chipClass(keyStatus, checking)}>
            {chipLabel(keyStatus, checking)}
          </span>
          {showVerified && <span className="sk-verified">Checked</span>}
        </div>
      </div>

      {showWhereToGet && (
        <p className="sk-where">
          <strong>Where to get one:</strong> {provider.whereToGet}
        </p>
      )}
      <p className="sk-statement">{provider.dataStatement}</p>

      {checking && (
        <p className="sk-checking-note" role="status">
          Sending one test request to {provider.name}. Controls wait until it
          finishes.
        </p>
      )}

      {alertText && (
        <div className="sk-error" role="alert">
          {alertText}
        </div>
      )}

      {!confirmingRemove && !entering && (
        <div className="sk-actions">
          {!hasKey ? (
            <button
              type="button"
              className="primary-button sk-action-button"
              disabled={locked}
              onClick={() => {
                setConfirmingRemove(false);
                setEntering(true);
              }}
            >
              Add key
            </button>
          ) : (
            <>
              <button
                type="button"
                className="secondary-button sk-action-button"
                disabled={locked}
                onClick={() => void onTest()}
              >
                Test
              </button>
              <button
                type="button"
                className="secondary-button sk-action-button"
                disabled={locked}
                onClick={() => {
                  setConfirmingRemove(false);
                  setEntering(true);
                }}
              >
                Replace
              </button>
              <button
                ref={removeButtonRef}
                type="button"
                className="secondary-button sk-action-button sk-danger-button"
                disabled={locked}
                onClick={() => {
                  closeEntry();
                  setConfirmingRemove(true);
                }}
              >
                Remove
              </button>
            </>
          )}
        </div>
      )}

      {entering && (
        <form className="sk-entry" onSubmit={(event) => void submit(event)}>
          <label className="sk-entry-label" htmlFor={inputId}>
            {provider.name} API key (clears after saving; never shown again)
          </label>
          <div className="sk-input-row">
            <input
              ref={inputRef}
              id={inputId}
              type="password"
              className="sk-password"
              placeholder="Paste key…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={locked}
              onChange={(event) =>
                setHasInput(event.target.value.trim().length > 0)
              }
            />
            <button
              type="submit"
              className="primary-button sk-action-button"
              disabled={locked || !hasInput}
            >
              Save key
            </button>
            <button
              type="button"
              className="secondary-button sk-action-button"
              disabled={locked}
              onClick={closeEntry}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {confirmingRemove && (
        <div
          className="sk-confirm"
          role="group"
          aria-label={`Confirm removing ${provider.name} key`}
        >
          <p className="sk-confirm-copy">
            <strong>Remove {provider.name} key?</strong>{' '}
            {provider.removeWarning}
          </p>
          <div className="sk-confirm-actions">
            <button
              ref={cancelRemoveRef}
              type="button"
              className="secondary-button sk-action-button"
              disabled={locked}
              onClick={() => {
                setConfirmingRemove(false);
                setTimeout(() => removeButtonRef.current?.focus(), 0);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="secondary-button sk-action-button sk-danger-button"
              disabled={locked}
              onClick={() => {
                void onRemove().then((removed) => {
                  if (removed) setConfirmingRemove(false);
                });
              }}
            >
              Remove key
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Shared Deepgram & Anthropic key rows, reused by Settings and Onboarding Step 2. */
export function ServiceKeysRows({
  keys,
  showWhereToGet = false,
}: {
  keys: ProviderKeysController;
  showWhereToGet?: boolean;
}) {
  if (!keys.loaded) {
    return (
      <p className="sk-unavailable-note" role="status">
        Checking service key status…
      </p>
    );
  }
  if (!keys.available) {
    return (
      <div className="sk-unavailable">
        <span className="sk-chip">Unavailable in this build</span>
        <p className="sk-unavailable-note">
          Service key storage is not available in this build.
        </p>
      </div>
    );
  }

  return (
    <div className="sk-rows">
      {PROVIDERS.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          keyStatus={keys.status[provider.id]}
          checking={keys.checkingProvider === provider.id}
          busy={keys.busyProvider === provider.id}
          errorMessage={keys.rowErrors[provider.id]}
          showWhereToGet={showWhereToGet}
          onSave={(key) => keys.setKey(provider.id, key)}
          onTest={() => keys.testKey(provider.id)}
          onRemove={() => keys.removeKey(provider.id)}
        />
      ))}
    </div>
  );
}

/** Settings section mounted once directly after Live transcription. */
export function ServiceKeys({ keys }: { keys: ProviderKeysController }) {
  const { usage } = keys;
  const defaultSpendCap = formatMicroUsd(DEFAULT_SPEND_CAP_MICRO_USD);

  return (
    <section
      className="setting service-keys-section"
      aria-labelledby="service-keys-heading"
    >
      <div className="sk-container">
        <div className="sk-section-head">
          <h2 id="service-keys-heading">Service keys</h2>
          {keys.loaded && !keys.available && (
            <span className="sk-chip">Unavailable in this build</span>
          )}
        </div>

        {keys.loaded && !keys.available ? (
          <p className="sk-unavailable-note">
            Service key storage is not connected to this build yet.
          </p>
        ) : (
          <>
            <p className="sk-intro">
              Add your own keys for live transcription and cue decisions. Keys
              are stored in the macOS Keychain and never shown again after
              saving; TalkQTE only displays Not set, Set, Checking…, or
              Rejected.
            </p>
            <ServiceKeysRows keys={keys} />
            {keys.available && (
              <div className="sk-session-box" aria-label="This session usage">
                <div className="sk-row-head">
                  <h3>This session</h3>
                  <span className="sk-role">
                    {usage
                      ? 'Active session · local estimate only'
                      : 'No session yet'}
                  </span>
                </div>
                {usage ? (
                  <>
                    <div className="sk-session-grid">
                      <div className="sk-stat">
                        <span className="sk-role">Anthropic requests</span>
                        <span className="sk-stat-value">
                          {usage.requests} of {usage.requestCap}
                        </span>
                      </div>
                      <div className="sk-stat">
                        <span className="sk-role">Estimated spend</span>
                        <span className="sk-stat-value">
                          Est. {formatMicroUsd(usage.spentMicroUsd)} of{' '}
                          {formatMicroUsd(usage.spendCapMicroUsd)}
                        </span>
                      </div>
                    </div>
                    <p className="sk-estimate-note">
                      Estimate calculated locally from token counts; not a bill
                      from Anthropic.
                    </p>
                  </>
                ) : (
                  <p className="sk-estimate-note">
                    No session yet · 0 of {DEFAULT_REQUEST_CAP} Anthropic
                    requests · Est. $0.00 of {defaultSpendCap} (estimate from
                    token counts, not a bill). Counts reset when a new session
                    starts.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
