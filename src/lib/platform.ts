import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from './bridge';

/** What this build can do on its platform, as Rust reports it
 * (src-tauri/src/platform.rs). Fixed at build time; nothing is queried. */
export interface PlatformCapabilities {
  os: 'macos' | 'windows' | 'linux' | 'other';
  microphone: boolean;
  applicationAudio: boolean;
  callPrompt: boolean;
  calendarPrompts?: boolean;
  companionOverFullScreen: boolean;
}

/** The macOS build, which the browser preview stands in for. */
export const macos: PlatformCapabilities = {
  os: 'macos',
  microphone: true,
  applicationAudio: true,
  callPrompt: true,
  calendarPrompts: true,
  companionOverFullScreen: true,
};

function isCapabilities(value: unknown): value is PlatformCapabilities {
  const v = value as PlatformCapabilities;
  return (
    !!v &&
    typeof v === 'object' &&
    ['macos', 'windows', 'linux', 'other'].includes(v.os) &&
    typeof v.microphone === 'boolean' &&
    typeof v.applicationAudio === 'boolean' &&
    typeof v.callPrompt === 'boolean' &&
    typeof v.companionOverFullScreen === 'boolean'
  );
}

let known: PlatformCapabilities | null = desktop ? null : macos;
let pending: Promise<PlatformCapabilities> | null = null;

/** Asked once per launch. A build without the command (older than it) is
 * the macOS build that had no other platform. */
export function platformCapabilities(): Promise<PlatformCapabilities> {
  if (known) return Promise.resolve(known);
  pending ??= invoke<unknown>('platform_capabilities').then(
    (value) => (known = isCapabilities(value) ? value : macos),
    () => (known = macos),
  );
  return pending;
}

/** The platform if Rust has already answered, for plain functions. */
export function knownPlatform(): PlatformCapabilities | null {
  return known;
}

/** The platform, or null for the moment before Rust has answered. */
export function usePlatform(): PlatformCapabilities | null {
  const [platform, setPlatform] = useState(known);
  useEffect(() => {
    if (platform) return;
    let live = true;
    void platformCapabilities().then((value) => live && setPlatform(value));
    return () => {
      live = false;
    };
  }, [platform]);
  return platform;
}

/** "macOS", "Windows" or "Linux", as the notebook names the platform. */
export function platformName(platform: PlatformCapabilities | null) {
  switch (platform?.os) {
    case 'windows':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'other':
      return 'this system';
    default:
      return 'macOS';
  }
}

/** The device in a sentence: "your Mac", "your PC", "this computer". */
export function deviceName(platform: PlatformCapabilities | null) {
  switch (platform?.os) {
    case 'windows':
      return 'your PC';
    case 'linux':
    case 'other':
      return 'this computer';
    default:
      return 'your Mac';
  }
}

/** True once Rust has said this is not the macOS build. */
export function notMacos(platform: PlatformCapabilities | null) {
  return !!platform && platform.os !== 'macos';
}
