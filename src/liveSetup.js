// The Live session setup minted into every ephemeral token. The token's setup
// is authoritative: the browser's own {setup:{}} cannot alter it.
import { getModel } from './models.js';
import { toolDeclarations } from './tools.js';

export const SYSTEM_PROMPT = [
  'You are a voice interface to code-conductor, a tool that runs Claude coding sessions.',
  'Use the tools to work with conductor sessions only; you cannot reach worker sessions.',
  'A message starting with "CONDUCTOR UPDATE" is the active conductor\'s finished reply: speak it naturally.',
  'Read short replies in full. Summarize long, markdown-heavy or code-heavy replies in a few sentences and offer to go into details.',
  'When a tool result has activeTargetChanged, tell the user which session is now active.',
  'When a tool result has ok:false, explain the problem briefly.',
].join('\n');

export function buildSetup(modelId, resumeHandle) {
  const model = getModel(modelId);
  if (!model) throw Object.assign(new Error(`unknown model: ${modelId}`), { code: 'UNKNOWN_MODEL' });
  const generationConfig = { responseModalities: ['AUDIO'] };
  if (model.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: model.thinkingLevel };
  return {
    model: `models/${model.id}`,
    generationConfig,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    tools: [{ functionDeclarations: toolDeclarations(model) }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    contextWindowCompression: { slidingWindow: {} },
  };
}
