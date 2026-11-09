import { Check, ChevronRight } from 'lucide-react';
import type { ContextItem, ModelStatus } from '../lib/types';

/** What the card can send the person to. */
export type SetupTarget = 'name' | 'focus' | 'context';

/**
 * The short path to a first useful session: a name, what matters today,
 * the speech model when the build can use one, and prior notes. Nothing
 * here is stored between launches, so the card returns each launch until
 * the person has done the steps or put it away for the session.
 */
export function SetupCard({
  name,
  focus,
  model,
  items,
  busy,
  onGoTo,
  onDownload,
  onDismiss,
}: {
  name: string | null;
  focus: string[];
  model: ModelStatus | null;
  items: ContextItem[];
  busy: boolean;
  onGoTo: (target: SetupTarget) => void;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  const modelStep =
    model && ['missing', 'downloading', 'installed'].includes(model.status);
  const modelDone = model?.status === 'installed';
  const steps: {
    key: string;
    title: string;
    done: boolean;
    detail: string;
    action: string;
    onAction: () => void;
    optional?: boolean;
  }[] = [
    {
      key: 'name',
      title: 'Your name',
      done: !!name,
      detail: name
        ? `Questions put to ${name} by name will stay longer.`
        : 'So a question asked of you by name stays while you answer.',
      action: 'Add your name',
      onAction: () => onGoTo('name'),
    },
    {
      key: 'focus',
      title: 'What matters today',
      done: focus.length > 0,
      detail:
        focus.length > 0
          ? `${focus.length} ${focus.length === 1 ? 'line' : 'lines'} set.`
          : 'A few short lines; the companion can then show only those.',
      action: 'Write the focus',
      onAction: () => onGoTo('focus'),
    },
  ];
  if (modelStep) {
    steps.push({
      key: 'model',
      title: 'Speech model',
      done: modelDone,
      detail: modelDone
        ? `${model.name} is installed on this device.`
        : model.status === 'downloading'
          ? `Downloading, ${Math.round(
              model.sizeBytes ? (model.received / model.sizeBytes) * 100 : 0,
            )}%.`
          : `${Math.round(model.sizeBytes / 1_000_000)} MB, fetched once over HTTPS and kept on this device; needed for a live session.`,
      action: 'Download speech model',
      onAction: onDownload,
    });
  }
  steps.push({
    key: 'context',
    title: 'Prior notes',
    done: items.length > 0,
    detail:
      items.length > 0
        ? `${items.length} ${items.length === 1 ? 'note' : 'notes'} chosen.`
        : 'Optional: notes from Granola or a file, reminded once when mentioned.',
    action: 'Choose notes',
    onAction: () => onGoTo('context'),
    optional: true,
  });
  return (
    <section className="setup-card" aria-labelledby="setup-card-title">
      <div className="meeting-line">
        <strong id="setup-card-title">Set up in a minute</strong>
        <button className="text-button" onClick={onDismiss} disabled={busy}>
          Not now
        </button>
      </div>
      <ol className="setup-steps">
        {steps.map((step) => (
          <li key={step.key} className={step.done ? 'done' : undefined}>
            <span className="setup-mark" aria-hidden="true">
              {step.done ? <Check size={14} /> : null}
            </span>
            <div>
              <strong>
                {step.title}
                {step.optional && !step.done && (
                  <span className="muted small"> · optional</span>
                )}
                <span className="visually-hidden">
                  {step.done ? ', done' : ', to do'}
                </span>
              </strong>
              <p className="small muted">{step.detail}</p>
              {!step.done &&
                !(step.key === 'model' && model?.status === 'downloading') && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={step.onAction}
                  >
                    {step.action}
                    <ChevronRight size={14} />
                  </button>
                )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
