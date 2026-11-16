// SDK 없이 도는 순수 로직 검사. 실행: node --test test/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_RECORDS,
  appendRegion,
  applyEvent,
  applyVoyage,
  arrivalNotice,
  compareWithPast,
  emptyState,
  formatDiff,
  formatSeason,
  formatTimeRange,
  includedInComparison,
  isDetour,
  maxRegionVisits,
  nextCompareMode,
  recordSeason,
  seasonAt,
  setRecordCompare,
  worldDistance,
  metricsFromVoyage,
  normalizeLeg,
  normalizePending,
  normalizeRecords,
  routeKey,
  routeStats,
  routesFrom,
  toCsv,
  upsertRecord,
} from '../module/lib/log.js';
import { EVENT_KINDS, createRecorder } from '../module/lib/recorder.js';
import { createResolver, placeIdsOf } from '../module/lib/resolver.js';
import { CURRENT_KEY, PENDING_KEY, RECORDS_KEY, commit } from '../module/lib/store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleDir = join(root, 'module');

const LISBON = { poiId: 'poi-lisbon', name: '리스본' };
const LONDON = { poiId: 'poi-london', name: '런던' };
const SEVILLE = { poiId: 'poi-seville', name: '세비야' };
const toKnots = (unitsPerSecond) => unitsPerSecond;

let revision = 0;
function ev(kind, data = {}, at = 1_000 + revision * 1000) {
  revision += 1;
  return { kind, eventId: `e${revision}`, revision, occurredAtUnixMillis: at, confidence: 0.9, data };
}

function snap(voyageId, lastSailingDays, extra = {}) {
  return { voyageId, state: 'underway', lastSailingDays, distanceTravelled: 840, elapsedMillis: 100_000, startedAtUnixMillis: 500, emittedAtUnixMillis: 9_000, ...extra };
}

function record(recordId, from, to, sailingDays, arrivedAt = 1) {
  return { recordId, voyageId: recordId, from, to, sailingDays, knots: null, departedAt: null, arrivedAt, final: true };
}

const placeMap = { 'poi-lisbon': LISBON, 'poi-london': LONDON, 'poi-seville': SEVILLE };

/** 이벤트와 voyage snapshot을 차례로 넣는다. */
function run(steps, initial = emptyState()) {
  let state = initial;
  const upserts = [];
  for (const step of steps) {
    const result = step.kind
      ? applyEvent(state, step, placeMap[step.data?.nearestPoiId] ?? null)
      : applyVoyage(state, step, toKnots);
    state = result.state;
    if (result.upsert) upserts.push(result.upsert);
  }
  return { state, upserts };
}

test('정상 항해: ended(앞) → started → departed → 입항, 다음 출항의 ended에서 확정한다', () => {
  const { state, upserts } = run([
    ev('voyage.started', { voyageId: 'v1' }),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    snap('v1', 11),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }),
  ]);
  // 입항 때 확정 전 기록이 표에 들어간다.
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].final, false);
  assert.deepEqual(state.records[0].from, LISBON);
  assert.deepEqual(state.records[0].to, LONDON);
  assert.equal(state.records[0].sailingDays, 11);
  assert.equal(state.records[0].knots, 8.4);
  assert.equal(upserts.length, 1);
  // 정박 중(paused) snapshot은 같은 voyageId라 값만 이어진다.
  const after = run([
    snap('v1', 11, { state: 'paused' }),
    ev('voyage.ended', { voyageId: 'v1' }),
    ev('voyage.started', { voyageId: 'v2' }),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-london' }),
  ], state).state;
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].final, true);
  assert.deepEqual(after.records[0].to, LONDON);
  assert.equal(after.current.voyageId, 'v2');
  assert.deepEqual(after.current.from, LONDON);
});

test('도착지는 그 항차 동안 받은 마지막 shore.arrived다', () => {
  const { state } = run([
    ev('voyage.started', { voyageId: 'v3' }),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-seville' }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }),
    ev('voyage.ended', { voyageId: 'v3' }),
  ]);
  assert.equal(state.records.length, 1);
  assert.deepEqual(state.records[0].to, LONDON);
});

