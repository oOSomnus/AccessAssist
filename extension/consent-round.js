import { createChoiceSet } from './protocol.js';
import { CONSENT_TIMEOUT_MS } from './policy.js';

// Arm → ask → confirm for one pending worker proposal. A cancel confirmation is
// best effort: if it cannot be delivered, nothing ran.
// Returns { stale: true } or { choice, response }.
export async function consentRound({ send, present, newId, stale }, { tabId, proposalId, question, runLabel, keepLabel }) {
  const set = createChoiceSet({
    id: newId(),
    question,
    options: [{ label: runLabel, value: 'execute' }, { label: keepLabel, value: 'cancel' }],
  });
  await send('ARM_CONSENT', { proposalId, choiceSetId: set.id });
  if (stale()) return { stale: true };
  // Keeping things as they are is the user saying no to this change.
  const choice = await present(set, { timeoutMs: CONSENT_TIMEOUT_MS, declinable: true });
  if (stale()) return { stale: true };
  const optionValue = choice?.value === 'execute' ? 'execute' : 'cancel';
  const confirm = send('CONFIRM_PROPOSAL', { tabId, proposalId, choiceSetId: set.id, optionValue });
  const response = optionValue === 'execute' ? await confirm : await confirm.catch(() => ({}));
  return { choice, response };
}
