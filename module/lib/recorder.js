// 이벤트 → 항차 기록 처리. SDK 객체는 밖에서 넣으므로 가짜 storage로 순서별 동작을 검사할 수 있다.
import {
  DEPARTURE_ESTIMATE_WINDOW_MS,
  appendRegion,
  seasonAt,
  applyEvent,
  applyVoyage,
  arrivalNotice,
  compareWithPast,
  emptyState,
  normalizeLeg,
  normalizePending,
  normalizeRecords,
  upsertRecord,
  worldDistance,
} from './log.js';
import { applyRegionSpeed } from './region-stats.js';
import { placeIdsOf } from './resolver.js';
import { CURRENT_KEY, PENDING_KEY, RECORDS_KEY, commit } from './store.js';

export const EVENT_KINDS = Object.freeze(['voyage.ended', 'voyage.started', 'shore.departed', 'shore.arrived', 'region.changed']);

/**
 * @param {object} deps
 * @param {object} deps.storage           SDK storage (getSnapshot, batch)
 * @param {object} deps.resolver          createResolver 결과
 * @param {(poiId: string) => Promise<{ poiId: string, name: string, point?: { x: number, y: number } } | null>} deps.getPoi
 * @param {(point: { x: number, y: number }) => Promise<{ poiId: string, name: string } | null>} [deps.nearbyPort]
 *   첫 측량 위치에서 120 안쪽의 가까운 도시(없으면 null). 기존 출발지도 검증한다.
 * @param {() => object | Promise<object>} [deps.getPosition] 현재 telemetry.position 관측값
 * @param {(mapUnitsPerSecond: number) => number | null} deps.toKnots
 * @param {(input: object) => Promise<unknown>} deps.notify  SDK notifications.show
 * @param {() => boolean} deps.toastEnabled
 * @param {(error: unknown) => void} [deps.onError]
 */
