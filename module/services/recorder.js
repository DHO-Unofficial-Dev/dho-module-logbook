// background service: 패널을 닫아 둬도 항차를 기록한다.
// 이벤트(voyage.ended·voyage.started·shore.departed·shore.arrived)와 voyage snapshot을 받아 storage에 남기고 도착 toast를 띄운다.
import { events, geo, notifications, settings, storage, telemetry, voyage, world } from '@dho/sdk';

import { DEPARTURE_ESTIMATE_RADIUS } from '../lib/log.js';
import { EVENT_KINDS, createRecorder } from '../lib/recorder.js';
import { createResolver } from '../lib/resolver.js';

const TOAST_SETTING = 'arrival-toast';

let toastEnabled = true;
const applySettings = (snapshot) => {
  const value = snapshot && snapshot.values ? snapshot.values[TOAST_SETTING] : undefined;
  toastEnabled = value !== false;
};

const getPoi = (poiId) => world.getPoi(poiId);
const resolver = createResolver(getPoi);
/** Navigator 입항 판정과 같은 거리·종류(항구·개척도시)로 가장 가까운 도시. */
async function nearbyPort(point) {
  const found = await world.nearby({ point, radius: DEPARTURE_ESTIMATE_RADIUS, kinds: ['port', 'guild_city'], limit: 1 });
  const poi = found[0] ? found[0].poi : null;
  return poi ? { poiId: poi.poiId, name: poi.name } : null;
}
const recorder = createRecorder({
  storage,
  resolver,
  getPoi,
  nearbyPort,
  toKnots: (value) => geo.mapSpeedToKnots(value),
  notify: (input) => notifications.show(input),
  toastEnabled: () => toastEnabled,
});

const stops = [];

applySettings(await settings.getSnapshot());
stops.push(await settings.subscribe(applySettings));

// 이벤트를 먼저 구독해 시작 정리 중에 생긴 이벤트도 놓치지 않는다(처리는 recorder 안에서 순서대로).
stops.push(await events.subscribe(EVENT_KINDS, (event) => { void recorder.event(event); }));

// Navigator를 다시 켜면 voyage.started 없이 저장된 항차를 이어 가므로 지금 항차는 snapshot으로 읽는다.
const [initial, voyageSnapshot] = await Promise.all([
  storage.getSnapshot(),
  voyage.getSnapshot().catch(() => null),
]);
await recorder.start({ values: initial.values, voyage: voyageSnapshot });

stops.push(await voyage.subscribe((snapshot) => { void recorder.voyage(snapshot); }));
// 출발지를 모르는 항차(Navigator를 켠 직후 등)는 첫 측량 위치에서 가까운 도시로 채운다.
stops.push(await telemetry.subscribe((snapshot) => { void recorder.position(snapshot.position); }));
stops.push(await storage.subscribe((snapshot) => {
  if (!snapshot.changedKeys || snapshot.changedKeys.includes('records')) recorder.syncRecords(snapshot.values);
}));

let catalogRevision = null;
try {
  stops.push(await world.subscribe((snapshot) => {
    // 월드 카탈로그가 바뀌면 통합된 거점(redirect)이 달라질 수 있으므로 거점 캐시를 비운다.
    if (catalogRevision !== null && snapshot.catalogRevision !== catalogRevision) resolver.reset();
    catalogRevision = snapshot.catalogRevision;
  }));
} catch {
  // world를 줄 수 없는 Host(미리보기 등)에서는 기록할 때 남긴 거점 ID로 비교한다.
}

addEventListener('dho-service-stop', () => {
  recorder.stop();
  for (const stop of stops) stop();
}, { once: true });
