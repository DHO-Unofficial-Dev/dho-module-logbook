// 이벤트 → 항차 기록 처리. SDK 객체는 밖에서 넣으므로 가짜 storage로 순서별 동작을 검사할 수 있다.
import {
  END_GRACE_MS,
  applyEvent,
  arrivalNotice,
  compareWithPast,
  emptyState,
  expireLeg,
  metricsFromVoyage,
  normalizeLeg,
  normalizeRecords,
  prependRecord,
  resumeFromSnapshot,
  updateMetrics,
} from './log.js';
import { placeIdsOf } from './resolver.js';
import { CURRENT_KEY, RECORDS_KEY, commit } from './store.js';

export const EVENT_KINDS = Object.freeze(['shore.departed', 'voyage.started', 'shore.arrived', 'voyage.ended']);

/**
 * @param {object} deps
 * @param {object} deps.storage           SDK storage (getSnapshot, batch)
 * @param {object} deps.resolver          createResolver 결과
 * @param {(poiId: string) => Promise<{ poiId: string, name: string } | null>} deps.getPoi
 * @param {(mapUnitsPerSecond: number) => number | null} deps.toKnots
 * @param {(input: object) => Promise<unknown>} deps.notify  SDK notifications.show
 * @param {() => boolean} deps.toastEnabled
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(handle: unknown) => void} [deps.clearTimer]
 * @param {(error: unknown) => void} [deps.onError]
 */
export function createRecorder(deps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  const onError = deps.onError ?? (() => {});
  let state = emptyState();
  let queue = Promise.resolve();
  let graceTimer = null;
  let stopped = false;
  let started = false;
  /** start 전에 받은 이벤트. 저장값을 읽은 뒤 순서대로 처리한다. */
  const pending = [];

  /** 처리를 한 줄로 세운다. 이벤트 순서가 섞이지 않게 한다. */
  function enqueue(task) {
    queue = queue.then(task).catch(onError);
    return queue;
  }

  async function placeOf(poiId) {
    if (typeof poiId !== 'string' || poiId.length === 0) return null;
    try {
      const poi = await deps.getPoi(poiId);
      if (poi && typeof poi.poiId === 'string') return { poiId: poi.poiId, name: typeof poi.name === 'string' ? poi.name : '' };
    } catch (error) {
      onError(error);
    }
    return { poiId, name: '' };
  }

  async function persist(closed) {
    const result = await commit(deps.storage, (values) => {
      const operations = [{ kind: 'set', key: CURRENT_KEY, value: state.current }];
      if (closed) {
        // 패널이 그사이 기록을 지웠을 수 있으므로 지금 저장값에 새 기록만 더한다.
        operations.push({ kind: 'set', key: RECORDS_KEY, value: prependRecord(normalizeRecords(values[RECORDS_KEY]), closed) });
      }
      return operations;
    });
    state = { ...state, records: normalizeRecords(result.values?.[RECORDS_KEY]) };
  }

  function scheduleGrace() {
    if (graceTimer !== null) {
      clearTimer(graceTimer);
      graceTimer = null;
    }
    const leg = state.current;
    if (stopped || !leg || leg.endingSince === null) return;
    const remaining = Math.max(250, leg.endingSince + END_GRACE_MS - now() + 50);
    graceTimer = setTimer(() => {
      graceTimer = null;
      void enqueue(expireNow);
    }, remaining);
  }

  async function expireNow() {
    const result = expireLeg(state, now());
    if (!result.closed) {
      scheduleGrace();
      return;
    }
    state = result.state;
    await persist(result.closed);
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
    await persist(result.closed);
    scheduleGrace();
    if (result.closed && result.arrived) await announce(result.closed);
  }

  return {
    /** 저장된 열린 항차와 기록을 읽고, 필요하면 voyage snapshot으로 항차를 다시 연다. */
    start: (initial) => enqueue(async () => {
      const values = initial.values ?? {};
      state = {
        ...emptyState(),
        current: normalizeLeg(values[CURRENT_KEY]),
        records: normalizeRecords(values[RECORDS_KEY]),
      };
      if (initial.voyage) {
        const departure = initial.recentDeparture ?? null;
        const place = departure ? await placeOf(departure.data ? departure.data.nearestPoiId : null) : null;
        const resumed = resumeFromSnapshot(state, initial.voyage, departure, place);
        if (resumed.changed) {
          state = resumed.state;
          await persist(null);
        }
        const metrics = metricsFromVoyage(initial.voyage, deps.toKnots);
        if (metrics) state = updateMetrics(state, metrics).state;
      }
      if (state.current && state.current.endingSince !== null) await expireNow();
      scheduleGrace();
      started = true;
      for (const event of pending.splice(0)) await handleEvent(event);
    }),
    event: (event) => {
      if (!started) {
        pending.push(event);
        return queue;
      }
      return enqueue(() => handleEvent(event));
    },
    /** voyage snapshot마다 부른다. 항해일수가 바뀔 때만 저장한다(쓰기마다 전체 snapshot이 퍼지므로). */
    voyage: (snapshot) => enqueue(async () => {
      if (stopped) return;
      const metrics = metricsFromVoyage(snapshot, deps.toKnots);
      if (!metrics) return;
      const before = state.current;
      const result = updateMetrics(state, metrics);
      if (!result.changed) return;
      state = result.state;
      const after = state.current;
      const daysChanged = !before.metrics || before.metrics.sailingDays !== after.metrics.sailingDays;
      if (daysChanged || before.voyageId !== after.voyageId) await persist(null);
    }),
    /** 다른 화면(패널)이 지운 기록을 반영한다. */
    syncRecords(values) {
      state = { ...state, records: normalizeRecords(values?.[RECORDS_KEY]) };
    },
    stop() {
      stopped = true;
      if (graceTimer !== null) clearTimer(graceTimer);
      graceTimer = null;
    },
    getState: () => state,
    idle: () => queue,
  };
}
