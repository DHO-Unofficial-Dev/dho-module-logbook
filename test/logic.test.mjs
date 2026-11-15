// SDK 없이 도는 순수 로직 검사. 실행: node --test test/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  END_GRACE_MS,
  MAX_RECORDS,
  applyEvent,
  arrivalNotice,
  compareWithPast,
  emptyState,
  expireLeg,
  formatDiff,
  metricsFromVoyage,
  normalizeLeg,
  normalizeRecords,
  prependRecord,
  resumeFromSnapshot,
  routeKey,
  routeStats,
  routesFrom,
  toCsv,
  updateMetrics,
} from '../module/lib/log.js';
import { EVENT_KINDS, createRecorder } from '../module/lib/recorder.js';
import { createResolver, placeIdsOf } from '../module/lib/resolver.js';
import { CURRENT_KEY, RECORDS_KEY, commit } from '../module/lib/store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleDir = join(root, 'module');

const LISBON = { poiId: 'poi-lisbon', name: '리스본' };
const LONDON = { poiId: 'poi-london', name: '런던' };
const SEVILLE = { poiId: 'poi-seville', name: '세비야' };

let revision = 0;
function ev(kind, data = {}, at = 1_000 + revision * 1000) {
  revision += 1;
  return { kind, eventId: `e${revision}`, revision, occurredAtUnixMillis: at, confidence: 0.9, data };
}

function record(recordId, from, to, sailingDays, arrivedAt = 1) {
  return { recordId, voyageId: null, from, to, sailingDays, knots: null, departedAt: null, arrivedAt };
}

function run(events, places = {}) {
  let state = emptyState();
  const closed = [];
  for (const event of events) {
    const place = places[event.data?.nearestPoiId] ?? null;
    const result = applyEvent(state, event, place);
    state = result.state;
    if (result.closed) closed.push(result);
  }
  return { state, closed };
}

const placeMap = { 'poi-lisbon': LISBON, 'poi-london': LONDON, 'poi-seville': SEVILLE };

test('출항 → 입항이면 출발·도착 거점과 항해일수·속도로 한 항차를 남긴다', () => {
  let state = applyEvent(emptyState(), ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }), LISBON).state;
  state = applyEvent(state, ev('voyage.started', { voyageId: 'v1' })).state;
  state = updateMetrics(state, { voyageId: 'v1', sailingDays: 11, knots: 8.4 }).state;
  const result = applyEvent(state, ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }), LONDON);
  assert.equal(result.arrived, true);
  assert.equal(result.state.current, null);
  assert.equal(result.state.records.length, 1);
  const [saved] = result.state.records;
  assert.deepEqual(saved.from, LISBON);
  assert.deepEqual(saved.to, LONDON);
  assert.equal(saved.voyageId, 'v1');
  assert.equal(saved.sailingDays, 11);
  assert.equal(saved.knots, 8.4);
});

test('voyage.started가 먼저 와도 뒤의 shore.departed가 출발지를 붙인다', () => {
  const { state } = run([
    ev('voyage.started', { voyageId: 'v2' }),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-seville' }),
  ], placeMap);
  assert.equal(state.current.voyageId, 'v2');
  assert.deepEqual(state.current.from, SEVILLE);
  assert.equal(state.records.length, 0);
});

test('voyage.ended 뒤 유예 안에 입항하면 도착지가 있는 기록 하나만 남는다', () => {
  const { state, closed } = run([
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    ev('voyage.started', { voyageId: 'v3' }),
    ev('voyage.ended', { voyageId: 'v3' }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }),
  ], placeMap);
  assert.equal(closed.length, 1);
  assert.equal(state.records.length, 1);
  assert.deepEqual(state.records[0].to, LONDON);
  // 이미 닫혔으므로 유예가 지나도 더 생기지 않는다.
  assert.equal(expireLeg(state, 10_000_000).closed, null);
});

test('바다에서 끝나 입항이 없으면 유예 뒤 "도착지 모름"으로 닫는다', () => {
  const { state } = run([
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    ev('voyage.started', { voyageId: 'v4' }),
    ev('voyage.ended', { voyageId: 'v4' }, 50_000),
  ], placeMap);
  assert.notEqual(state.current.endingSince, null);
  assert.equal(expireLeg(state, 50_000 + END_GRACE_MS - 1).closed, null);
  const result = expireLeg(state, 50_000 + END_GRACE_MS);
  assert.equal(result.closed.to, null);
  assert.equal(result.closed.arrivedAt, 50_000);
  assert.equal(result.state.current, null);
  assert.equal(result.state.records.length, 1);
  // 늦게 온 입항은 무시한다(이미 닫힘).
  const late = applyEvent(result.state, ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }), LONDON);
  assert.equal(late.closed, null);
  assert.equal(late.state.records.length, 1);
});

