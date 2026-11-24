import { invoke } from '@tauri-apps/api/core';
import { desktop } from './bridge';

/** Notebook panel sizes as the settings file keeps them; null follows the
 * window's width. */
export interface PanelSizes {
  sidebarWidth: number | null;
  notesRatio: number | null;
}

/** Whether the person's choices are being saved, and the last failure. */
export interface SettingsStatus {
  saving: 'on' | 'labRun' | 'unavailable' | 'newer';
  error?: string;
}

const noSizes: PanelSizes = { sidebarWidth: null, notesRatio: null };

/** The saved panel sizes; none in the browser preview, which saves nothing. */
export async function savedPanelSizes(): Promise<PanelSizes> {
  if (!desktop) return noSizes;
  try {
    return { ...noSizes, ...(await invoke<PanelSizes>('panel_sizes')) };
  } catch {
    return noSizes;
  }
}

let pending: ReturnType<typeof setTimeout> | undefined;

/** Saves the panel sizes once a drag or slider has settled, so a drag
 * writes the file once rather than at every pixel. */
export function savePanelSizes(panels: PanelSizes, delayMs = 400) {
  if (!desktop) return;
  clearTimeout(pending);
  pending = setTimeout(() => {
    void invoke('set_panel_sizes', { panels }).catch(() => {});
  }, delayMs);
}

export async function settingsStatus(): Promise<SettingsStatus | null> {
  if (!desktop) return null;
  try {
    return await invoke<SettingsStatus>('settings_status');
  } catch {
    return null;
  }
}

/** Deletes the settings file; every setting returns to its default. */
export async function resetSettings() {
  clearTimeout(pending);
  await invoke('reset_settings');
}
