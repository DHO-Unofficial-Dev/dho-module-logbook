// 입출항 없는 Navigator 항차 전환 잇기(canContinueLeg). Navigator 항차는 측량 판독이 몇 초 끊겨도 바뀐다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyEvent, applyVoyage, emptyState } from '../module/lib/log.js';

const LISBON = { poiId: 'poi-lisbon', name: '리스본' };
const LONDON = { poiId: 'poi-london', name: '런던' };
const SEVILLE = { poiId: 'poi-seville', name: '세비야' };
const placeMap = { 'poi-lisbon': LISBON, 'poi-london': LONDON, 'poi-seville': SEVILLE };
const toKnots = (unitsPerSecond) => unitsPerSecond;

let revision = 0;
function ev(kind, data, at) {
  revision += 1;
  return { kind, eventId: `c${revision}`, revision, occurredAtUnixMillis: at, confidence: 0.9, data };
}

function snap(voyageId, lastSailingDays, extra = {}) {
  return {
    voyageId, state: 'underway', lastSailingDays, distanceTravelled: 840, elapsedMillis: 100_000,
    startedAtUnixMillis: 500, emittedAtUnixMillis: 9_000, ...extra,
  };
}
const tracking = (voyageId, at, extra = {}) => snap(voyageId, 0, { trackingQuality: 'tracking', emittedAtUnixMillis: at, ...extra });
const stale = (voyageId, at, extra = {}) => snap(voyageId, 0, { trackingQuality: 'stale', emittedAtUnixMillis: at, ...extra });

function run(steps, initial = emptyState()) {
  let state = initial;
  for (const step of steps) {
    const result = step.kind
      ? applyEvent(state, step, placeMap[step.data?.nearestPoiId] ?? null)
      : applyVoyage(state, step, toKnots);
    state = result.state;
  }
  return state;
}

// 리스본 출항 → 정상 판독 → 3초 판독 끊김(입출항 없음) → Navigator가 v2로 바꿈
const departAndInterrupt = () => [
  ev('voyage.started', { voyageId: 'v1' }, 10_000),
  ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }, 10_000),
  tracking('v1', 40_000, { distanceTravelled: 60, elapsedMillis: 30_000 }),
  stale('v1', 41_000, { distanceTravelled: 60, elapsedMillis: 31_000 }),
];

test('입출항 없이 Navigator 항차만 바뀌면 같은 뱃길로 이어 한 기록으로 남긴다(포르투 → 비아나두카스텔루 실기기)', () => {
  const state = run([
    ...departAndInterrupt(),
    ev('voyage.ended', { voyageId: 'v1' }, 43_000),
    ev('voyage.started', { voyageId: 'v2' }, 43_000),
    tracking('v2', 58_000, { distanceTravelled: 30, elapsedMillis: 15_000 }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 59_000),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].recordId, 'v1');
  assert.equal(state.records[0].voyageId, 'v2');
  assert.deepEqual(state.records[0].from, LISBON);
  assert.deepEqual(state.records[0].to, LONDON);
  // 거리·시간을 합친 평균(90 / 46초)
  assert.equal(state.records[0].distance, 90);
  assert.equal(state.records[0].knots, 90 / 46);
});

test('끊긴 뒤 좌표가 먼저 돌아와 같은 항차 정상 판독이 끼어도 잇는다(Navigator 항해일수 판독 대기)', () => {
  const state = run([
    ...departAndInterrupt(),
    // 좌표만 먼저 복구: 아직 v1, tracking. 항해일수를 읽은 다음 판독에서 v2로 바뀐다.
    tracking('v1', 43_000, { distanceTravelled: 62, elapsedMillis: 33_000 }),
    ev('voyage.ended', { voyageId: 'v1' }, 44_000),
    ev('voyage.started', { voyageId: 'v2' }, 44_000),
    tracking('v2', 58_000, { distanceTravelled: 30, elapsedMillis: 14_000 }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 59_000),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].recordId, 'v1');
  assert.deepEqual(state.records[0].from, LISBON);
  assert.deepEqual(state.records[0].to, LONDON);
  assert.equal(state.records[0].distance, 92);
});

