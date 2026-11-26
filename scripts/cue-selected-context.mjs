// Explicit API-only selected-prior mode. Importing this module grants nothing.
import { createHash } from 'node:crypto';
import {
  anthropicSystemPrompt,
  buildAnthropicParams,
} from './cue-lab-anthropic-core.mjs';
import {
  SELECTED_SNAPSHOT_RULE,
  selectedPriorContextInput,
  selectedPriorContextSchema,
} from './cue-selected-snapshot.mjs';
export {
  selectedPriorContextInput,
  selectedPriorContextReply,
} from './cue-selected-snapshot.mjs';
export const SELECTED_CONTEXT = 'selected-prior-v2';
export const SELECTED_INPUT = 'selected-prior-context-v2';
export const SELECTED_POLICY = 'fictional-lab-selected-prior-v2';
export const SELECTED_FRAME = 'talkqte.lab.selected.v2';
export const SELECTED_DESCRIPTOR = 'talkqte.lab.selected.descriptor.v2';
export const SELECTED_PROMPT =
  '576769095b06c4fdedb76d8c519d4978dc7e8e1f1f84dc6872e485aca10e81a9';
export const selectedIdentity = () => ({
  contextPolicy: SELECTED_CONTEXT,
  inputContract: SELECTED_INPUT,
  policyRevision: SELECTED_POLICY,
  promptSha256: SELECTED_PROMPT,
});
export function selectedSystemPrompt() {
  const text = anthropicSystemPrompt() + SELECTED_SNAPSHOT_RULE;
  if (createHash('sha256').update(text).digest('hex') !== SELECTED_PROMPT)
    throw new Error('selected_prompt_drift');
  return text;
}
export function buildSelectedContextParams(model, input) {
  const content = selectedPriorContextInput(input);
  const params = buildAnthropicParams(model, input);
  return {
    ...params,
    system: params.system.map((block) => ({
      ...block,
      text: selectedSystemPrompt(),
    })),
    messages: [{ role: 'user', content }],
  };
}
export function selectedContextRequest(input) {
  selectedPriorContextInput(input);
  // openLabProvider validates this raw envelope before broker settlement.
  // Keep membership/max-four strict; final state constraints apply afterward.
  const schema = selectedPriorContextSchema(input);
  schema.properties.action.enum = ['show', 'quiet', 'resolved', 'withdraw'];
  schema.properties.cue = {
    anyOf: [{ type: 'string', minLength: 1, maxLength: 240 }, { type: 'null' }],
  };
  return {
    role: 'cue-evaluator',
    instructions: selectedSystemPrompt(),
    input: structuredClone(input),
    schema,
  };
}