export function createRecorder(deps) {
  const onError = deps.onError ?? (() => {});
  let state = emptyState();
  let latestVoyage = null, latestRegion = null, speedRuntime = null, lastStatsPersistAt = null;
  let queue = Promise.resolve();
  let stopped = false;
  let started = false;
  /** start 전에 받은 이벤트. 저장값을 읽은 뒤 순서대로 처리한다. */
  const pendingEvents = [];
  /** 거점 좌표(직선 거리용). getPoi로 처음 볼 때 채운다. */
  const points = new Map();
  /** 출발지 추정을 이미 해 본 항차. 첫 측량 위치 한 번만 본다. */
  let estimatedVoyageId = null;
  let latestPosition = null;
  let departureEvidence = null;

  /** 처리를 한 줄로 세운다. 이벤트 순서가 섞이지 않게 한다. */
  function enqueue(task) {
    queue = queue.then(task).catch(onError);
    return queue;
  }

  function rememberPoint(poi) {
    const point = poi && poi.point;
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) points.set(poi.poiId, { x: point.x, y: point.y });
  }

  async function pointOf(poiId) {
    if (points.has(poiId)) return points.get(poiId);
    try {
      rememberPoint(await deps.getPoi(poiId));
    } catch (error) {
      onError(error);
    }
    return points.get(poiId) ?? null;
  }

  /** 출발·도착 거점 직선 거리. 둘 중 하나라도 좌표를 모르면 null. */
  async function straightOf(leg) {
    if (!leg.from || !leg.to) return null;
    const [a, b] = await Promise.all([pointOf(leg.from.poiId), pointOf(leg.to.poiId)]);
    return a && b ? worldDistance(a, b) : null;
  }

  async function placeOf(poiId) {
    if (typeof poiId !== 'string' || poiId.length === 0) return null;
    try {
      const poi = await deps.getPoi(poiId);
      if (poi && typeof poi.poiId === 'string') {
        rememberPoint(poi);
        return { poiId: poi.poiId, name: typeof poi.name === 'string' ? poi.name : '' };
      }
    } catch (error) {
      onError(error);
    }
    return { poiId, name: '' };
  }

  async function persist(upsert) {
    const result = await commit(deps.storage, (values) => {
      const operations = [
        { kind: 'set', key: CURRENT_KEY, value: state.current },
        { kind: 'set', key: PENDING_KEY, value: state.pending },
      ];
      if (upsert) {
        // 패널이 그사이 기록을 지웠을 수 있으므로 지금 저장값에 이 항차만 넣거나 바꾼다.
        operations.push({ kind: 'set', key: RECORDS_KEY, value: upsertRecord(normalizeRecords(values[RECORDS_KEY]), upsert) });
      }
      return operations;
    });
    state = { ...state, records: normalizeRecords(result.values?.[RECORDS_KEY]) };
  }

  async function announce(record) {
    if (!deps.toastEnabled()) return;
    try {
      await deps.resolver.ensure(placeIdsOf(state.records));
      const index = state.records.findIndex((item) => item.recordId === record.recordId);
      const comparison = index >= 0
        ? compareWithPast(state.records, index, (id) => deps.resolver.resolve(id))
        : { kind: 'unknown' };
      const notice = arrivalNotice(record, comparison);
      await deps.notify({
        title: notice.title,
        body: notice.body,
        level: 'info',
        presentation: 'toast',
        dedupeKey: 'arrival',
      });
    } catch (error) {
      onError(error);
    }
  }

  async function handleEvent(event) {
    if (stopped) return;
    let place = null;
    if (event.kind === 'shore.departed' || event.kind === 'shore.arrived') {
      place = await placeOf(event.data ? event.data.nearestPoiId : null);
    }
    const before = state.current;
    const evidence = departureEvidence;
    const protectDeparture = event.kind === 'shore.departed' && before && before.to === null
      && before.arrivedAt === null && before.endedAt == null && evidence?.voyageId === before.voyageId
      && event.occurredAtUnixMillis >= evidence.departedAt - 5_000
      && event.occurredAtUnixMillis <= Math.max(evidence.observedAt, evidence.departedAt) + (evidence.correctedKnown ? 5_000 : 0);
    const result = applyEvent(state, event, place);
    // 같은 출항의 늦은 이벤트도 revision은 소비하되 검증된 도시와 출항시각은 보존한다.
    if (protectDeparture && result.state.current?.voyageId === before.voyageId) {
      result.state = { ...result.state, current: before, pending: state.pending };
    }
    state = result.state;
    if (['shore.arrived', 'shore.departed', 'voyage.ended', 'voyage.started'].includes(event.kind)) speedRuntime = null;
    if (event.kind === 'voyage.started' || event.kind === 'shore.departed') await checkDeparturePosition();
    if (!result.changed) return;
    let upsert = result.upsert;
    if (result.arrived && state.current) {
      // 우회 판정용 직선 거리는 입항으로 도착지가 정해질 때 잰다.
      const straight = await straightOf(state.current);
      state = { ...state, current: { ...state.current, straight } };
      if (upsert) upsert = { ...upsert, straight };
    }
    await persist(upsert);
    if (upsert && result.arrived) await announce(upsert);
  }

  function rememberPosition(observation) {
    if (!observation || observation.quality !== 'live' || !observation.value
      || !Number.isFinite(observation.observedAtUnixMillis)
      || !Number.isFinite(observation.value.x) || !Number.isFinite(observation.value.y)) return false;
    if (latestPosition && observation.observedAtUnixMillis < latestPosition.observedAtUnixMillis) return false;
    latestPosition = observation;
    return true;
  }

  async function checkDeparturePosition() {
    if (deps.getPosition) {
      try { const position = await deps.getPosition(); if (position?.quality !== 'live') return; rememberPosition(position); } catch (error) { onError(error); return; }
    }
    if (latestPosition) await handlePosition(latestPosition);
  }

  /** 첫 live 측량으로 출발지를 검증한다. 이미 입항했거나 끝난 항차는 수정하지 않는다. */
  async function handlePosition(observation) {
    if (stopped || !deps.nearbyPort || !rememberPosition(observation)) return;
    const current = state.current;
    if (!current || current.to !== null || current.arrivedAt !== null || current.endedAt != null
      || estimatedVoyageId === current.voyageId) return;
    // 앞 항차 snapshot에 출항이 먼저 붙은 경우 새 항차로 넘기는 기존 계약을 지킨다.
    if (current.openedBySnapshot && current.from !== null && !current.fromEstimated) return;
    const at = observation.observedAtUnixMillis;
    if (current.departedAt === null || at < current.departedAt - 5_000) return;
    estimatedVoyageId = current.voyageId;
    if (at > current.departedAt + DEPARTURE_ESTIMATE_WINDOW_MS) return;
    let place = null;
    try {
      place = await deps.nearbyPort(observation.value);
    } catch (error) {
      onError(error);
    }
    if (!place || typeof place.poiId !== 'string' || !place.poiId) return;
    departureEvidence = { voyageId: current.voyageId, departedAt: current.departedAt, observedAt: at,
      correctedKnown: current.from !== null && current.from.poiId !== place.poiId };
    if (current.from?.poiId === place.poiId) return;
    state = { ...state, current: { ...current, from: place, fromEstimated: true } };
    await persist(null);
  }

  async function handleVoyage(snapshot) {
    if (stopped) return;
    if (!latestVoyage || snapshot.emittedAtUnixMillis >= latestVoyage.emittedAtUnixMillis) latestVoyage = snapshot;
    const result = applyVoyage(state, snapshot, deps.toKnots);
    if (!result.changed) return;
    state = result.state;
    if (result.persist || result.upsert) await persist(result.upsert);
  }

  function sailing() {
    const leg = state.current;
    return leg && leg.to === null && leg.arrivedAt === null && leg.endedAt == null
      && latestVoyage?.voyageId === leg.voyageId && latestVoyage.state === 'underway'
      && latestVoyage.trackingQuality === 'tracking';
  }

  async function handleRegion(observation) {
    if (stopped || !started) return;
    if (observation?.quality !== 'live' || !observation.value?.regionId || !Number.isFinite(observation.observedAtUnixMillis)) {
      latestRegion = null; speedRuntime = null; return;
    }
    const at = observation.observedAtUnixMillis;
    if (latestRegion && at < latestRegion.observedAtUnixMillis) return;
    latestRegion = observation;
    const leg = state.current;
    if (!sailing() || at < leg.departedAt - 5000) return;
    const last = leg.regions.at(-1);
    if (last && at < last.at) return;
    const regions = appendRegion(leg.regions, { regionId: observation.value.regionId, name: observation.value.name || '', at });
    if (regions === leg.regions) return;
    speedRuntime = null;
    state = { ...state, current: { ...leg, regions } };
    await persist(null);
  }

  async function handleTelemetry(snapshot, region) {
    if (stopped || !started) return;
    await handlePosition(snapshot.position);
    if (region) await handleRegion(region);
    const leg = state.current;
    if (!leg) { speedRuntime = null; return; }
    const speed = snapshot.speedKnots;
    const at = speed?.observedAtUnixMillis;
    const regionAt = latestRegion?.observedAtUnixMillis;
    const matchesRegion = latestRegion?.quality === 'live' && Number.isFinite(at) && Number.isFinite(regionAt)
      && at >= regionAt && at - regionAt <= 10000 && leg.regions.at(-1)?.regionId === latestRegion.value.regionId;
    const days = snapshot.sailingDays;
    const daysValid = days?.quality === 'live' && days.observedAtUnixMillis === at
      && Number.isSafeInteger(days.value) && days.value >= 0;
    const result = applyRegionSpeed(leg.regions, speedRuntime, {
      sailingDays: daysValid ? days.value : null, counterId: leg.voyageId,
      at, speedKnots: speed?.value, live: speed?.quality === 'live' && snapshot.position?.quality === 'live' && matchesRegion,
      sailing: Boolean(sailing()), season: Number.isFinite(at) ? seasonAt(at) : null,
    });
    speedRuntime = result.runtime;
    if (!result.changed) return;
    state = { ...state, current: { ...leg, regions: result.regions } };
    if (result.boundary || lastStatsPersistAt === null || at - lastStatsPersistAt >= 15000) {
      await persist(null); lastStatsPersistAt = at;
    }
  }

  return {
    /**
     * 저장된 지금 항차와 기록을 읽고 voyage snapshot으로 맞춘다. Navigator를 다시 켜면 voyage.started 없이
     * 저장된 항차를 이어 가므로 snapshot의 voyageId가 기준이다.
     */
    start: (initial) => enqueue(async () => {
      const values = initial.values ?? {};
      state = {
        ...emptyState(),
        current: normalizeLeg(values[CURRENT_KEY]),
        pending: normalizePending(values[PENDING_KEY]),
        records: normalizeRecords(values[RECORDS_KEY]),
      };
      if (initial.voyage) await handleVoyage(initial.voyage);
      started = true;
      for (const event of pendingEvents.splice(0)) await handleEvent(event);
      await checkDeparturePosition();
    }),
    event: (event) => {
      if (!started) {
        pendingEvents.push(event);
        return queue;
      }
      return enqueue(() => handleEvent(event));
    },
    /** voyage snapshot마다 부른다. 그 voyageId의 마지막 값이 끝난 항차의 일수·속도가 된다. */
    voyage: (snapshot) => enqueue(() => handleVoyage(snapshot)),
    /** telemetry의 첫 유효 위치로 기존 출발지까지 검증한다. 시작 전 관측도 보관한다. */
    position: (observation) => enqueue(async () => {
      if (!rememberPosition(observation) || !started) return;
      await handlePosition(observation);
    }),
    region: (observation) => enqueue(() => handleRegion(observation)),
    telemetry: (snapshot, region) => enqueue(() => handleTelemetry(snapshot, region)),
    /** 다른 화면(패널)이 지운 기록을 반영한다. */
    syncRecords(values) {
      state = { ...state, records: normalizeRecords(values?.[RECORDS_KEY]) };
    },
    stop() {
      stopped = true;
    },
    getState: () => state,
    idle: () => queue,
  };
}