test('이어 붙인 뒤 처음 항차 ID의 낡은 snapshot이 와도 합친 기록을 덮지 않는다', () => {
  const first = run([
    ...departAndInterrupt(),
    ev('voyage.ended', { voyageId: 'v1' }, 43_000),
    ev('voyage.started', { voyageId: 'v2' }, 43_000),
    tracking('v2', 58_000, { distanceTravelled: 30, elapsedMillis: 15_000 }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 59_000),
  ]);
  const restarted = { ...emptyState(), records: first.records };
  const stale1 = applyVoyage(restarted, snap('v1', 0, { distanceTravelled: 60, elapsedMillis: 31_000 }), toKnots);
  assert.equal(stale1.changed, false);
  assert.equal(stale1.state.records[0].distance, 90);
});

test('snapshot이 voyage.started보다 먼저 새 항차를 알려도 입출항이 없으면 잇는다', () => {
  const state = run([
    ...departAndInterrupt(),
    tracking('v2', 44_000, { distanceTravelled: 30, elapsedMillis: 15_000 }),
    ev('voyage.ended', { voyageId: 'v1' }, 44_100),
    ev('voyage.started', { voyageId: 'v2' }, 44_100),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 59_000),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].recordId, 'v1');
  assert.deepEqual(state.records[0].to, LONDON);
});

test('두 번 연속 이어져도 거리·시간을 모두 합친다', () => {
  const state = run([
    ...departAndInterrupt(),
    ev('voyage.ended', { voyageId: 'v1' }, 43_000),
    ev('voyage.started', { voyageId: 'v2' }, 43_000),
    tracking('v2', 58_000, { distanceTravelled: 30, elapsedMillis: 15_000 }),
    stale('v2', 59_000, { distanceTravelled: 30, elapsedMillis: 16_000 }),
    ev('voyage.ended', { voyageId: 'v2' }, 61_000),
    ev('voyage.started', { voyageId: 'v3' }, 61_000),
    tracking('v3', 71_000, { distanceTravelled: 10, elapsedMillis: 10_000 }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 72_000),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].distance, 100);
  // 31초 + 16초 + 10초
  assert.equal(state.records[0].knots, 100 / 57);
});

test('거점을 모르는 입항(상륙지 등) 뒤 정박하고 바뀐 항차는 잇지 않는다', () => {
  const state = run([
    ev('voyage.started', { voyageId: 'v1' }, 10_000),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }, 10_000),
    tracking('v1', 40_000),
    ev('shore.arrived', { shoreContext: 'field', nearestPoiId: null }, 41_000),
    stale('v1', 42_000),
    ev('voyage.ended', { voyageId: 'v1' }, 45_000),
    ev('voyage.started', { voyageId: 'v2' }, 45_000),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].recordId, 'v1');
  assert.equal(state.records[0].final, true);
  assert.equal(state.current.recordId, 'v2');
});

test('판독 끊김이 15초가 넘은 뒤 바뀐 항차(입항 판정을 놓친 정박)는 잇지 않는다', () => {
  const state = run([
    ...departAndInterrupt(),
    stale('v1', 70_000),
    ev('voyage.ended', { voyageId: 'v1' }, 80_000),
    ev('voyage.started', { voyageId: 'v2' }, 80_000),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].to, null);
  assert.equal(state.current.recordId, 'v2');
});

test('판독이 정상인 채 바다에서 새 항차를 직접 시작하면 잇지 않는다', () => {
  const state = run([
    ev('voyage.started', { voyageId: 'v1' }, 10_000),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }, 10_000),
    tracking('v1', 40_000),
    ev('voyage.ended', { voyageId: 'v1' }, 41_000),
    ev('voyage.started', { voyageId: 'v2' }, 41_000),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.current.recordId, 'v2');
});