test('출항이 voyage.started보다 먼저 와도 다음 항차의 출발지가 된다', () => {
  const { state } = run([
    ev('voyage.started', { voyageId: 'v4' }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    // 항해일수 판독이 늦어 출항이 먼저 온다.
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    ev('voyage.ended', { voyageId: 'v4' }),
    ev('voyage.started', { voyageId: 'v5' }),
  ]);
  assert.equal(state.records.length, 1);
  assert.deepEqual(state.records[0].to, LISBON);
  assert.equal(state.current.voyageId, 'v5');
  assert.deepEqual(state.current.from, LISBON);
  assert.equal(state.pending, null);
});

test('새 항차 snapshot이 voyage.started보다 먼저 와도 먼저 온 출항을 붙인다', () => {
  const { state } = run([
    ev('voyage.started', { voyageId: 'v6' }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-seville' }),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-seville' }),
    snap('v7', 0),
    ev('voyage.ended', { voyageId: 'v6' }),
    ev('voyage.started', { voyageId: 'v7' }),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].recordId, 'v6');
  assert.deepEqual(state.records[0].to, SEVILLE);
  assert.equal(state.current.voyageId, 'v7');
  assert.deepEqual(state.current.from, SEVILLE);
});

test('사용자가 바다에서 새 항차를 시작하면 앞 항차는 도착지 모름이다', () => {
  const ended = run([
    ev('voyage.started', { voyageId: 'v8' }),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    snap('v8', 4),
    ev('voyage.ended', { voyageId: 'v8' }, 77_000),
    ev('voyage.started', { voyageId: 'v9' }),
    // ended 뒤 snapshot은 이미 새 항차라 끝난 항차 값을 바꾸지 않는다.
    snap('v9', 0, { distanceTravelled: 1 }),
  ]).state;
  const [saved] = ended.records;
  assert.equal(saved.recordId, 'v8');
  assert.equal(saved.to, null);
  assert.equal(saved.final, true);
  assert.equal(saved.sailingDays, 4);
  assert.equal(saved.arrivedAt, 77_000);
  assert.equal(ended.current.voyageId, 'v9');
  assert.equal(ended.current.from, null);
});

test('voyage.ended를 놓쳐도 다음 voyage.started가 앞 항차를 확정한다', () => {
  const { state } = run([
    ev('voyage.started', { voyageId: 'a' }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }),
    ev('voyage.started', { voyageId: 'b' }),
  ]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].final, true);
  assert.equal(state.current.voyageId, 'b');
});

test('Navigator를 다시 켜면 voyage.started 없이 snapshot의 항차를 이어 간다', () => {
  // 저장된 열린 항차와 같은 voyageId면 그대로 잇는다.
  const stored = { ...emptyState(), current: normalizeLeg({ voyageId: 'v10', from: LISBON, departedAt: 5 }) };
  const same = applyVoyage(stored, snap('v10', 6), toKnots);
  assert.deepEqual(same.state.current.from, LISBON);
  assert.equal(same.state.current.metrics.sailingDays, 6);
  assert.equal(same.persist, true);
  // 열린 항차가 없으면 snapshot의 voyageId로 연다(출발지 모름).
  const fresh = applyVoyage(emptyState(), snap('v11', 2), toKnots);
  assert.equal(fresh.state.current.voyageId, 'v11');
  assert.equal(fresh.state.current.from, null);
  assert.equal(fresh.state.current.departedAt, 500);
  // 꺼진 동안 항차가 바뀌었으면 저장된 항차를 확정한다.
  const moved = applyVoyage(stored, snap('v12', 1), toKnots);
  assert.equal(moved.upsert.recordId, 'v10');
  assert.equal(moved.upsert.final, true);
  assert.equal(moved.state.current.voyageId, 'v12');
  // 정박 중에 켜서 기록에 이미 있는 항차면 출발·도착지를 이어 받는다.
  const docked = { ...emptyState(), records: [{ ...record('v13', LISBON, LONDON, 9), final: false }] };
  const resumed = applyVoyage(docked, snap('v13', 9, { state: 'paused' }), toKnots);
  assert.deepEqual(resumed.state.current.to, LONDON);
  assert.equal(resumed.upsert, null);
});

test('revision이 같거나 낮은 이벤트는 무시한다(시각이 아니라 revision으로 판단)', () => {
  const started = { kind: 'voyage.started', eventId: 'a', revision: 10, occurredAtUnixMillis: 5_000, confidence: 1, data: { voyageId: 'r1' } };
  let state = applyEvent(emptyState(), started).state;
  const older = { kind: 'voyage.ended', eventId: 'b', revision: 9, occurredAtUnixMillis: 9_000, confidence: 1, data: { voyageId: 'r1' } };
  assert.equal(applyEvent(state, older).changed, false);
  const newer = { ...older, eventId: 'c', revision: 11, occurredAtUnixMillis: 1_000 };
  state = applyEvent(state, newer).state;
  assert.equal(state.current, null);
  assert.equal(state.records.length, 1);
});

