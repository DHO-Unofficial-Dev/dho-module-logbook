import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRegionSpeed, normalizeRegionStats, regionStatsAverage, MAX_REGION_STAT_SEGMENTS } from '../module/lib/region-stats.js';
import { appendRegion, normalizeRegions, maxRegionVisits, seasonAt } from '../module/lib/log.js';

const epoch = Date.UTC(2005, 2, 16, 4, 30);
const visit = (regionId = 'a', at = epoch) => ({ regionId, name: regionId, at });
function sample(state, at, speedKnots, extra = {}) {
  return applyRegionSpeed(state.regions, state.runtime, { at, speedKnots, live: true, sailing: true, season: seasonAt(at), ...extra });
}
const start = () => ({ regions: [visit()], runtime: null });
const last = (state) => state.regions.at(-1).stats.segments.at(-1);

test('시간 가중 사다리꼴 평균과 0 속도, 입력 불변', () => {
  const original = start();
  let state = sample(original, epoch, 0);
  assert.equal(regionStatsAverage(last(state)), null);
  state = sample(state, epoch + 2000, 20);
  state = sample(state, epoch + 10_000, 10);
  assert.equal(regionStatsAverage(last(state)), 14);
  assert.deepEqual([last(state).min, last(state).max, last(state).samples], [0, 20, 3]);
  assert.equal(last(state).durationMs, 10_000);
  assert.deepEqual(original, start());
});

test('중복·역순은 표본을 늘리지 않으며 긴 공백을 적분하지 않는다', () => {
  let state = sample(start(), epoch, 10);
  for (const at of [epoch, epoch - 1]) {
    const result = sample(state, at, 90);
    assert.equal(result.changed, false);
    assert.equal(result.regions, state.regions);
  }
  state = sample(state, epoch + 10_001, 30);
  assert.equal(regionStatsAverage(last(state)), null);
  state = sample(state, epoch + 20_001, 10);
  assert.equal(regionStatsAverage(last(state)), 20);
});

test('stale·입항·없는 속도는 연결을 끊고 누적값은 보존한다', () => {
  for (const extra of [{ live: false }, { sailing: false }, { speedKnots: null }, { speedKnots: -1 }, { speedKnots: NaN }, { speedKnots: Infinity }]) {
    let state = sample(start(), epoch, 10);
    state = sample(state, epoch + 1000, 20, extra);
    assert.equal(state.changed, false);
    state = sample(state, epoch + 2000, 30);
    assert.equal(last(state).samples, 2);
    assert.equal(regionStatsAverage(last(state)), null);
  }
});

test('계절 변경은 같은 방문 안에서 나누며 재진입만 방문을 늘린다', () => {
  const boundaryAt = epoch + 9 * 3600_000;
  let state = sample(start(), boundaryAt - 1000, 10);
  state = sample(state, boundaryAt, 20);
  assert.equal(state.boundary, true);
  assert.deepEqual(state.regions[0].stats.segments.map((s) => s.season), ['summer', 'winter']);
  assert.equal(state.regions.length, 1);
  assert.equal(maxRegionVisits(state.regions), 1);
  assert.equal(appendRegion(state.regions, visit('a', boundaryAt)), state.regions);
  state.regions = appendRegion(state.regions, visit('b', boundaryAt + 1));
  state = sample(state, boundaryAt + 1, 30);
  state.regions = appendRegion(state.regions, visit('a', boundaryAt + 2));
  state = sample(state, boundaryAt + 2, 40);
  assert.equal(maxRegionVisits(state.regions), 2);
  assert.equal(last(state).samples, 1);
  assert.equal(regionStatsAverage(last(state)), null);
});

test('저장 복원은 통계만 보존하고 복원 전 관측과 연결하지 않는다', () => {
  let state = sample(start(), epoch, 10);
  state = sample(state, epoch + 1000, 20);
  const regions = normalizeRegions(JSON.parse(JSON.stringify(state.regions)));
  assert.deepEqual(regions, state.regions);
  state = sample({ regions, runtime: null }, epoch + 2000, 30);
  assert.equal(last(state).durationMs, 1000);
  assert.equal(last(state).samples, 3);
  assert.equal(regionStatsAverage(last(state)), 15);
  assert.equal(sample({ regions, runtime: null }, epoch + 1000, 50).changed, false);
  assert.deepEqual(normalizeRegions([visit()]), [visit()]);
  assert.equal(normalizeRegionStats({ segments: [{ min: -1 }] }), null);
  assert.deepEqual(normalizeRegions(regions.map((region) => ({ ...region, stats: JSON.stringify(region.stats) }))), regions);
  assert.equal(normalizeRegionStats('{'), null);
  assert.equal(normalizeRegionStats(' '.repeat(16_385)), null);
});

