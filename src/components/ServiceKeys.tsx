import { useEffect, useId, useRef, useState } from 'react';
import type { KeyProvider, KeyState, ServiceKeysController } from '../lib/keys';
import './service-keys.css';

interface ProviderCopy {
  id: KeyProvider;
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
      "Receives the session's audio, only after you approve cue processing for that session. Billed to your own Deepgram account.",
    removeWarning: 'Live transcription will stop until a key is added again.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    role: 'Cue decisions',
    whereToGet:
      'Anthropic Console (console.anthropic.com) → API Keys. No link is fetched by TalkQTE.',
    dataStatement:
      'Receives recent transcript lines and any notes you approve, for cue decisions. Billed to your own Anthropic account.',
    removeWarning: 'Cue decisions will stop until a key is added again.',
  },
];

function chipLabel(state: KeyState): string {
  switch (state.status) {
    case 'not_set':
      return 'Not set';
    case 'set':
      return 'Set';
    case 'checking':
      return 'Checking…';
    case 'rejected':
      return 'Rejected';
  }
}

function chipClass(state: KeyState): string {
  switch (state.status) {
    case 'set':
      return 'sk-chip is-set';
    case 'checking':
      return 'sk-chip is-checking';
    case 'rejected':
      return 'sk-chip is-rejected';
    default:
      return 'sk-chip';
  }
}

function rejectionHeadline(reason: 'refused' | 'unreachable'): string {
  return reason === 'refused'
    ? 'Refused by the service.'
    : 'Could not reach the service.';
}

function ProviderRow({
  provider,
  state,
  busy,
  showWhereToGet,
  onSave,
  onTest,
  onRemove,
}: {
  provider: ProviderCopy;
  state: KeyState;
  busy: boolean;
  showWhereToGet: boolean;
  onSave: (secret: string) => Promise<boolean>;
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

  const checking = state.status === 'checking' || busy;
  const hasKey =
    state.status === 'set' ||
    state.status === 'checking' ||
    state.status === 'rejected';

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

  return (
    <section
      className="sk-row"
      data-provider={provider.id}
      aria-labelledby={headingId}
      aria-busy={checking || undefined}
    >
      <div className="sk-row-head">
        <div className="sk-provider">
          <h3 id={headingId}>{provider.name}</h3>
          <span className="sk-role">{provider.role}</span>
        </div>
        <span className={chipClass(state)} aria-live="polite">
          {chipLabel(state)}
        </span>
      </div>

      {showWhereToGet && (
        <p className="sk-where">
          <strong>Where to get one:</strong> {provider.whereToGet}
        </p>
      )}
      <p className="sk-statement">{provider.dataStatement}</p>

      {state.status === 'checking' && (
        <p className="sk-checking-note" role="status">
          Sending one test request to {provider.name}. Controls wait until it
          finishes.
        </p>
      )}

      {state.status === 'rejected' && (
        <div className="sk-error" role="alert">
          <strong>{rejectionHeadline(state.reason)}</strong>{' '}
          {state.message && state.message !== rejectionHeadline(state.reason)
            ? state.message
            : state.reason === 'refused'
              ? `Check the key in your ${provider.name} account and replace it here.`
              : 'Check your internet connection and try Test again.'}
        </div>
      )}

      {!confirmingRemove && !entering && (
        <div className="sk-actions">
          {!hasKey ? (
            <button
              type="button"
              className="primary-button sk-action-button"
              disabled={checking}
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
                disabled={checking}
                onClick={() => void onTest()}
              >
                Test
              </button>
              <button
                type="button"
                className="secondary-button sk-action-button"
                disabled={checking}
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
                disabled={checking}
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
              disabled={checking}
              onChange={(event) =>
                setHasInput(event.target.value.trim().length > 0)
              }
            />
            <button
              type="submit"
              className="primary-button sk-action-button"
              disabled={checking || !hasInput}
            >
              Save key
            </button>
            <button
              type="button"
              className="secondary-button sk-action-button"
              disabled={checking}
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
              disabled={checking}
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
              disabled={checking}
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
  keys: ServiceKeysController;
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
      {keys.error && (
        <div className="sk-error" role="alert">
          {keys.error}
        </div>
      )}
      {PROVIDERS.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          state={keys.status[provider.id]}
          busy={keys.busyProvider === provider.id}
          showWhereToGet={showWhereToGet}
          onSave={(secret) => keys.setKey(provider.id, secret)}
          onTest={() => keys.testKey(provider.id)}
          onRemove={() => keys.removeKey(provider.id)}
        />
      ))}
    </div>
  );
}

/** Settings section mounted once directly after Live transcription. */
export function ServiceKeys({ keys }: { keys: ServiceKeysController }) {
  const { usage } = keys;
  const spend = `Est. $${usage.estimatedSpendUsd.toFixed(2)}`;
  const showActiveUsage = usage.active || usage.anthropicRequests > 0;

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
        <p className="sk-intro">
          Add your own keys for live transcription and cue decisions. Keys are
          stored in the macOS Keychain and never shown again after saving;
          TalkQTE only displays Not set, Set, Checking…, or Rejected.
        </p>

        {keys.loaded && !keys.available ? (
          <p className="sk-unavailable-note">
            Unavailable in this build. Key storage is not connected to this
            build yet.
          </p>
        ) : (
          <>
            <ServiceKeysRows keys={keys} />
            {keys.available && (
              <div className="sk-session-box" aria-label="This session usage">
                <div className="sk-row-head">
                  <h3>This session</h3>
                  <span className="sk-role">
                    {showActiveUsage
                      ? 'Active session · local estimate only'
                      : 'No session yet'}
                  </span>
                </div>
                {showActiveUsage ? (
                  <>
                    <div className="sk-session-grid">
                      <div className="sk-stat">
                        <span className="sk-role">Anthropic requests</span>
                        <span className="sk-stat-value">
                          {usage.anthropicRequests} of {usage.anthropicCap}
                        </span>
                      </div>
                      <div className="sk-stat">
                        <span className="sk-role">Per-session cap</span>
                        <span className="sk-stat-value">
                          {usage.anthropicCap} requests
                        </span>
                      </div>
                      <div className="sk-stat">
                        <span className="sk-role">Estimated spend</span>
                        <span className="sk-stat-value">{spend}</span>
                      </div>
                    </div>
                    <p className="sk-estimate-note">
                      Estimate calculated locally from token counts; not a bill
                      from Anthropic.
                    </p>
                  </>
                ) : (
                  <p className="sk-estimate-note">
                    No session yet · 0 of {usage.anthropicCap} Anthropic
                    requests · {spend} (estimate from token counts, not a bill).
                    Counts reset when a new session starts.
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
