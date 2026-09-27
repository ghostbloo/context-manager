import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { NormalizedRequest } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry, AutobiographicalConfig } from '../src/types/index.js';

const paths: string[] = [];
after(() => paths.forEach(path => rmSync(path, { recursive: true, force: true })));
class Probe extends AutobiographicalStrategy {
  run(chunk: Chunk, ctx: StrategyContext) { return this.compressChunkHierarchical(chunk, ctx); }
  entries() { return this.summaries; }
  seed(s: SummaryEntry) { this.pushSummary(s); }
  cap() { return this.isAtSpeculativeCap(); }
  candidates(entries: SummaryEntry[]) { return this.contiguousMergeCandidates(entries, 2); }
  setChunks(chunks: Chunk[]) { this.chunks = chunks; }
  queue(ids: string[]) { this.enqueueMerge({ level: 2, sourceIds: ids }); }
  queued() { return this.mergeQueue.length; }
}
const context = (manager: ContextManager) => (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
async function fixture(options: Partial<AutobiographicalConfig> = {}, replies = ['cyber']) {
  const requests: NormalizedRequest[] = [];
  const strategy = new Probe({
    compressionModel: 'test-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
    compressionRefusalCurveFallbacks: 0, compressionShapeFallbacks: false,
    quarantineAlarmIntervalMs: 0, compressionClassifierGapCategories: ['cyber'],
    maxSpeculativeL1s: 0, ...options,
  });
  const path = `./test-classifier-gap-${paths.length}`; paths.push(path);
  const manager = await ContextManager.open({ path, strategy, membrane: {
    complete: async (request: NormalizedRequest) => {
      requests.push(structuredClone(request));
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
      return { content: [{ type: 'text', text: reply === 'success' ? 'An accepted memory.' : 'Provider refusal must never be recalled.' }],
        stopReason: reply === 'success' ? 'end_turn' : reply === 'truncated' ? 'max_tokens' : 'refusal',
        usage: { inputTokens: 100, outputTokens: 20 },
        raw: { response: { stop_details: { category: reply } } } };
    },
  } as never });
  for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `source ${i} ` + 'detail '.repeat(30) }]);
  const all = context(manager).messageStore.getAll();
  const chunk = (start: number, end: number): Chunk => ({ index: start, startIndex: start, endIndex: end, messages: all.slice(start, end), tokens: 100, compressed: false });
  const target = chunk(0, 2);
  return { strategy, manager, requests, target, chunk, all };
}
const records = (manager: ContextManager) => manager.getStore().getStateJson('default/autobio:compression-refusal-quarantine-events');

it('allowlisted exhausted refusal creates one durable gap with exact coverage and preserves source/receipts', async () => {
  const f = await fixture();
  const before = structuredClone(f.all);
  await f.strategy.run(f.target, context(f.manager));
  const [gap] = f.strategy.entries();
  assert.equal(f.strategy.entries().length, 1);
  assert.equal(gap.classifierGap?.category, 'cyber');
  assert.equal(gap.classifierGap?.kind, 'classifier-gap');
  assert.equal(gap.classifierGap?.provisional, true);
  assert.equal(gap.classifierGap?.revisitable, true);
  assert.deepEqual(gap.sourceIds, f.target.messages.map(m => m.id));
  assert.deepEqual(gap.sourceRange, { first: gap.sourceIds[0], last: gap.sourceIds[1] });
  assert.deepEqual(gap.classifierGap?.sourceRange, gap.sourceRange);
  assert.equal(gap.classifierGap?.sourceHash, createHash('sha256').update(JSON.stringify(gap.sourceIds)).digest('hex'));
  assert.ok(gap.classifierGap?.requestHashes.length);
  assert.deepEqual(gap.classifierGap?.attempts, [{
    requestHash: gap.classifierGap?.canonicalRequestHash,
    stopReason: 'refusal',
    category: 'cyber',
  }]);
  assert.ok(gap.classifierGap?.canonicalRequestHash);
  assert.ok(gap.classifierGap?.quarantineKey);
  assert.equal(gap.responseContent, undefined);
  assert.match(gap.content, /Context Manager record/);
  assert.match(gap.content, /classifier-refused: cyber/);
  assert.doesNotMatch(gap.content, /Provider refusal/);
  assert.deepEqual(context(f.manager).messageStore.getAll(), before);
  assert.deepEqual(f.manager.getStore().getStateJson('default/autobio:summaries'), f.strategy.entries());
  const receipts = structuredClone(records(f.manager)) as Array<{ kind?: string; reason?: string }>;
  assert.ok(Array.isArray(receipts) && receipts.some((event) => event.kind === 'exhausted'));
  assert.ok(receipts.some((event) => event.kind === 'clear' && event.reason === 'classifier-gap-authorized'));
  assert.equal(f.strategy.getCompressionQuarantineStatus().count, 0, 'authorized gap pays active quarantine debt');
  await f.strategy.run(f.chunk(0, 2), context(f.manager));
  assert.equal(f.strategy.entries().length, 1);
  assert.deepEqual(records(f.manager), receipts);
});

