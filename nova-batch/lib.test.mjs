// Run with:  node --test
// Tests the pure logic in lib.mjs — no network, no Supabase, no Ollama.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextSummary,
  buildQuestionPrompt,
  buildWardrobeDescriptions,
  localDateStr,
  needsDescription,
  normalizeQuestionsDoc,
  pendingQuestions,
  photoKey,
  summarizeFinance,
  summarizeGoals,
  summarizeWorkouts,
  truncate,
} from './lib.mjs';

const NOW = new Date('2026-07-06T12:00:00'); // local time, mid-day

// ---------- wardrobe cache ----------

test('needsDescription: new item with photos → true', () => {
  assert.equal(needsDescription({ id: 'a', photo_paths: ['items/x.jpg'] }), true);
});

test('needsDescription: cached and unchanged → false', () => {
  const item = { id: 'a', photo_paths: ['items/x.jpg'], description: 'a shirt', described_photos: 'items/x.jpg' };
  assert.equal(needsDescription(item), false);
});

test('needsDescription: photo added after caching → true', () => {
  const item = { id: 'a', photo_paths: ['items/x.jpg', 'items/y.jpg'], description: 'a shirt', described_photos: 'items/x.jpg' };
  assert.equal(needsDescription(item), true);
});

test('needsDescription: no photos → false, even without description', () => {
  assert.equal(needsDescription({ id: 'a', photo_paths: [] }), false);
  assert.equal(needsDescription({ id: 'a' }), false);
});

test('photoKey ignores empty slots', () => {
  assert.equal(photoKey({ photo_paths: ['a.jpg', null, 'b.jpg'] }), 'a.jpg|b.jpg');
});

// ---------- finance summary ----------

test('summarizeFinance: empty → friendly placeholder', () => {
  assert.match(summarizeFinance(null, NOW), /no transaction data/i);
  assert.match(summarizeFinance({ transactions: [] }, NOW), /no transaction data/i);
});

test('summarizeFinance: sums by currency, expenses negative, top categories', () => {
  const doc = {
    transactions: [
      { id: '1', amount: -50, currency: 'EUR', date: '2026-07-01', tags: ['food'] },
      { id: '2', amount: -30, currency: 'EUR', date: '2026-07-02', tags: ['food'] },
      { id: '3', amount: -20, currency: 'EUR', date: '2026-07-03', tags: ['transport'] },
      { id: '4', amount: 1000, currency: 'EUR', date: '2026-07-01', tags: [] },
      { id: '5', amount: -999, currency: 'EUR', date: '2020-01-01', tags: ['old'] }, // outside 30d
    ],
  };
  const s = summarizeFinance(doc, NOW);
  assert.match(s, /4 transactions in EUR/);
  assert.match(s, /spent 100\.00/);
  assert.match(s, /income 1000\.00/);
  assert.match(s, /food 80/);
  assert.ok(!s.includes('old'), 'transactions outside the window are excluded');
});

test('summarizeFinance: data exists but none recent', () => {
  const doc = { transactions: [{ id: '1', amount: -5, currency: 'EUR', date: '2020-01-01', tags: [] }] };
  assert.match(summarizeFinance(doc, NOW), /none in the last 30 days/);
});

// ---------- workout summary ----------

test('summarizeWorkouts: empty → placeholder', () => {
  assert.match(summarizeWorkouts(null, NOW), /no workouts/i);
});

test('summarizeWorkouts: counts recent sessions and last date', () => {
  const doc = {
    entries: [
      { id: '1', date: '2026-07-05', routineName: 'Push', exercises: [] },
      { id: '2', date: '2026-07-03', routineName: 'Pull', exercises: [] },
      { id: '3', date: '2026-07-01', routineName: 'Push', exercises: [] },
      { id: '4', date: '2025-01-01', routineName: 'Legs', exercises: [] },
    ],
  };
  const s = summarizeWorkouts(doc, NOW);
  assert.match(s, /3 sessions on 3 days/);
  assert.match(s, /Push ×2/);
  assert.match(s, /Last workout: 2026-07-05 \(1 day ago\)/);
});

test('summarizeWorkouts: old data only → says so', () => {
  const doc = { entries: [{ id: '1', date: '2025-01-01', routineName: 'Legs' }] };
  const s = summarizeWorkouts(doc, NOW);
  assert.match(s, /No sessions in the last 4 weeks/);
  assert.match(s, /Last workout: 2025-01-01/);
});

