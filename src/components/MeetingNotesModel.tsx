import { useEffect, useId, useState } from 'react';
import {
  meetingNotesModel,
  notesModels,
  setMeetingNotesModel,
} from '../lib/meetingNotes';

/** Settings: which of the listed models writes meeting notes. It applies to
 * the next notes request; nothing is sent by choosing. */
export function MeetingNotesModel() {
  const id = useId();
  const [model, setModel] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    meetingNotesModel().then(
      (value) => live && setModel(value),
      () => live && setModel(notesModels[0].id),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="provider-key provider-language">
      <label htmlFor={`${id}-model`}>Model for meeting notes</label>
      <select
        id={`${id}-model`}
        value={model ?? notesModels[0].id}
        disabled={model === undefined}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        onChange={(event) => {
          setError('');
          setMeetingNotesModel(event.target.value).then(setModel, () =>
            setError('The choice was not changed.'),
          );
        }}
      >
        {notesModels.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label} · {option.cost}
          </option>
        ))}
      </select>
      <p id={`${id}-help`} className="provider-key-role">
        After a live session you can ask for notes written from its transcript
        with your Anthropic key, one request per meeting, shown before anything
        is sent. This picks the model for that request (now {model ?? '…'});
        cues during a session use their own, cheaper one.
      </p>
      {error && (
        <p id={`${id}-error`} className="provider-keys-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
