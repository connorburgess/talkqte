import { useEffect, useRef, useState } from 'react';
import type { ServiceKeysController } from '../lib/keys';
import { ServiceKeysRows } from './ServiceKeys';
import './onboarding.css';

type Step = 1 | 2 | 3 | 4;

interface OnboardingProps {
  keys: ServiceKeysController;
  canStartLive: boolean;
  onSkip: () => void;
  onFinish: () => void;
  onStartLive: () => void;
}

const STEP_META: Record<
  Step,
  { badge: string; badgeClass?: string; heading: string; nextLabel?: string }
> = {
  1: {
    badge: 'Alpha · macOS',
    heading: 'One quiet cue beside your live call',
    nextLabel: 'Next: Your keys',
  },
  2: {
    badge: 'Stored in macOS Keychain',
    heading: 'Connect your service keys',
    nextLabel: 'Next: Permissions',
  },
  3: {
    badge: 'Nothing requested here',
    heading: 'What macOS will ask later',
    nextLabel: 'Next: First session',
  },
  4: {
    badge: 'Ready to start',
    badgeClass: 'is-set',
    heading: 'How a live session starts and stops',
  },
};

export function Onboarding({
  keys,
  canStartLive,
  onSkip,
  onFinish,
  onStartLive,
}: OnboardingProps) {
  const [step, setStep] = useState<Step>(1);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const confirmSkipButtonRef = useRef<HTMLButtonElement>(null);

  // Move keyboard and screen-reader focus to the step heading on mount and on
  // every step change.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // Escape anywhere during onboarding asks to confirm skipping setup.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirmSkip) return;
      event.preventDefault();
      setConfirmSkip(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmSkip]);

  // Open/close the native modal dialog and keep focus inside it while open.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirmSkip) {
      if (!dialog.open) dialog.showModal();
      keepButtonRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [confirmSkip]);

  const closeSkipDialog = () => {
    setConfirmSkip(false);
    headingRef.current?.focus();
  };

  const meta = STEP_META[step];

  return (
    <section
      className="onboarding-flow"
      aria-label="TalkQTE setup"
      aria-labelledby="onboarding-step-heading"
    >
      <div className="ob-canvas">
        <header className="ob-head">
          <span className="ob-step-indicator">Step {step} of 4</span>
          {step === 2 ? (
            <span className="ob-head-note">{meta.badge}</span>
          ) : (
            <span
              className={`sk-chip${meta.badgeClass ? ` ${meta.badgeClass}` : ''}`}
            >
              {meta.badge}
            </span>
          )}
        </header>

        <div className="ob-body">
          <h2
            id="onboarding-step-heading"
            ref={headingRef}
            tabIndex={-1}
            className="ob-h2"
          >
            {meta.heading}
          </h2>

          {step === 1 && (
            <>
              <p className="ob-lead">
                TalkQTE sits beside your meeting on macOS and surfaces one
                short, source-backed cue when a moment matters. It does not join
                the call as a participant. TalkQTE is in alpha.
              </p>

              <div className="ob-cue-card" aria-label="Fictional example cue">
                <div className="ob-cue-top">
                  <span className="ob-cue-lead">
                    <span className="ob-cue-dot" aria-hidden="true" />
                    Context · Fictional example
                  </span>
                  <span className="ob-cue-x" aria-hidden="true">
                    ×
                  </span>
                </div>
                <p className="ob-cue-statement">
                  Earlier, legal said review takes two days.
                </p>
                <div className="ob-cue-track" aria-hidden="true">
                  <span className="ob-cue-fill" />
                </div>
                <div className="ob-cue-source">
                  <span className="ob-cue-source-label">
                    From the conversation (fictional)
                  </span>
                  <p className="ob-cue-source-quote">
                    “Can we commit to Friday?”
                  </p>
                </div>
              </div>

              <div className="ob-ways">
                <span className="ob-ways-label">Two ways to use TalkQTE</span>
                <div className="ob-ways-grid">
                  <div className="ob-way is-active">
                    <div className="sk-row-head">
                      <strong>Use your own keys</strong>
                      <span className="sk-chip is-set">Active · BYOK</span>
                    </div>
                    <p>
                      Add your own Deepgram and Anthropic keys in the next step.
                      Audio and approved text go directly from your Mac to those
                      providers.
                    </p>
                  </div>
                  <div className="ob-way is-disabled" aria-disabled="true">
                    <div className="sk-row-head">
                      <strong>TalkQTE Hosted</strong>
                      <span className="sk-chip">Coming later</span>
                    </div>
                    <p>
                      Paid service with no keys to manage. Not available yet;
                      not selectable in alpha.
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="ob-lead">
                <strong>
                  Test is the only action in setup that sends anything over the
                  network, and only when you press it.
                </strong>{' '}
                You can skip either key now and add it later in Settings.
              </p>
              <ServiceKeysRows keys={keys} showWhereToGet />
            </>
          )}

          {step === 3 && (
            <>
              <p className="ob-lead">
                macOS asks for permissions when you actually use a source, not
                TalkQTE and not on this screen. Nothing is captured or requested
                here.
              </p>

              <div className="ob-perm-card">
                <div className="sk-row-head">
                  <h3>Microphone</h3>
                  <span className="sk-role">Asked on first session start</span>
                </div>
                <p>
                  Needed so TalkQTE can listen to your voice when you start a
                  live session or microphone check. macOS shows the system
                  prompt the first time you start.
                </p>
              </div>

              <div className="ob-perm-card">
                <div className="sk-row-head">
                  <h3>Screen &amp; System Audio Recording</h3>
                  <span className="sk-role">
                    Only if choosing application audio
                  </span>
                </div>
                <p>
                  Needed only if you choose to capture one application's audio
                  (all of its windows) instead of your microphone. macOS asks
                  when you first list applications to choose one.
                </p>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <p className="ob-lead">
                Nothing leaves your Mac when you press Start live session. You
                approve each session before anything is sent, and Stop ends the
                session and stops sending.
              </p>

              <div className="ob-perm-card">
                <span className="ob-sequence-label">
                  Per-session approval sequence
                </span>
                <ol className="ob-sequence-list">
                  <li>
                    <strong>Start live session</strong> opens the floating dock
                    and starts local capture only. Audio captured before
                    approval is discarded.
                  </li>
                  <li>
                    <strong>
                      Review processing → Review selected sources → Enable for
                      this session
                    </strong>{' '}
                    names both services explicitly: <strong>Deepgram</strong>{' '}
                    (session audio for transcription) and{' '}
                    <strong>Anthropic</strong> (recent transcript lines and
                    selected notes for cue decisions).
                  </li>
                  <li>
                    <strong>Stop</strong> ends the session, releases the
                    microphone or application audio source, and stops sending.
                  </li>
                </ol>
              </div>
            </>
          )}
        </div>

        <footer className="ob-foot">
          <button
            type="button"
            className="secondary-button ob-foot-button"
            onClick={onSkip}
          >
            Skip setup
          </button>
          <div className="ob-foot-group">
            <button
              type="button"
              className="secondary-button ob-foot-button"
              disabled={step === 1}
              onClick={() => setStep((current) => (current - 1) as Step)}
            >
              Back
            </button>
            {step < 4 ? (
              <button
                type="button"
                className="primary-button ob-foot-button"
                onClick={() => setStep((current) => (current + 1) as Step)}
              >
                {meta.nextLabel}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="secondary-button ob-foot-button"
                  onClick={onFinish}
                >
                  Go to the notebook
                </button>
                <button
                  type="button"
                  className="primary-button ob-foot-button"
                  disabled={!canStartLive}
                  onClick={onStartLive}
                >
                  Start live session
                </button>
              </>
            )}
          </div>
        </footer>
      </div>

      <dialog
        ref={dialogRef}
        className="ob-skip-dialog"
        aria-labelledby="ob-skip-title"
        onCancel={(event) => {
          event.preventDefault();
          closeSkipDialog();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const first = keepButtonRef.current;
          const last = confirmSkipButtonRef.current;
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h3 id="ob-skip-title">Skip setup for now?</h3>
        <p>
          You can add your keys or run through these four steps again any time
          from Settings → Set up TalkQTE again.
        </p>
        <div className="ob-skip-actions">
          <button
            ref={keepButtonRef}
            type="button"
            className="secondary-button ob-foot-button"
            onClick={closeSkipDialog}
          >
            Keep setting up
          </button>
          <button
            ref={confirmSkipButtonRef}
            type="button"
            className="primary-button ob-foot-button"
            onClick={() => {
              setConfirmSkip(false);
              onSkip();
            }}
          >
            Skip setup
          </button>
        </div>
      </dialog>
    </section>
  );
}