test('항차 없이 입항만 오면 기록하지 않고, 다른 항차 ended는 무시한다', () => {
  assert.equal(applyEvent(emptyState(), ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }), LONDON).state.records.length, 0);
  const { state } = run([ev('voyage.started', { voyageId: 'x' }), ev('voyage.ended', { voyageId: 'other' })]);
  assert.equal(state.current.voyageId, 'x');
  assert.equal(state.records.length, 0);
});

test('voyage snapshot에서 항해일수와 평균 속도를 고른다', () => {
  assert.deepEqual(metricsFromVoyage(snap('v', 6, { distanceTravelled: 300, elapsedMillis: 60_000 }), (v) => v * 2), { voyageId: 'v', sailingDays: 6, knots: 10, distance: 300 });
  assert.equal(metricsFromVoyage(snap('v', 1, { elapsedMillis: 2_000 }), toKnots).knots, null);
  assert.equal(metricsFromVoyage(snap('v', 1), () => null).knots, null);
  assert.equal(metricsFromVoyage(snap(null, 1), toKnots), null);
  // idle(게임 미연결)이어도 마지막 항차 값은 voyageId로 묶어 쓴다.
  assert.equal(metricsFromVoyage(snap('v', 3, { state: 'idle' }), toKnots).sailingDays, 3);
  // 값이 같으면 다시 저장하지 않는다.
  const state = applyVoyage(emptyState(), snap('v', 3), toKnots).state;
  assert.equal(applyVoyage(state, snap('v', 3), toKnots).changed, false);
  assert.equal(applyVoyage(state, snap('v', null, { distanceTravelled: null }), toKnots).changed, false);
});

test('기록은 voyageId마다 하나, 최근 500항차까지 가장 오래된 것부터 버린다', () => {
  let records = [];
  for (let index = 0; index < MAX_RECORDS + 5; index += 1) records = upsertRecord(records, record(`r${index}`, LISBON, LONDON, 5));
  assert.equal(records.length, MAX_RECORDS);
  assert.equal(records[0].recordId, `r${MAX_RECORDS + 4}`);
  assert.equal(records.at(-1).recordId, 'r5');
  const replaced = upsertRecord(records, { ...records[3], sailingDays: 1 });
  assert.equal(replaced.length, MAX_RECORDS);
  assert.equal(replaced[3].sailingDays, 1);
});

test('저장값이 망가져도 읽을 수 있는 값만 남긴다', () => {
  const records = normalizeRecords([null, { recordId: 'x' }, { recordId: 'ok', arrivedAt: 5, from: { poiId: 'a', name: 'A' }, to: 'bad', sailingDays: '3' }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].to, null);
  assert.equal(records[0].sailingDays, null);
  assert.equal(records[0].final, true);
  assert.equal(normalizeRecords('nope').length, 0);
  assert.equal(normalizeLeg({ voyageId: '' }), null);
  assert.equal(normalizePending({ from: LISBON }), null);
});

test('같은 구간은 통합된 거점(redirect)을 새 ID로 묶어 비교한다', () => {
  const OLD_LONDON = { poiId: 'poi-london-old', name: '런던' };
  const records = [
    record('r4', LISBON, LONDON, 11),
    record('r3', LISBON, OLD_LONDON, 9),
    record('r2', LISBON, LONDON, 12),
    record('r1', LISBON, null, 20),
    record('r0', SEVILLE, LISBON, 4),
  ];
  const redirect = (id) => (id === 'poi-london-old' ? 'poi-london' : id);
  assert.equal(routeKey(records[1]), 'poi-lisbon>poi-london-old');
  assert.equal(routeKey(records[1], redirect), 'poi-lisbon>poi-london');
  assert.equal(routeKey(records[3], redirect), null);
  const key = 'poi-lisbon>poi-london';
  assert.deepEqual(routeStats(records, key, redirect), { count: 3, best: 9, average: (11 + 9 + 12) / 3 });
  assert.deepEqual(routeStats(records, key, redirect, 'r4'), { count: 2, best: 9, average: 10.5 });
  // 이번 기록(r4)은 더 오래된 같은 구간 평균 10.5일과 비교한다.
  const comparison = compareWithPast(records, 0, redirect);
  assert.equal(comparison.kind, 'diff');
  assert.equal(comparison.diff, 0.5);
  assert.equal(formatDiff(comparison), '+0.5일');
  assert.equal(formatDiff(compareWithPast(records, 2, redirect)), '첫 기록');
  assert.equal(formatDiff(compareWithPast(records, 3, redirect)), '-');
  // redirect를 모르면 다른 구간으로 본다.
  assert.equal(compareWithPast(records, 1).kind, 'first');
  const routes = routesFrom(records, 'poi-lisbon', redirect);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].stats.count, 3);
});

