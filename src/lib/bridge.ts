import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  Commands,
  CueSnapshot,
  LiveStatus,
  ModelStatus,
  Snapshot,
} from './types';

export const desktop = isTauri();
// The preview adapter is for browser development only. The desktop always uses Rust.
const preview = desktop ? null : import('./preview');
let queue: Promise<unknown> = Promise.resolve();

export async function connect<T extends CueSnapshot>(
  floating: boolean,
  receive: (snapshot: T) => void,
) {
  if (preview)
    return (await preview).connect(
      receive as unknown as (value: Snapshot) => void,
    );
  const unlisten = await listen<T>(
    floating ? 'cue:changed' : 'session:changed',
    ({ payload }) => receive(payload),
  );
  try {
    receive(await invoke<T>('snapshot'));
  } catch (error) {
    unlisten();
    throw error;
  }
  return unlisten;
}

export function command<K extends keyof Commands>(name: K, args?: Commands[K]) {
  const result = queue.then(async () => {
    if (preview) return (await preview).command(name, args);
    return invoke<void>(name, args);
  });
  queue = result.catch(() => {});
  return result;
}

export async function liveStatus() {
  if (preview) return (await preview).liveStatus();
  return invoke<LiveStatus>('live_status');
}

/** Reports the optional speech model download and its later changes. */
export async function watchModel(receive: (status: ModelStatus) => void) {
  if (preview) {
    receive((await preview).modelStatus());
    return () => {};
  }
  const unlisten = await listen<ModelStatus>('model:changed', ({ payload }) =>
    receive(payload),
  );
  try {
    receive(await invoke<ModelStatus>('model_status'));
  } catch (error) {
    unlisten();
    throw error;
  }
  return unlisten;
}

export async function exportPreview() {
  await queue;
  return preview
    ? (await preview).exportPreview()
    : invoke<string>('export_preview');
}

export async function exportMarkdown() {
  if (preview) return (await preview).exportMarkdown();
  return invoke<boolean>('export_markdown');
}
