import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './bridge';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'deferred'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'error';

export type UpdateHoldReason =
  'liveSession' | 'microphone' | 'applicationAudio' | 'dictation';

export interface AvailableUpdate {
  version: string;
  notes?: string;
  published?: string;
}

export interface UpdateStatus {
  currentVersion: string;
  configured: boolean;
  checkAtLaunch: boolean;
  labRun: boolean;
  phase: UpdatePhase;
  hold: UpdateHoldReason | null;
  available: AvailableUpdate | null;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
}

export async function updateStatus(): Promise<UpdateStatus | null> {
  if (!desktop) return null;
  return invoke<UpdateStatus>('update_status');
}

export async function watchUpdates(
  receive: (status: UpdateStatus) => void,
): Promise<() => void> {
  if (!desktop) return () => {};
  let receivedEvent = false;
  const unlisten = await listen<UpdateStatus>(
    'updates:changed',
    ({ payload }) => {
      receivedEvent = true;
      receive(payload);
    },
  );
  try {
    const initial = await invoke<UpdateStatus>('update_status');
    if (!receivedEvent) receive(initial);
  } catch (error) {
    if (!receivedEvent) {
      unlisten();
      throw error;
    }
  }
  return unlisten;
}

export async function setCheckForUpdatesAtLaunch(
  enabled: boolean,
): Promise<UpdateStatus> {
  return invoke<UpdateStatus>('set_check_for_updates_at_launch', { enabled });
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>('check_for_updates');
}

export async function downloadAndInstallUpdate(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>('download_and_install_update');
}