test('비교 문구', () => {
  assert.equal(formatDiff({ kind: 'diff', diff: -0.5 }), '−0.5일');
  assert.equal(formatDiff({ kind: 'diff', diff: 2 }), '+2일');
  assert.equal(formatDiff({ kind: 'diff', diff: 0.01 }), '같음');
  const notice = arrivalNotice({ ...record('r', LISBON, LONDON, 11), knots: 8.4 }, { kind: 'diff', diff: 0.5 });
  assert.equal(notice.title, '런던 도착 · 11일');
  assert.equal(notice.body, '리스본 → 런던 · 평균 8.4 kn\n지난 평균보다 0.5일 느림');
  const unknown = arrivalNotice(record('r', null, null, null), { kind: 'unknown' });
  assert.equal(unknown.title, '도착지 모름 도착');
  const long = arrivalNotice(record('r', LISBON, { poiId: 'x', name: '가'.repeat(200) }, 3), { kind: 'first' });
  assert.ok(long.title.length <= 80);
  assert.ok(long.body.length <= 500);
});

test('CSV는 BOM·CRLF·따옴표 처리를 한다', () => {
  const tricky = { poiId: 'p,1', name: '산 "마르코", 항' };
  const csv = toCsv([
    { ...record('r1', tricky, null, 3.4, Date.UTC(2026, 10, 15, 3, 4)), knots: 9.25 },
  ]);
  assert.ok(csv.startsWith('﻿도착 시각,출발 시각,출발 거점 ID,출발,도착 거점 ID,도착,항해일수,평균 속도(kn),계절,비교,지나간 해역\r\n'));
  const line = csv.split('\r\n')[1];
  assert.ok(line.includes(',"p,1","산 ""마르코"", 항",,도착지 모름,3,9.3'), line);
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(toCsv([]).split('\r\n').length, 2);
});

test('거점 캐시는 ID마다 getPoi로 풀고, 실패한 ID는 원래 ID를 쓴다', async () => {
  const calls = [];
  const resolver = createResolver(async (poiId) => {
    calls.push(poiId);
    if (poiId === 'broken') throw Object.assign(new Error('x'), { code: 'host.unavailable' });
    if (poiId === 'gone') return null;
    return { poiId: poiId === 'old' ? 'new' : poiId, name: `이름-${poiId}` };
  });
  assert.equal(await resolver.ensure(['old', 'gone', 'old', 'broken', 'kept']), true);
  assert.equal(resolver.resolve('old'), 'new');
  assert.equal(resolver.nameOf('old'), '이름-old');
  assert.equal(resolver.resolve('gone'), 'gone');
  assert.equal(resolver.nameOf('gone'), null);
  assert.equal(resolver.has('gone'), true);
  assert.equal(resolver.has('broken'), false);
  assert.equal(resolver.resolve('broken'), 'broken');
  assert.deepEqual(calls, ['old', 'gone', 'broken', 'kept']);
  await resolver.ensure(['old']);
  assert.equal(calls.length, 4);
  resolver.reset();
  assert.equal(resolver.has('old'), false);
  assert.deepEqual(placeIdsOf([record('r', LISBON, null, 1)]), ['poi-lisbon']);
});

function fakeStorage(initial = {}) {
  let revisionNo = 1;
  const values = { ...initial };
  const storage = {
    conflictsLeft: 0,
    async getSnapshot() {
      return { revision: revisionNo, values: structuredClone(values) };
    },
    async batch({ expectedRevision, operations }) {
      if (storage.conflictsLeft > 0) {
        storage.conflictsLeft -= 1;
        revisionNo += 1;
        throw Object.assign(new Error('conflict'), { code: 'storage.conflict', details: { revision: revisionNo } });
      }
      if (expectedRevision !== undefined && expectedRevision !== revisionNo) {
        throw Object.assign(new Error('conflict'), { code: 'storage.conflict', details: { revision: revisionNo } });
      }
      for (const operation of operations) {
        if (operation.kind === 'set') values[operation.key] = structuredClone(operation.value);
        else delete values[operation.key];
      }
      revisionNo += 1;
      return { revision: revisionNo, values: structuredClone(values) };
    },
    set(key, value) {
      values[key] = value;
      revisionNo += 1;
    },
    get values() {
      return values;
    },
  };
  return storage;
}