test('계절 구간 상한은 방문 개수와 별개로 적용한다', () => {
  let state = start();
  for (let i = 0; i < 20; i += 1) state = sample(state, epoch + i * 9 * 3600_000, i);
  assert.equal(state.regions.length, 1);
  assert.equal(state.regions[0].stats.segments.length, MAX_REGION_STAT_SEGMENTS);
  assert.equal(normalizeRegions(state.regions)[0].stats.segments.length, MAX_REGION_STAT_SEGMENTS);
});

test('해역 항해일수는 첫 표본 미집계, 같은 일수 0, 증가분 누적이다', () => {
  let state = sample(start(), epoch, 10, { sailingDays: 8, counterId: 'v1' });
  assert.equal(last(state).sailingDays, null);
  state = sample(state, epoch + 1000, 10, { sailingDays: 8, counterId: 'v1' });
  assert.equal(last(state).sailingDays, 0);
  state = sample(state, epoch + 2000, 10, { sailingDays: 9, counterId: 'v1' });
  state = sample(state, epoch + 3000, 10, { sailingDays: 11, counterId: 'v1' });
  assert.equal(last(state).sailingDays, 3);
});

test('해역 항해일수는 감소·항차 변경·불가 표본·counter 누락을 건너뛴다', () => {
  for (const interruption of [
    { sailingDays: 2, counterId: 'v1' },
    { sailingDays: 20, counterId: 'v2' },
    { sailingDays: null, counterId: 'v1' },
    { sailingDays: -1, counterId: 'v1' },
    { sailingDays: NaN, counterId: 'v1' },
    { sailingDays: Infinity, counterId: 'v1' },
    { sailingDays: 20 },
    { sailingDays: 20, counterId: '' },
  ]) {
    let state = sample(start(), epoch, 10, { sailingDays: 8, counterId: 'v1' });
    state = sample(state, epoch + 1000, 10, interruption);
    assert.equal(last(state).sailingDays, null);
  }
  let state = sample(start(), epoch, 10, { sailingDays: 8, counterId: 'v1' });
  state = sample(state, epoch + 1000, 10, { sailingDays: null, counterId: 'v1' });
  state = sample(state, epoch + 2000, 10, { sailingDays: 10, counterId: 'v1' });
  assert.equal(last(state).sailingDays, null);
  state = sample(state, epoch + 3000, 10, { sailingDays: 0, counterId: 'v1' });
  state = sample(state, epoch + 4000, 10, { sailingDays: 1, counterId: 'v1' });
  assert.equal(last(state).sailingDays, 1);
});

test('해역 항해일수는 공백·held·계절 변경·재입장·복원 사이를 잇지 않는다', () => {
  const first = () => sample(start(), epoch, 10, { sailingDays: 8, counterId: 'v1' });
  let state = sample(first(), epoch + 10_001, 10, { sailingDays: 9, counterId: 'v1' });
  assert.equal(last(state).sailingDays, null);
  state = sample(first(), epoch + 1000, 10, { sailingDays: 9, counterId: 'v1', live: false });
  state = sample(state, epoch + 2000, 10, { sailingDays: 10, counterId: 'v1' });
  assert.equal(last(state).sailingDays, null);
  state = sample(first(), epoch + 1000, 10, { sailingDays: 9, counterId: 'v1', season: 'winter' });
  assert.equal(last(state).sailingDays, null);
  state = first();
  state.regions = appendRegion(appendRegion(state.regions, visit('b', epoch + 1)), visit('a', epoch + 2));
  state = sample(state, epoch + 1000, 10, { sailingDays: 9, counterId: 'v1' });
  assert.equal(last(state).sailingDays, null);
  state = first();
  state.runtime = null;
  state = sample(state, epoch + 1000, 10, { sailingDays: 9, counterId: 'v1' });
  assert.equal(last(state).sailingDays, null);
});

test('항해일수 저장 문자열 호환과 잘못된 값 정규화', () => {
  let state = sample(start(), epoch, 10, { sailingDays: 8, counterId: 'v1' });
  state = sample(state, epoch + 1000, 10, { sailingDays: 9, counterId: 'v1' });
  assert.deepEqual(normalizeRegionStats(JSON.stringify(state.regions[0].stats)), state.regions[0].stats);
  for (const sailingDays of [null, -1, NaN, Infinity, '3']) {
    assert.equal(normalizeRegionStats({ segments: [{ ...last(state), sailingDays }] }).segments[0].sailingDays, null);
  }
  const old = { ...last(state) };
  delete old.sailingDays;
  assert.deepEqual(normalizeRegionStats({ segments: [old] }), { segments: [old] });
});
