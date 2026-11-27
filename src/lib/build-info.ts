import { invoke, isTauri } from '@tauri-apps/api/core';

export type BuildInfo = {
  version: string;
  commit: string;
  dirty: boolean | null;
  profile: string;
  target: string;
  sourceDateEpoch: number | null;
};

/** Native identity only: browser previews never claim an installed version. */
export async function readBuildInfo(): Promise<BuildInfo | null> {
  return isTauri() ? invoke<BuildInfo>('build_info') : null;
}
