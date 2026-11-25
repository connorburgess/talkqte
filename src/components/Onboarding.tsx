import { useEffect, useRef, useState } from 'react';
import { ProviderKeysRows } from './ProviderKeys';
import { keyStoreLabel, keysStatus, type KeyStore } from '../lib/providerKeys';
import {
  deviceName,
  notMacos,
  platformName,
  usePlatform,
  type PlatformCapabilities,
} from '../lib/platform';
import './onboarding.css';

type Step = 1 | 2 | 3 | 4;

interface OnboardingProps {
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
  canStartLive,
  onSkip,
  onFinish,
  onStartLive,
}: OnboardingProps) {
  const [step, setStep] = useState<Step>(1);
  const [keyStore, setKeyStore] = useState<KeyStore>();
  const platform = usePlatform();
  const other = notMacos(platform);
  const device = deviceName(platform);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const confirmSkipButtonRef = useRef<HTMLButtonElement>(null);

  // Which store keeps the keys on this platform, for step 2's label.
  useEffect(() => {
    let live = true;
    keysStatus().then(
      (status) => live && setKeyStore(status?.store),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

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

  const meta =
    step === 1 && other
      ? { ...STEP_META[1], badge: `Alpha · ${platformName(platform)}` }
      : step === 3 && other
        ? {
            ...STEP_META[3],
            heading: 'What TalkQTE will use later',
          }
        : step === 2
          ? {
              ...STEP_META[2],
              badge:
                keyStore && !keyStore.available
                  ? 'No keyring on this system'
                  : `Stored in ${keyStoreLabel(keyStore?.kind)}`,
            }
          : STEP_META[step];

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
              className={`ob-chip${meta.badgeClass ? ` ${meta.badgeClass}` : ''}`}
            >
              {meta.badge}
            </span>
          )}
        </header>

        <div className="ob-body">
          {/* The page's one level-one heading while setup is shown. */}
          <h1
            id="onboarding-step-heading"
            ref={headingRef}
            tabIndex={-1}
            className="ob-h2"
          >
            {meta.heading}
          </h1>

          {step === 1 && (
            <>
              <p className="ob-lead">
                TalkQTE sits beside your meeting on {platformName(platform)} and
                surfaces one short, source-backed cue when a moment matters. It
                does not join the call as a participant. TalkQTE is in alpha.
              </p>
              {other && platform && <PlatformLimits platform={platform} />}

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
                    <div className="ob-card-head">
                      <strong>Free</strong>
                      <span className="ob-chip is-set">Alpha</span>
                    </div>
                    <p>
                      With your own keys. Add your Deepgram or ElevenLabs key
                      and a key for your cue provider (Anthropic, OpenAI, or
                      Gemini) in the next step; you pay them directly for what
                      you use, and audio and text go from {device} to those
                      providers.
                    </p>
                  </div>
                  <div className="ob-way is-disabled" aria-disabled="true">
                    <div className="ob-card-head">
                      <strong>Pro</strong>
                      <span className="ob-chip">Planned</span>
                    </div>
                    <p>
                      Pay as you go: top up credit and pay per meeting hour. No
                      keys, no subscription. Not available yet; pricing to be
                      announced.
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
              <ProviderKeysRows showWhereToGet />
            </>
          )}

          {step === 3 && other && platform && (
            <OtherPlatformPermissions platform={platform} />
          )}

          {step === 3 && !other && (
            <>
              <p className="ob-lead">
                macOS asks for permissions when you actually use a source, not
                TalkQTE and not on this screen. Nothing is captured or requested
                here.
              </p>

              <div className="ob-perm-card">
                <div className="ob-card-head">
                  <h2>Microphone</h2>
                  <span className="ob-card-meta">
                    Asked on first session start
                  </span>
                </div>
                <p>
                  Needed so TalkQTE can listen to your voice when you start a
                  live session or microphone check. macOS shows the system
                  prompt the first time you start.
                </p>
              </div>

              <div className="ob-perm-card">
                <div className="ob-card-head">
                  <h2>Screen &amp; System Audio Recording</h2>
                  <span className="ob-card-meta">
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
                Nothing leaves {device} when you press Start live session. You
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
                    names both services explicitly:{' '}
                    <strong>Deepgram or ElevenLabs</strong> (session audio for
                    transcription, up to 120 minutes per session) and your
                    chosen cue provider — <strong>Anthropic</strong>,{' '}
                    <strong>OpenAI</strong>, or <strong>Gemini</strong> (up to
                    six recent transcript lines, the cue on screen and earlier
                    cues, and your session name if set, for cue decisions; never
                    audio, your notes or focus lines).
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
        <h2 id="ob-skip-title">Skip setup for now?</h2>
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

/** Step 1 on Windows and Linux: what this build does not do yet, before the
 * person adds keys. */
function PlatformLimits({ platform }: { platform: PlatformCapabilities }) {
  const name = platformName(platform);
  return (
    <div className="ob-perm-card" aria-label={`What the ${name} build does`}>
      <div className="ob-card-head">
        <h2>The {name} test build</h2>
        <span className="ob-chip">Unsigned · not checked on hardware</span>
      </div>
      <p>
        Live sessions here hear your microphone only. Hearing another
        application, such as the app your call is in, is not available on {name}{' '}
        yet; with headphones, the microphone hears your side of a call only. The
        offer to start when a call begins is macOS-only for now, and the
        companion stays on top of other windows but may not show over a
        full-screen meeting. This build has not yet been checked on a real{' '}
        {platform.os === 'windows' ? 'Windows PC' : 'Linux machine'}.
      </p>
    </div>
  );
}

/** Step 3 on Windows and Linux: there is no access prompt to expect. */
function OtherPlatformPermissions({
  platform,
}: {
  platform: PlatformCapabilities;
}) {
  const name = platformName(platform);
  return (
    <>
      <p className="ob-lead">
        {name} does not ask TalkQTE for microphone access with a prompt, and
        nothing is captured or requested on this screen.
      </p>
      <div className="ob-perm-card">
        <div className="ob-card-head">
          <h2>Microphone</h2>
          <span className="ob-card-meta">Used from session start</span>
        </div>
        <p>
          {platform.os === 'windows'
            ? 'TalkQTE uses your default input from Settings → System → Sound. If Settings → Privacy & security → Microphone does not let desktop apps use the microphone, a session cannot start until you turn that on.'
            : 'TalkQTE uses the default input from your sound settings, through ALSA (PipeWire or PulseAudio on a desktop). It is opened only when you start a live session or microphone check.'}
        </p>
      </div>
      <div className="ob-perm-card">
        <div className="ob-card-head">
          <h2>Application audio</h2>
          <span className="ob-chip">Not available on {name} yet</span>
        </div>
        <p>
          Hearing one application, instead of or beside your microphone, is
          macOS-only for now. Live sessions on {name} use the microphone only.
        </p>
      </div>
    </>
  );
}