for (const [name, categories, replies] of [
  ['absent option', undefined, ['cyber']],
  ['empty allowlist', [], ['cyber']],
  ['non-allowlisted refusal', ['other'], ['cyber']],
  ['provider success', ['cyber'], ['success']],
  ['non-refusal disposition', ['truncated'], ['truncated']],
] as const) {
  it(`${name} creates no gap`, async () => {
    const f = await fixture({ compressionClassifierGapCategories: categories }, [...replies]);
    await f.strategy.run(f.target, context(f.manager));
    assert.equal(f.strategy.entries().filter(s => s.classifierGap).length, 0);
  });
}

for (const [positionedRecallPairs, adaptiveResolution] of [[true, false], [false, false], [true, true]]) {
  it(`live and mint recall use Context Manager (positioned=${positionedRecallPairs}, adaptive=${adaptiveResolution})`, async () => {
    const f = await fixture({ positionedRecallPairs, adaptiveResolution, summaryParticipant: 'Resident' }, ['cyber', 'success']);
    await f.strategy.run(f.target, context(f.manager));
    const live = await f.manager.compile({ maxTokens: adaptiveResolution ? 350 : 200_000, reserveForResponse: 0 });
    const assertRecord = (messages: NormalizedRequest['messages']) => {
      const records = messages.filter(m => m.content.some(b => b.type === 'text' && b.text.includes('provisional classifier gap')));
      assert.ok(records.length > 0, 'gap is rendered');
      assert.ok(records.every(m => m.participant === 'Context Manager'));
      assert.ok(!messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('Provider refusal'))));
    };
    assertRecord(live.messages);
    await f.strategy.run(f.chunk(4, 6), context(f.manager));
    assertRecord(f.requests.at(-1)!.messages);
  });
}

it('gap excludes speculative debt and breaks merge topology', async () => {
  const f = await fixture();
  await f.strategy.run(f.chunk(2, 4), context(f.manager));
  const gap = f.strategy.entries()[0];
  assert.equal(f.strategy.cap(), false);
  const regular = (id: string, start: number, end: number): SummaryEntry => ({
    id, level: 1, sourceLevel: 0, content: 'memory', tokens: 5, created: 1,
    sourceIds: f.all.slice(start, end).map(m => m.id),
    sourceRange: { first: f.all[start].id, last: f.all[end - 1].id },
  });
  const left = regular('left', 0, 2), right = regular('right', 4, 6);
  f.strategy.setChunks([f.chunk(0, 6)]);
  assert.equal(f.strategy.candidates([left, gap, right]), null);
  f.strategy.seed(left);
  f.strategy.seed(right);
  f.strategy.queue([left.id, right.id]);
  f.strategy.queue([left.id, gap.id]);
  assert.equal(f.strategy.queued(), 0, 'explicit merges cannot include or span the gap');
  assert.equal(f.strategy.cap(), true, 'ordinary L1 still consumes speculative capacity');
  assert.deepEqual(f.strategy.candidates([regular('a', 0, 1), regular('b', 1, 2), gap, right])?.map(s => s.id), ['a', 'b']);
});

it('documents unresolved supersession: clearing quarantine does not bypass exact-L1 adoption', async () => {
  const f = await fixture({}, ['cyber', 'success']);
  await f.strategy.run(f.target, context(f.manager));
  const gap = f.strategy.entries()[0];
  const receipts = structuredClone(records(f.manager)) as unknown[];
  await f.strategy.clearCompressionRefusalQuarantine();
  await f.strategy.run(f.chunk(0, 2), context(f.manager));
  assert.equal(f.requests.length, 1, 'no remint API exists yet');
  assert.equal(f.strategy.entries()[0].id, gap.id);
  assert.deepEqual((records(f.manager) as unknown[]).slice(0, receipts.length), receipts, 'receipt remains append-only');
});

for (const [replies, expected] of [
  [['cyber', 'cyber'], 1],
  [['other', 'cyber'], 0],
  [['cyber', 'other'], 0],
  [['cyber', 'success'], 0],
  [['cyber', 'truncated'], 0],
] as const) {
  it(`identical refusal exhaustion requires every attempt to agree: ${replies.join(' -> ')}`, async () => {
    const f = await fixture({ compressionIdenticalRefusalRetries: 1 }, [...replies]);
    await f.strategy.run(f.target, context(f.manager));
    assert.equal(f.requests.length, 2);
    assert.equal(f.strategy.entries().filter(s => s.classifierGap).length, expected);
  });
}

it('absent and empty option keep request and live context bytes identical', async () => {
  const absent = await fixture({ compressionClassifierGapCategories: undefined }, ['success']);
  const empty = await fixture({ compressionClassifierGapCategories: [] }, ['success']);
  await absent.strategy.run(absent.target, context(absent.manager));
  await empty.strategy.run(empty.target, context(empty.manager));
  assert.equal(JSON.stringify(absent.requests), JSON.stringify(empty.requests));
  const budget = { maxTokens: 200_000, reserveForResponse: 1000 };
  const a = await absent.manager.compile(budget), b = await empty.manager.compile(budget);
  assert.equal(JSON.stringify(a.messages), JSON.stringify(b.messages));
});