test('입항 뒤 voyage.ended는 기록을 더 만들지 않는다', () => {
  const { state, closed } = run([
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    ev('voyage.started', { voyageId: 'v5' }),
    ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }),
    ev('voyage.ended', { voyageId: 'v5' }),
  ], placeMap);
  assert.equal(closed.length, 1);
  assert.equal(state.current, null);
  assert.equal(state.records.length, 1);
});

test('입항을 놓친 채 다시 출항하면 앞 항차를 "도착지 모름"으로 닫는다', () => {
  const { state, closed } = run([
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }),
    ev('voyage.started', { voyageId: 'v6' }),
    ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-london' }),
  ], placeMap);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closed.to, null);
  assert.equal(closed[0].arrived, false);
  assert.deepEqual(state.current.from, LONDON);
});

test('revision이 같거나 낮은 이벤트는 무시한다(시각이 아니라 revision으로 판단)', () => {
  const first = { kind: 'shore.departed', eventId: 'a', revision: 10, occurredAtUnixMillis: 5_000, confidence: 1, data: { shoreContext: 'port', nearestPoiId: 'poi-lisbon' } };
  let state = applyEvent(emptyState(), first, LISBON).state;
  const older = { ...first, eventId: 'b', revision: 9, occurredAtUnixMillis: 9_000, kind: 'shore.arrived', data: { shoreContext: 'port', nearestPoiId: 'poi-london' } };
  const result = applyEvent(state, older, LONDON);
  assert.equal(result.changed, false);
  assert.deepEqual(result.state.current.from, LISBON);
  // 시각이 더 이르더라도 revision이 크면 처리한다.
  const newer = { ...older, eventId: 'c', revision: 11, occurredAtUnixMillis: 1_000 };
  state = applyEvent(state, newer, LONDON).state;
  assert.equal(state.records.length, 1);
});

test('출항 없이 입항만 오면 기록하지 않는다', () => {
  const result = applyEvent(emptyState(), ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }), LONDON);
  assert.equal(result.closed, null);
  assert.equal(result.state.records.length, 0);
});

test('다른 항차의 voyage snapshot은 열린 항차 값을 바꾸지 않는다', () => {
  const { state } = run([ev('voyage.started', { voyageId: 'v7' })]);
  assert.equal(updateMetrics(state, { voyageId: 'other', sailingDays: 3, knots: 5 }).changed, false);
  const updated = updateMetrics(state, { voyageId: 'v7', sailingDays: 3, knots: 5 }).state;
  // 끝날 때 snapshot이 비어도 마지막 값을 유지한다.
  const kept = updateMetrics(updated, { voyageId: 'v7', sailingDays: null, knots: null });
  assert.equal(kept.changed, false);
  assert.equal(kept.state.current.metrics.sailingDays, 3);
});

test('voyage snapshot에서 항해일수와 평균 속도를 고른다', () => {
  const toKnots = (unitsPerSecond) => unitsPerSecond * 2;
  const base = { voyageId: 'v', state: 'underway', startedAtUnixMillis: 7 };
  const metrics = metricsFromVoyage({ ...base, lastSailingDays: 6, distanceTravelled: 300, elapsedMillis: 60_000 }, toKnots);
  assert.deepEqual(metrics, { voyageId: 'v', startedAt: 7, sailingDays: 6, knots: 10 });
  assert.equal(metricsFromVoyage({ ...base, lastSailingDays: 1, distanceTravelled: 300, elapsedMillis: 2_000 }, toKnots).knots, null);
  assert.equal(metricsFromVoyage({ ...base, distanceTravelled: 300, elapsedMillis: 60_000 }, () => null).knots, null);
  assert.equal(metricsFromVoyage({ ...base, voyageId: null }, toKnots), null);
  // 멈춰 있는 snapshot은 쓰지 않는다.
  assert.equal(metricsFromVoyage({ ...base, state: 'idle', lastSailingDays: 6 }, toKnots), null);
});

