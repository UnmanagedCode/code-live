// A controller stand-in for component tests: the real store shape, with the
// actions recorded instead of run.
import { createStore } from '@/lib/store.js';
import type { AppController } from '@/App';
import { MODELS } from './fakeEnv';

export function fakeController(initial: Partial<ReturnType<AppController['store']['get']>> = {}) {
  const store = createStore({ state: 'idle', micPaused: false, hostConnected: false, models: MODELS, modelsError: null as string | null, modelId: MODELS[0].id, micBlocked: false, ...initial });
  const calls: string[] = [];
  const controller = {
    store,
    toggleConnect: async () => { calls.push('toggleConnect'); },
    toggleMic: () => { calls.push('toggleMic'); },
    setModel: (id: string) => { calls.push(`setModel:${id}`); store.set({ modelId: id }); },
  } as unknown as AppController;
  return { store, calls, controller };
}