// ---------- goals summary ----------

test('summarizeGoals: empty → placeholder', () => {
  assert.match(summarizeGoals(null, NOW), /no to-do data/i);
  assert.match(summarizeGoals({ other_key: 1 }, NOW), /no to-do data/i);
});

test('summarizeGoals: counts, open-today list, tags', () => {
  const data = {
    'goals:2026-07-06': [
      { text: 'Ship the report', done: false, tags: ['work'] },
      { text: 'Buy groceries', done: true, tags: [] },
    ],
    'goals:2026-07-01': [{ text: 'Call mum', done: true, tags: ['family'] }],
    'goals:2020-01-01': [{ text: 'Ancient goal', done: false, tags: ['stale'] }],
    biweekly_list_v1: [{ text: 'not a day list' }],
  };
  const s = summarizeGoals(data, NOW);
  assert.match(s, /2 of 3 completed/);
  assert.match(s, /Ship the report \[work\]/);
  assert.ok(!s.includes('Ancient goal'), 'items older than 2 weeks are excluded');
  assert.match(s, /work ×1/);
});

// ---------- context assembly + prompt ----------

test('buildContextSummary stitches sections and caps length', () => {
  const s = buildContextSummary({ finance: 'F', workouts: 'W', goals: 'G' }, NOW);
  assert.match(s, /as of 2026-07-06/);
  assert.match(s, /F\n\nW\n\nG/);
  const big = buildContextSummary({ finance: 'x'.repeat(9000), workouts: 'W', goals: 'G' }, NOW);
  assert.ok(big.length <= 6000);
});

test('buildWardrobeDescriptions maps only described items and truncates', () => {
  const items = [
    { id: 'a', category: 'shirt', description: 'd'.repeat(1000) },
    { id: 'b', category: 'shoes' }, // no description yet
    null,
  ];
  const out = buildWardrobeDescriptions(items);
  assert.deepEqual(Object.keys(out), ['a']);
  assert.ok(out.a.description.length <= 400);
});

test('buildQuestionPrompt includes context, wardrobe and question; caps wardrobe block', () => {
  const wd = {};
  for (let i = 0; i < 100; i++) wd['id' + i] = { category: 'shirt', description: 'blue shirt '.repeat(10) };
  const p = buildQuestionPrompt('What should I wear?', 'CONTEXT HERE', wd);
  assert.match(p, /You are Nova/);
  assert.match(p, /CONTEXT HERE/);
  assert.match(p, /Question: What should I wear\?$/);
  assert.match(p, /more items omitted/);
});

test('buildQuestionPrompt works with no wardrobe and no context', () => {
  const p = buildQuestionPrompt('Hi?', '', {});
  assert.match(p, /No dashboard context is available yet/);
  assert.ok(!p.includes('Wardrobe ('));
});

// ---------- questions queue ----------

test('normalizeQuestionsDoc: garbage in, safe shape out, extras preserved', () => {
  assert.deepEqual(normalizeQuestionsDoc(null), { queue: [] });
  assert.deepEqual(normalizeQuestionsDoc({ queue: 'nope' }), { queue: [] });
  const doc = normalizeQuestionsDoc({ queue: [null, { id: 1, question: 'q' }, 'junk'], extra: 'kept' });
  assert.equal(doc.queue.length, 1);
  assert.equal(doc.extra, 'kept');
});

test('pendingQuestions: filters to pending-with-text, ordered by asked_at', () => {
  const doc = normalizeQuestionsDoc({
    queue: [
      { id: 'b', question: 'second', status: 'pending', asked_at: '2026-07-06T10:00:00Z' },
      { id: 'a', question: 'first', status: 'pending', asked_at: '2026-07-06T09:00:00Z' },
      { id: 'c', question: 'done', status: 'answered', asked_at: '2026-07-06T08:00:00Z' },
      { id: 'd', status: 'pending' }, // no question text
    ],
  });
  assert.deepEqual(pendingQuestions(doc).map((q) => q.id), ['a', 'b']);
});

// ---------- misc ----------

test('truncate caps long strings with an ellipsis', () => {
  assert.equal(truncate('hello', 10), 'hello');
  const t = truncate('x'.repeat(50), 10);
  assert.equal(t.length, 10);
  assert.ok(t.endsWith('…'));
});

test('localDateStr formats local dates', () => {
  assert.equal(localDateStr(new Date(2026, 6, 6, 23, 59)), '2026-07-06');
});