test('출항 뒤 멈춰 있는 앞 항차 snapshot이 와도 출발지를 잃지 않는다', () => {
  let state = applyEvent(emptyState(), ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }, 100_000), LISBON).state;
  // 앞 항차(old)의 값이 남은 snapshot: idle이면 metricsFromVoyage가 거르고, 시작 시각이 이르면 updateMetrics가 거른다.
  assert.equal(metricsFromVoyage({ voyageId: 'old', state: 'idle', startedAtUnixMillis: 1_000, lastSailingDays: 11 }, (v) => v), null);
  const stale = updateMetrics(state, { voyageId: 'old', startedAt: 1_000, sailingDays: 11, knots: 7 });
  assert.equal(stale.changed, false);
  state = applyEvent(state, ev('voyage.started', { voyageId: 'new' }, 101_000)).state;
  state = updateMetrics(state, { voyageId: 'new', startedAt: 100_500, sailingDays: 4, knots: 9 }).state;
  const result = applyEvent(state, ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }, 200_000), LONDON);
  assert.equal(result.state.records.length, 1);
  assert.deepEqual(result.state.records[0].from, LISBON);
  assert.equal(result.state.records[0].voyageId, 'new');
  assert.equal(result.state.records[0].sailingDays, 4);
  // voyage.started 없이도 출항 뒤 시작한 항차 snapshot은 받아들인다.
  const solo = applyEvent(emptyState(), ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }, 100_000), LISBON).state;
  assert.equal(updateMetrics(solo, { voyageId: 'x', startedAt: 99_000, sailingDays: 1, knots: 5 }).changed, true);
});

test('service 재시작 때 항해 중이면 출발지를 모르는 항차로 다시 연다', () => {
  const snapshot = { voyageId: 'v8', state: 'underway', startedAtUnixMillis: 100_000 };
  const plain = resumeFromSnapshot(emptyState(), snapshot);
  assert.equal(plain.changed, true);
  assert.equal(plain.state.current.from, null);
  const departure = { revision: 42, occurredAtUnixMillis: 99_000, data: { nearestPoiId: 'poi-lisbon' } };
  const withDeparture = resumeFromSnapshot(emptyState(), snapshot, departure, LISBON);
  assert.deepEqual(withDeparture.state.current.from, LISBON);
  // 같은 출항 이벤트가 구독으로 다시 와도 무시한다.
  assert.equal(applyEvent(withDeparture.state, { ...departure, kind: 'shore.departed', eventId: 'd' }, LISBON).changed, false);
  const oldDeparture = { occurredAtUnixMillis: 1_000, data: { nearestPoiId: 'poi-lisbon' } };
  assert.equal(resumeFromSnapshot(emptyState(), snapshot, oldDeparture, LISBON).state.current.from, null);
  assert.equal(resumeFromSnapshot(emptyState(), { ...snapshot, state: 'idle' }).changed, false);
});

test('기록은 최근 500항차까지, 가장 오래된 것부터 버린다', () => {
  let records = [];
  for (let index = 0; index < MAX_RECORDS + 5; index += 1) records = prependRecord(records, record(`r${index}`, LISBON, LONDON, 5));
  assert.equal(records.length, MAX_RECORDS);
  assert.equal(records[0].recordId, `r${MAX_RECORDS + 4}`);
  assert.equal(records.at(-1).recordId, 'r5');
  assert.equal(prependRecord(records, records[3]), records);
});

test('저장값이 망가져도 읽을 수 있는 기록만 남긴다', () => {
  const records = normalizeRecords([null, { recordId: 'x' }, { recordId: 'ok', arrivedAt: 5, from: { poiId: 'a', name: 'A' }, to: 'bad', sailingDays: '3' }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].to, null);
  assert.equal(records[0].sailingDays, null);
  assert.equal(normalizeRecords('nope').length, 0);
  assert.equal(normalizeLeg({ legId: '' }), null);
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
  assert.ok(csv.startsWith('﻿도착 시각,출발 시각,출발 거점 ID,출발,도착 거점 ID,도착,항해일수,평균 속도(kn)\r\n'));
  const line = csv.split('\r\n')[1];
  assert.ok(line.includes(',"p,1","산 ""마르코"", 항",,도착지 모름,3,9.3'), line);
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(toCsv([]).split('\r\n').length, 2);
});

test('거점 캐시는 ID마다 getPoi로 풀고 빈도 제한이면 다시 시도한다', async () => {
  const calls = [];
  let limited = 1;
  const resolver = createResolver(async (poiId) => {
    calls.push(poiId);
    if (poiId === 'old' && limited > 0) {
      limited -= 1;
      throw Object.assign(new Error('limit'), { code: 'request.rateLimited' });
    }
    if (poiId === 'gone') return null;
    return { poiId: poiId === 'old' ? 'new' : poiId, name: `이름-${poiId}` };
  }, { delay: async () => {} });
  assert.equal(await resolver.ensure(['old', 'gone', 'old', 'kept']), true);
  assert.equal(resolver.resolve('old'), 'new');
  assert.equal(resolver.nameOf('old'), '이름-old');
  assert.equal(resolver.resolve('gone'), 'gone');
  assert.equal(resolver.nameOf('gone'), null);
  assert.equal(resolver.has('gone'), true);
  assert.deepEqual(calls, ['old', 'old', 'gone', 'kept']);
  await resolver.ensure(['old']);
  assert.equal(calls.length, 4);
  resolver.reset();
  assert.equal(resolver.has('old'), false);
  assert.deepEqual(placeIdsOf([record('r', LISBON, null, 1)]), ['poi-lisbon']);
});

