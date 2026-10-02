// Pins: VOICES is exactly the documented prebuilt-voice list, names are
// unique, and isVoice matches a name exactly (case-sensitive).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICES, isVoice } from '../src/voices.js';

test('the catalog is exactly the documented prebuilt voices', () => {
  assert.deepEqual(VOICES.map((v) => `${v.name} ${v.style}`), [
    'Zephyr Bright', 'Puck Upbeat', 'Charon Informative', 'Kore Firm', 'Fenrir Excitable', 'Leda Youthful',
    'Orus Firm', 'Aoede Breezy', 'Callirrhoe Easy-going', 'Autonoe Bright', 'Enceladus Breathy', 'Iapetus Clear',
    'Umbriel Easy-going', 'Algieba Smooth', 'Despina Smooth', 'Erinome Clear', 'Algenib Gravelly',
    'Rasalgethi Informative', 'Laomedeia Upbeat', 'Achernar Soft', 'Alnilam Firm', 'Schedar Even', 'Gacrux Mature',
    'Pulcherrima Forward', 'Achird Friendly', 'Zubenelgenubi Casual', 'Vindemiatrix Gentle', 'Sadachbia Lively',
    'Sadaltager Knowledgeable', 'Sulafat Warm',
  ]);
});

test('voice names are unique', () => {
  assert.equal(new Set(VOICES.map((v) => v.name)).size, VOICES.length);
});

test('isVoice is exact and case-sensitive', () => {
  assert.equal(isVoice('Puck'), true);
  for (const bad of ['puck', 'PUCK', 'Puck ', 'Nope', '', null, undefined, 7]) assert.equal(isVoice(bad), false, String(bad));
});
