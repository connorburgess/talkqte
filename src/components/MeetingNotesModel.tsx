import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  meetingNotesModel,
  notesModelsFor,
  setMeetingNotesModel,
} from '../lib/meetingNotes';
import {
  cueProviderName,
  defaultNotesModelFor,
  setNotesModelOverride,
  type CueProvider,
  type ProviderPreferences,
} from '../lib/providerKeys';

/** Settings: which curated or custom model writes meeting notes for the active
 * provider. Applies to the next notes request; nothing is sent by choosing. */
export function MeetingNotesModel({
  provider = 'anthropic',
  prefs,
  onChange,
}: {
  provider?: CueProvider;
  prefs?: ProviderPreferences | null;
  onChange?: (next: ProviderPreferences) => void;
}) {
  const id = useId();
  const options = notesModelsFor(provider);
  const testedDefault = defaultNotesModelFor(provider);
  const [model, setModel] = useState<string>();
  const [customDraft, setCustomDraft] = useState(
    prefs?.effectiveNotesCustom ? (prefs.notesModelOverride ?? '') : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (prefs) {
      setModel(prefs.effectiveNotesModel);
      setCustomDraft(
        prefs.effectiveNotesCustom ? (prefs.notesModelOverride ?? '') : '',
      );
      return;
    }
    let live = true;
    meetingNotesModel().then(
      (value) => live && setModel(value),
      () => live && setModel(options[0].id),
    );
    return () => {
      live = false;
    };
  }, [prefs, options]);

  const effective = model ?? options[0].id;
  const isCurated = options.some((option) => option.id === effective);

  const selectCurated = async (nextId: string) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const saved = await setMeetingNotesModel(nextId);
      setModel(saved);
      if (prefs && onChange) {
        onChange({
          ...prefs,
          notesModel: saved,
          notesModelOverride: saved === testedDefault ? null : saved,
          effectiveNotesModel: saved,
          effectiveNotesCustom: false,
        });
      }
      setCustomDraft('');
      setNote(`Meeting notes model set to ${saved}.`);
    } catch {
      setError('The choice was not changed.');
    } finally {
      setBusy(false);
    }
  };

  const saveCustom = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNote('');
    try {
      const trimmed = customDraft.trim();
      const updated = await setNotesModelOverride(trimmed || null);
      setModel(updated.effectiveNotesModel);
      onChange?.(updated);
      setNote(
        updated.effectiveNotesCustom
          ? `Custom meeting notes model saved: ${updated.effectiveNotesModel}.`
          : `Using tested default meeting notes model: ${updated.effectiveNotesModel}.`,
      );
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : 'The custom model ID was not saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="provider-key provider-language" onSubmit={saveCustom}>
      <label htmlFor={`${id}-model`}>Model for meeting notes</label>
      <select
        id={`${id}-model`}
        value={isCurated ? effective : '__custom__'}
        disabled={model === undefined || busy}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        onChange={(event) => {
          if (event.target.value !== '__custom__') {
            void selectCurated(event.target.value);
          }
        }}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label} · {option.cost}
          </option>
        ))}
        {!isCurated && <option value="__custom__">Custom: {effective}</option>}
      </select>
      <label htmlFor={`${id}-custom-model`}>
        Custom meeting notes model ID (optional)
      </label>
      <input
        id={`${id}-custom-model`}
        type="text"
        value={customDraft}
        maxLength={96}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        disabled={model === undefined || busy}
        placeholder={`Leave blank for tested default (${testedDefault})`}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        onChange={(event) => setCustomDraft(event.target.value)}
      />
      <div className="provider-key-actions">
        <button
          type="submit"
          className="secondary-button provider-key-btn"
          disabled={model === undefined || busy}
        >
          Save notes model
        </button>
        {prefs?.notesModelOverride && (
          <button
            type="button"
            className="secondary-button provider-key-btn"
            disabled={busy}
            onClick={() => {
              setCustomDraft('');
              void selectCurated(testedDefault);
            }}
          >
            Use tested default
          </button>
        )}
      </div>
      <p id={`${id}-help`} className="provider-key-role">
        Generates notes from a transcript using your {cueProviderName(provider)}{' '}
        key (one request, plus one reviewed retry after failed validation; now{' '}
        {model ?? '…'}). Leave custom blank for the curated model; cost
        estimates are unavailable for custom IDs.
      </p>
      {error ? (
        <p id={`${id}-error`} className="provider-keys-error" role="alert">
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
  );
}
