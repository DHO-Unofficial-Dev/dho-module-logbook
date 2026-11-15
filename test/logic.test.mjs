// SDK 없이 도는 순수 로직 검사. 실행: node --test test/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_RECORDS,
  applyEvent,
  applyVoyage,
  arrivalNotice,
  compareWithPast,
  emptyState,
  formatDiff,
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
  assert.deepEqual(metricsFromVoyage(snap('v', 6, { distanceTravelled: 300, elapsedMillis: 60_000 }), (v) => v * 2), { voyageId: 'v', sailingDays: 6, knots: 10 });
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
  assert.ok(csv.startsWith('﻿도착 시각,출발 시각,출발 거점 ID,출발,도착 거점 ID,도착,항해일수,평균 속도(kn)\r\n'));
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
  assert.deepEqual([...EVENT_KINDS].sort(), ['shore.arrived', 'shore.departed', 'voyage.ended', 'voyage.started']);
});
