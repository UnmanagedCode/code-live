// The pinned Gemini Live model catalog and each model's setup requirements.
// thinkingLevel: required generationConfig.thinkingConfig.thinkingLevel.
// toolBehavior: required `behavior` on every function declaration.
export const MODELS = [
  { id: 'gemini-3.8-live', label: 'Gemini 3.8 Live' },
  { id: 'gemini-3.8-live-extended-thinking', label: 'Gemini 3.8 Live Extended Thinking', thinkingLevel: 'low', toolBehavior: 'NON_BLOCKING' },
  { id: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live Preview' },
];

export function getModel(id) {
  return MODELS.find((m) => m.id === id);
}
