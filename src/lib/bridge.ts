import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Commands, CueSnapshot, Snapshot } from './types';

export const desktop = isTauri();
// The preview adapter is for browser development only. The desktop always uses Rust.
const preview = desktop ? null : import('./preview');
let queue: Promise<unknown> = Promise.resolve();

export async function connect<T extends CueSnapshot>(
  floating: boolean,
  receive: (snapshot: T) => void,
) {
  if (preview)
    return (await preview).connect(receive as unknown as (value: Snapshot) => void);
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
