import { useRef, useState } from 'react';
import { desktop } from '../lib/bridge';
import { diagnosticsReport, type DiagnosticsInput } from '../lib/diagnostics';
import {
  cueUsage,
  keysStatus,
  transcriptionLanguage,
  transcriptionProvider,
} from '../lib/providerKeys';

/** Settings → Diagnostics: shows the report, then copies it on request.
 * Nothing is sent or saved; the clipboard is the person's to paste. */
export function Diagnostics({
  current,
}: {
  current: () => Omit<
    DiagnosticsInput,
    'keys' | 'usage' | 'language' | 'transcriptionProvider'
  >;
}) {
  const [report, setReport] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const preview = useRef<HTMLPreElement>(null);

  const show = async () => {
    setSaid('');
    const [keys, usage, provider, language] = await Promise.all([
      keysStatus().catch(() => null),
      cueUsage().catch(() => null),
      transcriptionProvider().catch(() => null),
      transcriptionLanguage().catch(() => null),
    ]);
    setReport(
      diagnosticsReport({
        ...current(),
        keys,
        usage,
        transcriptionProvider: provider,
        language,
      }),
    );
    setTimeout(() => preview.current?.focus(), 0);
  };

  const copy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      setSaid('Copied. Paste it into your report.');
    } catch {
      setSaid('Could not copy. Select the text above and copy it yourself.');
    }
  };

  return (
    <section className="setting" aria-labelledby="diagnostics-title">
      <div>
        <h2 id="diagnostics-title">Diagnostics</h2>
        <p>
          For a problem report: the app version, your settings, whether each key
          is set, and the fixed codes of what last went wrong. It contains
          nothing from a meeting: no transcript, notes, cues, focus, names,
          application or device names, and no keys. Nothing is sent; you read
          it, then copy it.
        </p>
        {report === null ? (
          <button className="secondary-button" onClick={() => void show()}>
            Show diagnostics
          </button>
        ) : (
          <>
            <pre
              ref={preview}
              className="diagnostics-report"
              tabIndex={0}
              aria-label="Diagnostics report"
            >
              {report}
            </pre>
            <div className="diagnostics-actions">
              <button className="primary-button" onClick={() => void copy()}>
                Copy diagnostics
              </button>
              <button className="secondary-button" onClick={() => void show()}>
                Refresh
              </button>
            </div>
          </>
        )}
        <p className="small muted" role="status">
          {said}
        </p>
        {!desktop && (
          <p className="small muted">
            The browser preview has no keys or sessions to report.
          </p>
        )}
      </div>
    </section>
  );
}
