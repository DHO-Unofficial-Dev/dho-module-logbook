import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecorder } from '../module/lib/recorder.js';

const place = (poiId) => ({ poiId, name: poiId });
const live = (at, quality = 'live', x = 2) => ({ quality, value: { x, y: 1 }, observedAtUnixMillis: at });
function setup(extra = {}) {
  let revision = 0;
  const values = {};
  const storage = {
    getSnapshot: async () => ({ revision, values: structuredClone(values) }),
    batch: async ({ operations }) => {
      for (const operation of operations) values[operation.key] = structuredClone(operation.value);
      return { revision: ++revision, values: structuredClone(values) };
    },
  };
  let eventRevision = 0;
  let queries = 0;
  const recorder = createRecorder({
    storage, getPoi: async (id) => place(id), toKnots: (n) => n,
    nearbyPort: async () => { queries++; return place('panama'); },
    toastEnabled: () => false, onError: (e) => { throw e; }, ...extra,
  });
  return { recorder, queries: () => queries,
    event: (kind, at, data = {}) => recorder.event({ kind, revision: ++eventRevision, occurredAtUnixMillis: at, data }),
  };
}
async function depart(h, at = 10_000, id = 'v1', port = 'portobelo') {
  await h.event('voyage.started', at, { voyageId: id });
  await h.event('shore.departed', at, { nearestPoiId: port });
}

test('운하 이동 뒤 첫 live 좌표로 기존 출발지를 보정하고 완료 기록은 보존한다', async () => {
  const h = setup();
  await h.recorder.start({ values: {} });
  await depart(h, 1_000, 'previous', 'lisbon');
  await h.event('shore.arrived', 3_000, { nearestPoiId: 'portobelo' });
  await h.event('voyage.ended', 4_000, { voyageId: 'previous' });
  await depart(h);
  await h.recorder.position(live(10_100));
  await h.event('shore.departed', 10_000, { nearestPoiId: 'portobelo' });
  assert.equal(h.recorder.getState().current.from.poiId, 'panama');
  assert.equal(h.recorder.getState().current.fromEstimated, true);
  assert.equal(h.recorder.getState().pending, null);
  await h.event('shore.arrived', 30_000, { nearestPoiId: 'edo' });
  const records = h.recorder.getState().records;
  assert.deepEqual(records.map((r) => [r.from.poiId, r.to.poiId]), [['panama', 'edo'], ['lisbon', 'portobelo']]);
});

test('출항 이벤트 처리 중 현재 좌표를 읽어 telemetry 구독의 다음 변화 없이 보정한다', async () => {
  const h = setup({ getPosition: async () => live(10_100) });
  await h.recorder.start({ values: {} });
  await depart(h);
  assert.equal(h.recorder.getState().current.from.poiId, 'panama');
  assert.equal(h.recorder.getState().pending, null);
});

test('정상 출항의 같은 도시는 추정 표시로 바꾸지 않는다', async () => {
  const h = setup({ nearbyPort: async () => place('portobelo') });
  await h.recorder.start({ values: {} });
  await depart(h);
  await h.recorder.position(live(10_100));
  assert.equal(h.recorder.getState().current.fromEstimated, false);
});

for (const [name, observation] of [
  ['held', live(10_100, 'held')], ['stale', live(10_100, 'stale')],
  ['60초 초과', live(70_001)], ['출항 전 오래된 좌표', live(4_999)],
  ['유한하지 않은 좌표', live(10_100, 'live', NaN)],
]) test(`${name} 관측으로 기존 출발지를 바꾸지 않는다`, async () => {
  const h = setup();
  await h.recorder.start({ values: {} });
  await depart(h);
  await h.recorder.position(observation);
  assert.equal(h.recorder.getState().current.from.poiId, 'portobelo');
  assert.equal(h.queries(), 0);
});

test('60초 초과 관측 다음의 역순 좌표는 출발지로 쓰지 않는다', async () => {
  const h = setup();
  await h.recorder.start({ values: {} });
  await depart(h);
  await h.recorder.position(live(80_000));
  await h.recorder.position(live(10_100));
  assert.equal(h.queries(), 0);
});

for (const port of ['edo', null]) test(`입항 뒤에는 출발지를 바꾸지 않는다 (${port})`, async () => {
  const h = setup();
  await h.recorder.start({ values: {} });
  await depart(h);
  await h.event('shore.arrived', 20_000, { nearestPoiId: port });
  await h.recorder.position(live(20_100));
  assert.equal(h.recorder.getState().current.from.poiId, 'portobelo');
  assert.equal(h.queries(), 0);
});

test('첫 측량에 근처 항구가 없으면 다음 항구로 출발지를 바꾸지 않는다', async () => {
  let calls = 0;
  const h = setup({ nearbyPort: async () => ++calls === 1 ? null : place('panama') });
  await h.recorder.start({ values: {} });
  await depart(h);
  await h.recorder.position(live(10_100));
  await h.recorder.position(live(10_200));
  assert.equal(calls, 1);
  assert.equal(h.recorder.getState().current.from.poiId, 'portobelo');
});

test('출항이 먼저 앞 snapshot에 붙어도 다음 실제 항차로 넘긴 뒤 검증한다', async () => {
  const h = setup();
  await h.recorder.start({ values: {}, voyage: {
    voyageId: 'old', state: 'underway', startedAtUnixMillis: 10_000, emittedAtUnixMillis: 10_000,
  } });
  await h.event('shore.departed', 10_000, { nearestPoiId: 'portobelo' });
  await h.recorder.position(live(10_100));
  await h.event('voyage.ended', 10_200, { voyageId: 'old' });
  await h.event('voyage.started', 10_200, { voyageId: 'new' });
  assert.equal(h.recorder.getState().current.from.poiId, 'panama');
  assert.equal(h.recorder.getState().records.length, 0);
});

 test('기존 도시를 보정한 직후 늦게 판정된 출항도 이전 도시로 되돌리지 않는다', async () => {
  const h = setup();
  await h.recorder.start({ values: {} });
  await depart(h);
  await h.recorder.position(live(10_100));
  await h.event('shore.departed', 10_500, { nearestPoiId: 'portobelo' });
  assert.equal(h.recorder.getState().current.from.poiId, 'panama');
  assert.equal(h.recorder.getState().current.fromEstimated, true);
  assert.equal(h.recorder.getState().pending, null);
});

test('관측시각이 같은 프레임의 출항 이벤트보다 앞서도 보정 도시를 보존한다',async()=>{
 const h=setup({getPosition:async()=>live(10000)});await h.recorder.start({values:{}});await depart(h,10050);
 assert.equal(h.recorder.getState().current.from.poiId,'panama');assert.equal(h.recorder.getState().pending,null);
});
