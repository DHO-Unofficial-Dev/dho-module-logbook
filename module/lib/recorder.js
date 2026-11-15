// 이벤트 → 항차 기록 처리. SDK 객체는 밖에서 넣으므로 가짜 storage로 순서별 동작을 검사할 수 있다.
import {
  applyEvent,
  applyVoyage,
  arrivalNotice,
  compareWithPast,
  emptyState,
  normalizeLeg,
  normalizePending,
  normalizeRecords,
  upsertRecord,
} from './log.js';
import { placeIdsOf } from './resolver.js';
import { CURRENT_KEY, PENDING_KEY, RECORDS_KEY, commit } from './store.js';

export const EVENT_KINDS = Object.freeze(['voyage.ended', 'voyage.started', 'shore.departed', 'shore.arrived']);

/**
 * @param {object} deps
 * @param {object} deps.storage           SDK storage (getSnapshot, batch)
 * @param {object} deps.resolver          createResolver 결과
 * @param {(poiId: string) => Promise<{ poiId: string, name: string } | null>} deps.getPoi
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
    await persist(result.upsert);
    if (result.upsert && result.arrived) await announce(result.upsert);
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