test('항해일수가 줄어든 새 항차는 판독 끊김 직후여도 잇지 않는다', () => {
  const state = run([
    ev('voyage.started', { voyageId: 'v1' }, 10_000),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }, 10_000),
    snap('v1', 5, { trackingQuality: 'tracking', emittedAtUnixMillis: 40_000 }),
    snap('v1', 5, { trackingQuality: 'stale', emittedAtUnixMillis: 41_000 }),
    snap('v2', 0, { trackingQuality: 'tracking', emittedAtUnixMillis: 44_000 }),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].recordId, 'v1');
  assert.equal(state.current.recordId, 'v2');
});

test('출항 판정이 기다리고 있으면 잇지 않는다', () => {
  const state = run([
    ...departAndInterrupt(),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 43_000),
    ev('voyage.ended', { voyageId: 'v1' }, 43_000),
    ev('voyage.started', { voyageId: 'v2' }, 43_000),
  ]);
  assert.equal(state.records.length, 1);
  assert.deepEqual(state.current.from, LONDON);
});

test('ended만 오고 started가 늦으면 끝난 때로 확정하고 그 사이 입항은 붙이지 않는다', () => {
  const state = run([
    ...departAndInterrupt(),
    ev('voyage.ended', { voyageId: 'v1' }, 43_000),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 50_000),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].arrivedAt, 43_000);
  assert.equal(state.records[0].to, null);
  assert.equal(state.current, null);
});

test('snapshot으로 연(켠 직후) 항차는 판독 끊김이 있어도 잇지 않는다', () => {
  const state = run([
    tracking('v1', 40_000),
    stale('v1', 41_000),
    tracking('v2', 44_000),
  ]);
  assert.equal(state.current.recordId, 'v2');
  assert.equal(state.records.length, 1);
});

test('이어 붙인 기록은 재시작 뒤 지금 항차 snapshot으로 다시 찾아 이어 간다', () => {
  const first = run([
    ...departAndInterrupt(),
    ev('voyage.ended', { voyageId: 'v1' }, 43_000),
    ev('voyage.started', { voyageId: 'v2' }, 43_000),
    tracking('v2', 58_000, { distanceTravelled: 30, elapsedMillis: 15_000 }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 59_000),
  ]);
  // 재시작: 지금 항차를 잃고 기록만 남았다. snapshot은 v2(정박).
  const restarted = { ...emptyState(), records: first.records };
  const resumed = applyVoyage(restarted, snap('v2', 0, { state: 'paused', distanceTravelled: 30, elapsedMillis: 16_000 }), toKnots);
  assert.equal(resumed.upsert, null);
  assert.equal(resumed.state.current.recordId, 'v1');
  assert.equal(resumed.state.current.voyageId, 'v2');
  assert.deepEqual(resumed.state.current.to, LONDON);
  assert.equal(resumed.state.current.metrics.distance, 90);
  // 같은 항차 snapshot이 다시 와도 다시 전환하지 않는다.
  const again = applyVoyage(resumed.state, snap('v2', 0, { state: 'paused', distanceTravelled: 30, elapsedMillis: 17_000 }), toKnots);
  assert.equal(again.upsert, null);
  assert.equal(again.state.records.length, 1);
});

test('입항한 항차는 판독 끊김 직후여도 잇지 않고, 다음 항차는 새 기록이다', () => {
  const state = run([
    ev('voyage.started', { voyageId: 'v1' }, 10_000),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }, 10_000),
    tracking('v1', 40_000),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 41_000),
    stale('v1', 42_000),
    ev('voyage.ended', { voyageId: 'v1' }, 46_000),
    ev('voyage.started', { voyageId: 'v2' }, 46_000),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 46_000),
    tracking('v2', 50_000),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-seville' }, 60_000),
  ]);
  assert.equal(state.records.length, 2);
  assert.deepEqual(state.records[0].from, LONDON);
  assert.deepEqual(state.records[0].to, SEVILLE);
});
