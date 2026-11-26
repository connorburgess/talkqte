// Fictional metadata only. No native store, key values or network requests.
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import type { KeysStatus } from '../../src/lib/providerKeys';

const key = { state: 'notSet', verified: false } as const;
export const absent: KeysStatus = {
  deepgram: key,
  elevenlabs: key,
  anthropic: key,
  openai: key,
  gemini: key,
  anyMissing: true,
  store: { kind: 'memory', available: true },
};
export const present: KeysStatus = {
  ...absent,
  deepgram: { state: 'set', verified: false },
};
const reads: {
  resolve: (status: KeysStatus) => void;
  reject: (error: string) => void;
}[] = [];
export let calls = 0;
let mutation: Promise<KeysStatus> | undefined;
let finishMutation: ((status: KeysStatus) => void) | undefined;
export function holdMutation() {
  mutation = new Promise((resolve) => {
    finishMutation = resolve;
  });
}
export function releaseMutation() {
  const finish = finishMutation!;
  mutation = undefined;
  finish(present);
}
mockIPC(
  (command) => {
    if (command === 'provider_keys_status') {
      calls++;
      return new Promise<KeysStatus>((resolve, reject) =>
        reads.push({ resolve, reject }),
      );
    }
    if (command === 'remove_provider_key') return mutation ?? absent;
    if (['set_provider_key', 'test_provider_key'].includes(command))
      return mutation ?? present;
    throw new Error(`Unexpected fixture command: ${command}`);
  },
  { shouldMockEvents: true },
);
Object.defineProperty(window, 'isTauri', { value: true, configurable: true });
export const keys = await import('../../src/lib/providerKeys');
export function resolveRead(status: KeysStatus) {
  reads.shift()!.resolve(status);
}
export function rejectRead() {
  reads.shift()!.reject('Fictional status failure');
}
export function changed() {
  return emit('provider-keys:changed', present);
}
