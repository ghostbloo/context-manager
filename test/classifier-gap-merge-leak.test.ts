import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { NormalizedRequest } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';
const paths: string[] = []; after(() => paths.forEach(p => rmSync(p, { recursive: true, force: true })));
class Probe extends AutobiographicalStrategy {
  run(c: Chunk, ctx: StrategyContext) { return this.compressChunkHierarchical(c, ctx); }
  entries(): SummaryEntry[] { return this.summaries; }
  setChunks(c: Chunk[]) { this.chunks = c; }
  merge(level: number, ids: string[], ctx: StrategyContext) { return this.executeMerge(level, ids, ctx); }
}
const context = (m: ContextManager) => (m as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
for (const mergeSourceOnly of [true, false]) for (const headWindowTokens of [0, 4000]) {
  it(`L2 merge across a gap never re-sends the gap's raw source (mergeSourceOnly=${mergeSourceOnly}, head=${headWindowTokens})`, async () => {
    const requests: NormalizedRequest[] = [];
    let n = 0;
    const strategy = new Probe({ compressionModel: 'm', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens, autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0, mergeThreshold: 99, compressionRefusalCurveFallbacks: 0, compressionShapeFallbacks: false, compressionSourceOnly: true,
      compressionMergeSourceOnly: mergeSourceOnly, compressionMarker: false, compressionClassifierGapCategories: ['cyber'], quarantineAlarmIntervalMs: 0 } as never);
    const path = `./test-classifier-gap-merge-leak-${paths.length}`; paths.push(path);
    const manager = await ContextManager.open({ path, strategy, membrane: { complete: async (r: NormalizedRequest) => {
      requests.push(structuredClone(r));
      const refused = JSON.stringify(r.messages).includes('GAPRAW') && !JSON.stringify(r.messages).includes('Consolidate') && n++ >= 0;
      return refused
        ? { content: [], stopReason: 'refusal', usage: { inputTokens: 1, outputTokens: 0 }, raw: { response: { stop_details: { category: 'cyber' } } } }
        : { content: [{ type: 'text', text: 'ok memory' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 5 }, raw: { response: {} } };
    } } as never });
    for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `${i >= 2 && i < 4 ? 'GAPRAW' : 'plain'} ${i} ` + 'detail '.repeat(30) }]);
    const all = context(manager).messageStore.getAll();
    const chunk = (s: number, e: number): Chunk => ({ index: s, startIndex: s, endIndex: e, messages: all.slice(s, e), tokens: 100, compressed: false });
    strategy.setChunks([chunk(0, 2), chunk(2, 4), chunk(4, 6)]);
    for (const [s, e] of [[0, 2], [2, 4], [4, 6]] as const) await strategy.run(chunk(s, e), context(manager));
    const l1 = strategy.entries().filter(x => x.level === 1);
    assert.equal(l1.filter(x => x.classifierGap).length, 1, 'middle chunk became a gap');
    const ordinary = l1.filter(x => !x.classifierGap).map(x => x.id);
    const before = requests.length;
    await strategy.merge(2, ordinary, context(manager));
    const mergeReq = requests.slice(before);
    assert.equal(mergeReq.length, 1, 'one merge request');
    const body = JSON.stringify(mergeReq[0]!.messages);
    assert.ok(body.includes('classifier-refused: cyber'), 'gap record rendered');
    assert.ok(!body.includes('GAPRAW'), 'refused raw source NOT re-sent in merge');
  });
}
