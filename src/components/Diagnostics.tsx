import { useRef, useState } from 'react';
import { desktop } from '../lib/bridge';
import { diagnosticsReport, type DiagnosticsInput } from '../lib/diagnostics';
import {
  cueUsage,
  keysStatus,
  providerPreferences,
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
    'keys' | 'usage' | 'language' | 'transcriptionProvider' | 'preferences'
  >;
}) {
  const [report, setReport] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const preview = useRef<HTMLPreElement>(null);

  const show = async () => {
    setSaid('');
    const [keys, usage, provider, language, preferences] = await Promise.all([
      keysStatus().catch(() => null),
      cueUsage().catch(() => null),
      transcriptionProvider().catch(() => null),
      transcriptionLanguage().catch(() => null),
      providerPreferences().catch(() => null),
    ]);
    setReport(
      diagnosticsReport({
        ...current(),
        keys,
        usage,
        transcriptionProvider: provider,
        language,
        preferences,
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
          Version, settings, key status, and error codes only—never transcripts,
          notes, cues, focus, names, apps, or keys. Nothing is sent; review
          before copying.
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