test('storage 충돌이면 지금 값을 다시 읽어 다시 쓴다', async () => {
  const storage = fakeStorage({ [RECORDS_KEY]: [] });
  storage.conflictsLeft = 2;
  await commit(storage, (values) => [{ kind: 'set', key: RECORDS_KEY, value: [...values[RECORDS_KEY], 1] }]);
  assert.deepEqual(storage.values[RECORDS_KEY], [1]);
  storage.conflictsLeft = 10;
  await assert.rejects(commit(storage, () => [{ kind: 'set', key: 'x', value: 1 }]), { code: 'storage.conflict' });
});

function makeRecorder(storage, { toast = true } = {}) {
  const notices = [];
  const places = { 'poi-lisbon': LISBON, 'poi-london': LONDON, 'poi-london-old': { poiId: 'poi-london', name: '런던' } };
  const getPoi = async (poiId) => places[poiId] ?? null;
  const recorder = createRecorder({
    storage,
    resolver: createResolver(getPoi),
    getPoi,
    toKnots,
    notify: async (input) => { notices.push(input); return { notificationId: 'n', deduplicated: false }; },
    toastEnabled: () => toast,
    onError: (error) => { throw error; },
  });
  return { recorder, notices };
}

test('service 흐름: 입항 때 표에 넣고 toast에 지난 평균과의 차이를 넣으며, 다음 출항 때 확정한다', async () => {
  const storage = fakeStorage({ [RECORDS_KEY]: [record('old', LISBON, { poiId: 'poi-london-old', name: '런던' }, 10)] });
  const { recorder, notices } = makeRecorder(storage);
  // start 전에 온 이벤트도 저장값을 읽은 뒤 처리한다.
  void recorder.event(ev('voyage.started', { voyageId: 's1' }));
  void recorder.event(ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }));
  await recorder.start({ values: (await storage.getSnapshot()).values, voyage: null });
  await recorder.idle();
  assert.equal(storage.values[CURRENT_KEY].voyageId, 's1');
  assert.deepEqual(storage.values[CURRENT_KEY].from, LISBON);
  await recorder.voyage(snap('s1', 11));
  assert.equal(storage.values[CURRENT_KEY].metrics.sailingDays, 11);
  await recorder.event(ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }));
  assert.equal(storage.values[RECORDS_KEY].length, 2);
  assert.equal(storage.values[RECORDS_KEY][0].recordId, 's1');
  assert.equal(storage.values[RECORDS_KEY][0].final, false);
  assert.equal(storage.values[RECORDS_KEY][0].knots, 8.4);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, '런던 도착 · 11일');
  assert.ok(notices[0].body.includes('지난 평균보다 1일 느림'), notices[0].body);
  assert.equal(notices[0].presentation, 'toast');
  assert.equal('sound' in notices[0], false);
  await recorder.event(ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-london' }));
  assert.deepEqual(storage.values[PENDING_KEY].from, LONDON);
  await recorder.event(ev('voyage.ended', { voyageId: 's1' }));
  await recorder.event(ev('voyage.started', { voyageId: 's2' }));
  assert.equal(storage.values[RECORDS_KEY][0].final, true);
  assert.equal(storage.values[RECORDS_KEY].length, 2);
  assert.deepEqual(storage.values[CURRENT_KEY].from, LONDON);
  assert.equal(storage.values[PENDING_KEY], null);
  assert.equal(notices.length, 1);
});

test('service 흐름: 다시 켜면 snapshot으로 항차를 이어 가고, 알림을 끄면 toast가 없다', async () => {
  const storage = fakeStorage({ [CURRENT_KEY]: { voyageId: 'k1', from: LISBON, departedAt: 1 } });
  const { recorder, notices } = makeRecorder(storage, { toast: false });
  await recorder.start({ values: (await storage.getSnapshot()).values, voyage: snap('k1', 5) });
  assert.equal(storage.values[CURRENT_KEY].metrics.sailingDays, 5);
  await recorder.event(ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }));
  assert.deepEqual(storage.values[RECORDS_KEY][0].from, LISBON);
  assert.equal(notices.length, 0);
});

test('service 흐름: 패널이 지운 기록을 되살리지 않는다', async () => {
  const storage = fakeStorage({ [RECORDS_KEY]: [record('old', LISBON, LONDON, 10)] });
  const { recorder } = makeRecorder(storage);
  await recorder.start({ values: (await storage.getSnapshot()).values, voyage: null });
  await recorder.event(ev('voyage.started', { voyageId: 'c1' }));
  storage.set(RECORDS_KEY, []);
  await recorder.event(ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }));
  assert.deepEqual(storage.values[RECORDS_KEY].map((item) => item.recordId), ['c1']);
});