function fakeStorage(initial = {}) {
  let revisionNo = 1;
  let values = { ...initial };
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
  const timers = [];
  let clock = 0;
  const places = { 'poi-lisbon': LISBON, 'poi-london': LONDON, 'poi-london-old': { poiId: 'poi-london', name: '런던' } };
  const getPoi = async (poiId) => places[poiId] ?? null;
  const recorder = createRecorder({
    storage,
    resolver: createResolver(getPoi, { delay: async () => {} }),
    getPoi,
    toKnots: (value) => value,
    notify: async (input) => { notices.push(input); return { notificationId: 'n', deduplicated: false }; },
    toastEnabled: () => toast,
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle] = null; },
    onError: (error) => { throw error; },
  });
  return {
    recorder,
    notices,
    advance(ms) {
      clock += ms;
      for (const timer of timers) if (timer && timer.at <= clock) { timer.at = Infinity; timer.fn(); }
    },
    setClock(value) { clock = value; },
  };
}

test('service 흐름: 이벤트 순서대로 저장하고 도착 toast에 지난 평균과의 차이를 넣는다', async () => {
  const storage = fakeStorage({ [RECORDS_KEY]: [record('old', LISBON, { poiId: 'poi-london-old', name: '런던' }, 10)] });
  const { recorder, notices } = makeRecorder(storage);
  // start 전에 온 이벤트도 저장값을 읽은 뒤 처리한다.
  void recorder.event(ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }));
  await recorder.start({ values: (await storage.getSnapshot()).values, voyage: null, recentDeparture: null });
  await recorder.idle();
  assert.deepEqual(storage.values[CURRENT_KEY].from, LISBON);
  await recorder.event(ev('voyage.started', { voyageId: 'v9' }));
  await recorder.voyage({ voyageId: 'v9', state: 'underway', startedAtUnixMillis: 0, lastSailingDays: 11, distanceTravelled: 840, elapsedMillis: 100_000 });
  assert.equal(storage.values[CURRENT_KEY].metrics.sailingDays, 11);
  await recorder.event(ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }));
  assert.equal(storage.values[CURRENT_KEY], null);
  assert.equal(storage.values[RECORDS_KEY].length, 2);
  assert.equal(storage.values[RECORDS_KEY][0].knots, 8.4);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, '런던 도착 · 11일');
  assert.ok(notices[0].body.includes('지난 평균보다 1일 느림'), notices[0].body);
  assert.equal(notices[0].presentation, 'toast');
  assert.equal('sound' in notices[0], false);
});

test('service 흐름: 바다에서 끝나면 유예 뒤 저장하고 toast는 띄우지 않는다', async () => {
  const storage = fakeStorage();
  const harness = makeRecorder(storage);
  await harness.recorder.start({ values: {}, voyage: null, recentDeparture: null });
  await harness.recorder.event(ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }));
  harness.setClock(1_000);
  await harness.recorder.event(ev('voyage.ended', { voyageId: 'v10' }, 1_000));
  assert.notEqual(storage.values[CURRENT_KEY].endingSince, null);
  harness.advance(END_GRACE_MS + 100);
  await harness.recorder.idle();
  assert.equal(storage.values[CURRENT_KEY], null);
  assert.equal(storage.values[RECORDS_KEY][0].to, null);
  assert.equal(harness.notices.length, 0);
});

test('service 흐름: 패널이 지운 기록을 되살리지 않고, 알림을 끄면 toast가 없다', async () => {
  const storage = fakeStorage({ [RECORDS_KEY]: [record('old', LISBON, LONDON, 10)] });
  const { recorder, notices } = makeRecorder(storage, { toast: false });
  await recorder.start({ values: (await storage.getSnapshot()).values, voyage: null, recentDeparture: null });
  await recorder.event(ev('shore.departed', { shoreContext: 'port', nearestPoiId: 'poi-lisbon' }));
  storage.set(RECORDS_KEY, []);
  await recorder.event(ev('shore.arrived', { shoreContext: 'port', nearestPoiId: 'poi-london' }));
  assert.equal(storage.values[RECORDS_KEY].length, 1);
  assert.equal(storage.values[RECORDS_KEY][0].recordId === 'old', false);
  assert.equal(notices.length, 0);
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
  assert.deepEqual([...EVENT_KINDS].sort(), ['shore.arrived', 'shore.departed', 'voyage.ended', 'voyage.started']);
});
