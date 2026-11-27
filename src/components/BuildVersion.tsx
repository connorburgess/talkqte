import { useEffect, useState } from 'react';
import './BuildVersion.css';
import { readBuildInfo, type BuildInfo } from '../lib/build-info';

/** Drop-in replacement for the notebook's hardcoded .version footer. */
export function BuildVersion({
  read = readBuildInfo,
}: {
  read?: () => Promise<BuildInfo | null>;
}) {
  const [info, setInfo] = useState<BuildInfo | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'preview' | 'error'>(
    'loading',
  );
  useEffect(() => {
    let active = true;
    read()
      .then((value) => {
        if (!active) return;
        setInfo(value);
        setState(value ? 'ready' : 'preview');
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [read]);
  if (state !== 'ready' || !info)
    return (
      <div className="version">
        TalkQTE{' '}
        <span>
          {state === 'preview'
            ? 'Browser preview'
            : state === 'error'
              ? 'Build identity unavailable'
              : 'Reading build identity…'}
        </span>
      </div>
    );
  const revision = /^[a-f0-9]{40}$/.test(info.commit)
    ? info.commit.slice(0, 7)
    : 'unknown source';
  const changes =
    info.dirty === true
      ? ' · modified'
      : info.dirty === null
        ? ' · changes unknown'
        : '';
  return (
    <details className="version build-version">
      <summary
        aria-label={`Build details: TalkQTE ${info.version}, ${revision}${changes}`}
      >
        TalkQTE{' '}
        <span>
          {info.version} · {revision}
          {changes}
        </span>
      </summary>
      <dl>
        <dt>Source commit</dt>
        <dd>{info.commit}</dd>
        <dt>Source changes</dt>
        <dd>
          {info.dirty === null
            ? 'Unknown'
            : info.dirty
              ? 'Uncommitted changes'
              : 'Clean at build'}
        </dd>
        <dt>Build profile</dt>
        <dd>{info.profile}</dd>
        <dt>Target</dt>
        <dd>{info.target}</dd>
        {info.sourceDateEpoch !== null && (
          <>
            <dt>Source date (UTC)</dt>
            <dd>{new Date(info.sourceDateEpoch * 1000).toISOString()}</dd>
          </>
        )}
      </dl>
    </details>
  );
}