test('manifest: 필요한 capability만, 설정 id와 service 코드가 맞다', () => {
  const manifest = JSON.parse(readFileSync(join(moduleDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.moduleId, 'dev.dho-unofficial.voyage-log');
  assert.equal(manifest.publisher.id, 'dev.dho-unofficial');
  assert.deepEqual(manifest.capabilities, [
    'files.user', 'navigation.read', 'notifications.show', 'service.background', 'settings.read', 'storage.local',
  ]);
  assert.equal(manifest.network, undefined);
  const field = manifest.settings.fields.find((item) => item.id === 'arrival-toast');
  assert.equal(field.type, 'checkbox');
  assert.equal(field.default, true);
  const service = readFileSync(join(moduleDir, manifest.service.entry), 'utf8');
  assert.ok(service.includes("'arrival-toast'"));
  assert.deepEqual([...EVENT_KINDS].sort(), ['region.changed', 'shore.arrived', 'shore.departed', 'voyage.ended', 'voyage.started']);
});

// ── 운행 시간·계절·우회·출발지 추정 ──

test('운행 시간은 같은 날이면 도착 시각만, 날짜가 바뀌면 도착에도 날짜를 붙인다', () => {
  const at = (day, hour, minute) => new Date(2026, 10, day, hour, minute).getTime();
  assert.equal(formatTimeRange(at(16, 14, 0), at(16, 15, 31)), '11-16 14:00~15:31');
  assert.equal(formatTimeRange(at(15, 23, 40), at(16, 0, 20)), '11-15 23:40~11-16 00:20');
  assert.equal(formatTimeRange(null, at(16, 15, 31)), '11-16 15:31');
});

test('계절은 공개 게임 시각 공식(현실 9시간마다 전환)으로 시각에서 계산한다', () => {
  const epoch = Date.UTC(2005, 2, 16, 4, 30, 0);
  const hours = (count) => count * 3_600_000;
  assert.equal(seasonAt(epoch), 'summer');
  assert.equal(seasonAt(epoch + hours(9) - 1), 'summer');
  assert.equal(seasonAt(epoch + hours(9)), 'winter');
  assert.equal(seasonAt(epoch + hours(18)), 'summer');
  assert.equal(seasonAt(null), null);
  const crossing = { departedAt: epoch + hours(9) - 60_000, arrivedAt: epoch + hours(9) + 60_000 };
  assert.equal(formatSeason(crossing), '여름→겨울');
  assert.equal(recordSeason(crossing).key, 'summer');
  assert.equal(formatSeason({ departedAt: null, arrivedAt: epoch + hours(9) }), '겨울');
});

test('같은 구간은 같은 계절 기록과 먼저 비교하고, 없으면 계절을 가리지 않는다', () => {
  const epoch = Date.UTC(2005, 2, 16, 4, 30, 0);
  const summer = epoch + 3_600_000;
  const winter = epoch + 10 * 3_600_000;
  const at = (base, sailingDays, id) => ({ ...record(id, LISBON, LONDON, sailingDays, base), departedAt: base - 1000 });
  const records = [at(winter + 2, 10, 'now'), at(summer + 1, 6, 'old-summer'), at(winter + 1, 12, 'old-winter')];
  const same = compareWithPast(records, 0);
  assert.equal(same.kind, 'diff');
  assert.equal(same.sameSeason, true);
  assert.equal(same.average, 12);
  const onlySummer = compareWithPast([at(winter + 2, 10, 'now'), at(summer + 1, 6, 'old-summer')], 0);
  assert.equal(onlySummer.sameSeason, false);
  assert.equal(onlySummer.average, 6);
  assert.match(arrivalNotice(records[0], same).body, /같은 계절 지난 평균보다 2일 빠름/);
});

test('같은 해역을 세 번 들렀거나 이동 거리가 직선의 3배를 넘으면 우회로 비교에서 빼고, 사용자가 고른 값이 이긴다', () => {
  const base = { ...record('d', LISBON, LONDON, 9), straight: 100 };
  const visit = (regionId, at) => ({ regionId, name: regionId, at });
  assert.equal(isDetour({ ...base, distance: 301 }), true);
  // 판독 흔들림으로 직행도 직선의 2.5배까지 나온다(실기기 리스본 → 비아나두카스텔루 365/148).
  assert.equal(isDetour({ ...base, distance: 250 }), false);
  assert.equal(isDetour({ ...base, distance: null }), false);
  // 경계를 한 번 스친 A→B→A는 직행, 두 해역을 오간 A→B→A→B→A는 우회.
  assert.equal(isDetour({ ...base, distance: null, regions: [visit('a', 1), visit('b', 2), visit('a', 3)] }), false);
  assert.equal(isDetour({ ...base, distance: null, regions: ['a', 'b', 'a', 'b', 'a'].map(visit) }), true);
  assert.equal(maxRegionVisits(['a', 'b', 'a'].map(visit)), 2);
  const detour = { ...base, distance: 310 };
  assert.equal(includedInComparison(detour), false);
  assert.equal(includedInComparison({ ...detour, compare: 'include' }), true);
  assert.equal(includedInComparison({ ...base, distance: 120, compare: 'exclude' }), false);
  const records = [detour, record('old', LISBON, LONDON, 4)];
  assert.deepEqual(compareWithPast(records, 0), { kind: 'excluded' });
  assert.equal(formatDiff({ kind: 'excluded' }), '비교 안 함');
  // 우회 항차는 다른 항차의 평균에도 넣지 않는다.
  assert.equal(routeStats(records, 'poi-lisbon>poi-london').count, 1);
  assert.equal(setRecordCompare(records, 'd', 'include')[0].compare, 'include');
  assert.equal(setRecordCompare(records, 'd', 'bogus'), records);
});

test('비교 넣기/빼기는 자동 판정과 같아지면 auto로 되돌린다', () => {
  const direct = { ...record('a', LISBON, LONDON, 5), distance: 120, straight: 100, compare: 'auto' };
  const detour = { ...direct, distance: 310 };
  assert.equal(nextCompareMode(direct), 'exclude');
  assert.equal(nextCompareMode({ ...direct, compare: 'exclude' }), 'auto');
  assert.equal(nextCompareMode(detour), 'include');
  assert.equal(nextCompareMode({ ...detour, compare: 'include' }), 'auto');
});

test('예전 형식 기록은 새 필드를 기본값으로 채워 읽는다', () => {
  const [old] = normalizeRecords([{ recordId: 'r', voyageId: 'r', from: LISBON, to: LONDON, sailingDays: 3, knots: 9, departedAt: 1, arrivedAt: 2, final: true }]);
  assert.equal(old.compare, 'auto');
  assert.deepEqual(old.regions, []);
  assert.equal(old.fromEstimated, false);
  assert.equal(old.distance, null);
  assert.equal(old.straight, null);
  assert.equal(includedInComparison(old), true);
  assert.equal(normalizeRecords([{ ...old, compare: 'bogus' }])[0].compare, 'auto');
});

test('CSV는 수식으로 읽힐 값 앞에 따옴표 문자를 붙인다', () => {
  const csv = toCsv([{ ...record('r', { poiId: 'p', name: '=HYPERLINK(1)' }, LONDON, 1, 5), regions: [{ regionId: 'x', name: '@해역', at: 1 }] }]);
  const line = csv.split('\r\n')[1];
  assert.ok(line.includes(`,'=HYPERLINK(1),`), line);
  assert.ok(line.endsWith(`'@해역`), line);
});

test('출발지 추정은 항차를 연 때보다 이른 위치를 쓰지 않고, 한 항차에 한 번만 시도한다', async () => {
  let calls = 0;
  const recorder = createRecorder({
    storage: fakeStorage(),
    resolver: createResolver(async () => null),
    getPoi: async (poiId) => placeMap[poiId] ?? null,
    nearbyPort: async () => { calls += 1; return null; },
    toKnots,
    notify: async () => {},
    toastEnabled: () => false,
  });
  await recorder.start({ values: {}, voyage: snap('v1', 0, { startedAtUnixMillis: 10_000 }) });
  await recorder.position({ quality: 'live', value: { x: 1, y: 1 }, observedAtUnixMillis: 4_000 });
  assert.equal(calls, 0);
  await recorder.position({ quality: 'live', value: { x: 1, y: 1 }, observedAtUnixMillis: 10_200 });
  await recorder.position({ quality: 'live', value: { x: 2, y: 2 }, observedAtUnixMillis: 10_400 });
  assert.equal(calls, 1);
  assert.equal(recorder.getState().current.from, null);
});

test('service가 같은 항차를 다시 써도 사용자의 비교 선택과 해역 경로를 지킨다', () => {
  const stored = [{ ...record('v', LISBON, LONDON, 9), compare: 'exclude', regions: [{ regionId: 'r1', name: '북해', at: 1 }] }];
  const next = upsertRecord(stored, { ...record('v', LISBON, LONDON, 10), compare: 'auto', regions: [] });
  assert.equal(next[0].sailingDays, 10);
  assert.equal(next[0].compare, 'exclude');
  assert.equal(next[0].regions.length, 1);
});

test('Navigator를 켠 직후 방금 끝난(입항해 멈춘) 앞 항차 snapshot으로는 항차를 열지 않는다', () => {
  revision = 0;
  // 실기기 2026-11-16: 리스본에서 켜자 앞 항차(paused)가 열리고, 출항 판정이 거기 붙어 "리스본 → 도착지 모름"이 생겼다.
  const { state } = run([
    snap('old', 2, { state: 'paused' }),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    ev('voyage.ended', { voyageId: 'old' }),
    ev('voyage.started', { voyageId: 'new' }),
    snap('new', 0),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }),
  ]);
  assert.equal(state.records.length, 1);
  assert.deepEqual(state.records[0].from, LISBON);
  assert.equal(state.records[0].fromEstimated, false);
  assert.deepEqual(state.records[0].to, LONDON);
});

