// 이벤트 → 항차 기록 처리. SDK 객체는 밖에서 넣으므로 가짜 storage로 순서별 동작을 검사할 수 있다.
import {
  DEPARTURE_ESTIMATE_WINDOW_MS,
  applyDepartureEstimate,
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
import { placeIdsOf } from './resolver.js';
import { CURRENT_KEY, PENDING_KEY, RECORDS_KEY, commit } from './store.js';

export const EVENT_KINDS = Object.freeze(['voyage.ended', 'voyage.started', 'shore.departed', 'shore.arrived', 'region.changed']);

/**
 * @param {object} deps
 * @param {object} deps.storage           SDK storage (getSnapshot, batch)
 * @param {object} deps.resolver          createResolver 결과
 * @param {(poiId: string) => Promise<{ poiId: string, name: string, point?: { x: number, y: number } } | null>} deps.getPoi
 * @param {(point: { x: number, y: number }) => Promise<{ poiId: string, name: string } | null>} [deps.nearbyPort]
 *   첫 측량 위치에서 가까운 도시(없으면 null). 출발지를 모를 때 쓴다.
 * @param {(mapUnitsPerSecond: number) => number | null} deps.toKnots
 * @param {(input: object) => Promise<unknown>} deps.notify  SDK notifications.show
 * @param {() => boolean} deps.toastEnabled
 * @param {(error: unknown) => void} [deps.onError]
 */
export function createRecorder(deps) {
  const onError = deps.onError ?? (() => {});
  let state = emptyState();
  let queue = Promise.resolve();
  let stopped = false;
  let started = false;
  /** start 전에 받은 이벤트. 저장값을 읽은 뒤 순서대로 처리한다. */
  const pendingEvents = [];
  /** 거점 좌표(직선 거리용). getPoi로 처음 볼 때 채운다. */
  const points = new Map();
  /** 출발지 추정을 이미 해 본 항차. 첫 측량 위치 한 번만 본다. */
  let estimatedVoyageId = null;

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
    const result = applyEvent(state, event, place);
    state = result.state;
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

  /** 첫 측량 위치로 출발지를 추정한다. 항차를 연 시각 근처의 실제 판독(live) 위치 한 번만 본다. */
  async function handlePosition(observation) {
    if (stopped || !deps.nearbyPort) return;
    const current = state.current;
    if (!current || current.from !== null || current.to !== null || estimatedVoyageId === current.voyageId) return;
    if (!observation || observation.quality !== 'live' || !observation.value) return;
    const at = observation.observedAtUnixMillis;
    if (typeof at !== 'number' || current.departedAt === null) return;
    // 항차를 연 시각(Navigator가 그 항차를 처음 읽은 때)보다 한참 뒤의 위치는 바다 한가운데일 수 있어 쓰지 않는다.
    if (at < current.departedAt - 5_000) return;
    estimatedVoyageId = current.voyageId;
    if (at > current.departedAt + DEPARTURE_ESTIMATE_WINDOW_MS) return;
    let place = null;
    try {
      place = await deps.nearbyPort(observation.value);
    } catch (error) {
      onError(error);
    }
    const result = applyDepartureEstimate(state, current.voyageId, place);
    if (!result.changed) return;
    state = result.state;
    await persist(null);
  }

  async function handleVoyage(snapshot) {
    if (stopped) return;
    const result = applyVoyage(state, snapshot, deps.toKnots);
    if (!result.changed) return;
    state = result.state;
    if (result.persist || result.upsert) await persist(result.upsert);
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
    /** telemetry snapshot의 `position` 관측값마다 부른다. 출발지를 모르는 항차의 첫 측량 위치만 쓴다. */
    position: (observation) => {
      // snapshot이 자주 오므로 볼 일이 없는 관측은 큐에 넣지 않는다(최종 판정은 handlePosition이 다시 한다).
      const current = state.current;
      if (!started || !current || current.from !== null || current.to !== null) return queue;
      if (estimatedVoyageId === current.voyageId || !observation || observation.quality !== 'live') return queue;
      return enqueue(() => handlePosition(observation));
    },
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