test('지나간 해역은 같은 해역 연속을 한 번으로 묶어 항차에 남는다', () => {
  revision = 0;
  const { state } = run([
    snap('v1', 0),
    ev('region.changed', { fromRegionId: 'a', regionId: 'b', name: '북동대서양', parentRegion: null }),
    ev('region.changed', { fromRegionId: 'b', regionId: 'b', name: '북동대서양', parentRegion: null }),
    ev('region.changed', { fromRegionId: 'b', regionId: 'c', name: '리스본 앞바다', parentRegion: null }),
    ev('region.changed', { fromRegionId: 'c', regionId: 'b', name: '북동대서양', parentRegion: null }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
  ]);
  assert.deepEqual(state.records[0].regions.map((item) => item.name), ['북동대서양', '리스본 앞바다', '북동대서양']);
  assert.equal(appendRegion(Array.from({ length: 64 }, (_, i) => ({ regionId: `r${i}`, name: '', at: i })), { regionId: 'x', name: '', at: 99 }).length, 64);
});

test('출발지를 모르면 첫 측량 위치의 가까운 도시로 추정하고, 출항 판정이 오면 그것으로 바꾼다', async () => {
  const storage = fakeStorage();
  const recorder = createRecorder({
    storage,
    resolver: createResolver(async () => null),
    getPoi: async (poiId) => ({ ...placeMap[poiId], point: { x: 0, y: 0 } }),
    nearbyPort: async () => LISBON,
    toKnots,
    notify: async () => {},
    toastEnabled: () => false,
  });
  await recorder.start({ values: {}, voyage: snap('v1', 0, { startedAtUnixMillis: 10_000 }) });
  // 항차를 연 시각보다 1분 넘게 뒤의 위치는 쓰지 않는다.
  await recorder.position({ quality: 'live', value: { x: 1, y: 1 }, observedAtUnixMillis: 10_000 + 61_000 });
  assert.equal(recorder.getState().current.from, null);
  const other = createRecorder({
    storage: fakeStorage(),
    resolver: createResolver(async () => null),
    getPoi: async (poiId) => placeMap[poiId] ?? null,
    nearbyPort: async () => LISBON,
    toKnots,
    notify: async () => {},
    toastEnabled: () => false,
  });
  await other.start({ values: {}, voyage: snap('v1', 0, { startedAtUnixMillis: 10_000 }) });
  await other.position({ quality: 'held', value: { x: 1, y: 1 }, observedAtUnixMillis: 10_500 });
  assert.equal(other.getState().current.from, null);
  await other.position({ quality: 'live', value: { x: 1, y: 1 }, observedAtUnixMillis: 11_000 });
  assert.deepEqual(other.getState().current.from, LISBON);
  assert.equal(other.getState().current.fromEstimated, true);
  await other.event(ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-seville' }, 12_000));
  assert.deepEqual(other.getState().current.from, SEVILLE);
  assert.equal(other.getState().current.fromEstimated, false);
});

test('입항하면 출발·도착 거점 직선 거리를 재어 기록에 남긴다', async () => {
  const points = { 'poi-lisbon': { x: 0, y: 0 }, 'poi-london': { x: 30, y: 40 } };
  const recorder = createRecorder({
    storage: fakeStorage(),
    resolver: createResolver(async () => null),
    getPoi: async (poiId) => (placeMap[poiId] ? { ...placeMap[poiId], point: points[poiId] } : null),
    toKnots,
    notify: async () => {},
    toastEnabled: () => false,
  });
  await recorder.start({ values: {}, voyage: null });
  await recorder.event(ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }, 1_000));
  await recorder.event(ev('voyage.started', { voyageId: 'v9' }, 1_100));
  await recorder.event(ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 5_000));
  assert.equal(recorder.getState().records[0].straight, 50);
  assert.equal(worldDistance({ x: 16380, y: 0 }, { x: 4, y: 0 }), 8);
});
