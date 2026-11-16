// 항차 기록의 순수 로직. SDK를 쓰지 않으므로 node --test로 바로 검사한다.
//
// 항차 경계는 Navigator의 voyageId를 따른다. 항차는 입항으로 끝나지 않고 다음 출항(또는 사용자가 새 항차를 직접
// 시작)할 때 `voyage.ended` → `voyage.started`로 바뀐다. 그래서 기록은 voyageId 하나에 하나이며,
// 입항(`shore.arrived`) 때 바로 표에 넣고(도착지 = 그 항차의 마지막 입항) `voyage.ended` 때 확정한다.
//
// 상태 모양: { current: Leg | null, pending: Departure | null, records: Record[], lastEventRevision: number | null }
// Leg (지금 항차)
//   { voyageId, from: Place | null, fromEstimated, to: Place | null, departedAt, arrivedAt, metrics: Metrics | null,
//     regions: RegionVisit[] }
// Departure (voyage.started보다 먼저 온 출항. 다음 항차의 출발지가 된다)
//   { from: Place | null, at }
// Place
//   { poiId, name }
// RegionVisit (지나간 해역. 같은 해역이 연달아 오면 한 번만)
//   { regionId, name, at }
// Metrics (그 voyageId의 voyage snapshot에서 고른 마지막 값)
//   { sailingDays, knots, distance }
// Record (최신이 앞, recordId = voyageId)
//   { recordId, voyageId, from, fromEstimated, to, sailingDays, knots, distance, straight, regions, compare,
//     departedAt, arrivedAt, final }
//   distance: 항차 이동 거리(월드 단위), straight: 출발·도착 거점 직선 거리, compare: 'auto' | 'include' | 'exclude'

export const MAX_RECORDS = 500;
export const MAX_REGIONS = 64;
/** 이동 거리가 직선 거리의 이 배수를 넘으면 우회 항차로 본다. */
export const DETOUR_RATIO = 2;
/** 출발지를 추정할 때 첫 측량 위치에서 도시까지의 최대 거리. Navigator 입항 판정과 같다. */
export const DEPARTURE_ESTIMATE_RADIUS = 120;
/** 첫 측량 위치는 항차를 연 시각 근처의 것만 쓴다(그 뒤 지나가는 도시를 출발지로 잡지 않게). */
export const DEPARTURE_ESTIMATE_WINDOW_MS = 60_000;
const WORLD_WIDTH = 16384;
const COMPARE_MODES = new Set(['auto', 'include', 'exclude']);

export function emptyState() {
  return { current: null, pending: null, records: [], lastEventRevision: null };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function normalizePlace(value) {
  if (!isObject(value)) return null;
  const poiId = stringOrNull(value.poiId);
  if (!poiId) return null;
  return { poiId, name: typeof value.name === 'string' ? value.name : '' };
}

function normalizeMetrics(value) {
  if (!isObject(value)) return null;
  return { sailingDays: finiteOrNull(value.sailingDays), knots: finiteOrNull(value.knots), distance: finiteOrNull(value.distance) };
}

export function normalizeRegions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const regionId = stringOrNull(item.regionId);
    const at = finiteOrNull(item.at);
    if (!regionId || at === null) continue;
    out.push({ regionId, name: typeof item.name === 'string' ? item.name : '', at });
  }
  return out.slice(-MAX_REGIONS);
}

export function normalizeRecord(value) {
  if (!isObject(value)) return null;
  const recordId = stringOrNull(value.recordId);
  const arrivedAt = finiteOrNull(value.arrivedAt);
  if (!recordId || arrivedAt === null) return null;
  return {
    recordId,
    voyageId: stringOrNull(value.voyageId),
    from: normalizePlace(value.from),
    fromEstimated: value.fromEstimated === true,
    to: normalizePlace(value.to),
    sailingDays: finiteOrNull(value.sailingDays),
    knots: finiteOrNull(value.knots),
    distance: finiteOrNull(value.distance),
    straight: finiteOrNull(value.straight),
    regions: normalizeRegions(value.regions),
    compare: COMPARE_MODES.has(value.compare) ? value.compare : 'auto',
    departedAt: finiteOrNull(value.departedAt),
    arrivedAt,
    final: value.final !== false,
  };
}

export function normalizeRecords(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const record = normalizeRecord(item);
    if (record) out.push(record);
    if (out.length >= MAX_RECORDS) break;
  }
  return out;
}

export function normalizeLeg(value) {
  if (!isObject(value)) return null;
  const voyageId = stringOrNull(value.voyageId);
  if (!voyageId) return null;
  return {
    voyageId,
    from: normalizePlace(value.from),
    fromEstimated: value.fromEstimated === true,
    to: normalizePlace(value.to),
    straight: finiteOrNull(value.straight),
    departedAt: finiteOrNull(value.departedAt),
    arrivedAt: finiteOrNull(value.arrivedAt),
    metrics: normalizeMetrics(value.metrics),
    regions: normalizeRegions(value.regions),
  };
}

export function normalizePending(value) {
  if (!isObject(value)) return null;
  const at = finiteOrNull(value.at);
  if (at === null) return null;
  return { from: normalizePlace(value.from), at };
}

/**
 * 같은 recordId면 그 자리에서 바꾸고, 없으면 앞에 넣는다. 500개를 넘으면 가장 오래된 것부터 버린다.
 * 사용자가 고른 비교 포함 여부(`compare`)는 service가 같은 항차를 다시 써도 지키고, 해역 경로가 없는 값으로 덮지 않는다.
 */
export function upsertRecord(records, record) {
  const index = records.findIndex((item) => item.recordId === record.recordId);
  if (index >= 0) {
    const previous = records[index];
    const next = [...records];
    next[index] = {
      ...record,
      compare: record.compare === 'auto' && previous.compare ? previous.compare : record.compare,
      regions: record.regions && record.regions.length > 0 ? record.regions : previous.regions ?? [],
    };
    return next;
  }
  return [record, ...records].slice(0, MAX_RECORDS);
}

/** 지금 항차를 기록 모양으로. 입항이 없었으면 도착지 모름이고 시각은 `at`이다. */
export function legToRecord(leg, final, at) {
  return {
    recordId: leg.voyageId,
    voyageId: leg.voyageId,
    from: leg.from,
    fromEstimated: leg.fromEstimated === true,
    to: leg.to,
    sailingDays: leg.metrics ? leg.metrics.sailingDays : null,
    knots: leg.metrics ? leg.metrics.knots : null,
    distance: leg.metrics ? leg.metrics.distance ?? null : null,
    straight: leg.straight ?? null,
    regions: leg.regions ?? [],
    compare: 'auto',
    departedAt: leg.departedAt,
    arrivedAt: leg.arrivedAt ?? at,
    final,
  };
}

function openLeg(voyageId, pending, at) {
  return {
    voyageId,
    from: pending ? pending.from : null,
    fromEstimated: false,
    to: null,
    straight: null,
    departedAt: pending ? pending.at : at,
    arrivedAt: null,
    metrics: null,
    regions: [],
  };
}

/** 지나간 해역을 붙인다. 같은 해역이 연달아 오면 붙이지 않고, 오래된 것부터 버려 64개를 넘기지 않는다. */
export function appendRegion(regions, visit) {
  const last = regions.at(-1);
  if (last && last.regionId === visit.regionId) return regions;
  return [...regions, visit].slice(-MAX_REGIONS);
}

/** X축이 순환하는 월드의 두 점 사이 직선 거리. */
export function worldDistance(a, b) {
  const rawX = Math.abs(a.x - b.x) % WORLD_WIDTH;
  const dx = Math.min(rawX, WORLD_WIDTH - rawX);
  return Math.hypot(dx, a.y - b.y);
}

/**
 * 첫 측량 위치로 고른 출발지를 지금 항차에 넣는다. 출발·도착지를 아직 모르는 같은 항차에만 넣고, 나중에 출항
 * 판정(`shore.departed`)이 오면 그것이 이긴다.
 */
export function applyDepartureEstimate(state, voyageId, place) {
  const current = state.current;
  if (!place || !current || current.voyageId !== voyageId || current.from !== null || current.to !== null) {
    return { state, changed: false };
  }
  return { state: { ...state, current: { ...current, from: place, fromEstimated: true } }, changed: true };
}

/**
 * 펼친 줄의 "비교에 넣기/빼기"를 누른 뒤의 값. 자동 판정과 같아지면 'auto'로 되돌려, 나중에 판정이 바뀌어도 따른다.
 */
export function nextCompareMode(record) {
  const wanted = !includedInComparison(record);
  if (wanted === !isDetour(record)) return 'auto';
  return wanted ? 'include' : 'exclude';
}

/** 패널에서 고른 비교 포함 여부를 그 기록에만 쓴다. 없는 기록이면 그대로 돌려준다. */
export function setRecordCompare(records, recordId, mode) {
  if (!COMPARE_MODES.has(mode)) return records;
  const index = records.findIndex((record) => record.recordId === recordId);
  if (index < 0 || records[index].compare === mode) return records;
  const next = [...records];
  next[index] = { ...records[index], compare: mode };
  return next;
}

/**
 * 이벤트 하나를 상태에 반영한다. 순서는 `revision`으로만 판단하며 이미 본 revision은 무시한다.
 * `place`는 service가 이벤트의 `nearestPoiId`를 거점으로 풀어 준 값이다(없으면 null).
 * 결과: { state, upsert: Record | null, arrived: boolean, changed: boolean }
 *   upsert: 표에 넣거나 바꿀 기록(입항 때는 확정 전, 항차가 끝날 때는 확정)
 */
export function applyEvent(state, event, place = null) {
  const unchanged = { state, upsert: null, arrived: false, changed: false };
  if (!isObject(event) || typeof event.kind !== 'string') return unchanged;
  const revision = finiteOrNull(event.revision);
  if (revision !== null && state.lastEventRevision !== null && revision <= state.lastEventRevision) return unchanged;
  const at = finiteOrNull(event.occurredAtUnixMillis) ?? 0;
  const data = isObject(event.data) ? event.data : {};
  let { current, pending, records } = state;
  let upsert = null;
  let arrived = false;

  const finish = (leg) => {
    // 그 항차의 마지막 입항이 있으면 그것을 확정하고, 없으면 도착지 모름으로 남긴다.
    upsert = legToRecord(leg, true, at);
    records = upsertRecord(records, upsert);
  };

  switch (event.kind) {
    case 'voyage.ended': {
      const voyageId = stringOrNull(data.voyageId);
      if (current && current.voyageId === voyageId) {
        finish(current);
        current = null;
      }
      break;
    }
    case 'voyage.started': {
      const voyageId = stringOrNull(data.voyageId);
      if (!voyageId) break;
      if (current && current.voyageId === voyageId) {
        // snapshot이 먼저 이 항차를 열었다. 먼저 온 출항이 있으면 붙인다.
        if (pending && (current.from === null || (current.fromEstimated && pending.from)) && current.to === null) {
          current = { ...current, from: pending.from, fromEstimated: false, departedAt: pending.at };
          pending = null;
        }
        break;
      }
      // voyage.ended를 놓쳤으면 앞 항차를 여기서 확정한다.
      if (current) finish(current);
      current = openLeg(voyageId, pending, at);
      pending = null;
      break;
    }
    case 'shore.departed': {
      // 거점을 모르는 출항 판정(place null)으로 추정 출발지를 지우지 않는다.
      if (current && current.to === null && (current.from === null || (current.fromEstimated && place))) {
        // 새 항차가 먼저 판정되고 출항이 뒤에 왔다. 첫 측량 위치로 추정한 출발지보다 출항 판정이 낫다.
        current = { ...current, from: place, fromEstimated: false, departedAt: at };
      } else {
        // 출항이 먼저 왔다(항해일수 판독이 늦음). 다음 voyage.started의 출발지로 둔다.
        pending = { from: place, at };
      }
      break;
    }
    case 'shore.arrived': {
      if (!current) break;
      current = { ...current, to: place, arrivedAt: at };
      upsert = legToRecord(current, false, at);
      records = upsertRecord(records, upsert);
      arrived = true;
      break;
    }
    case 'region.changed': {
      const regionId = stringOrNull(data.regionId);
      if (!current || !regionId) break;
      const regions = appendRegion(current.regions ?? [], {
        regionId,
        name: typeof data.name === 'string' ? data.name : '',
        at,
      });
      if (regions !== current.regions) current = { ...current, regions };
      break;
    }
    default:
      break;
  }
  const next = { ...state, current, pending, records, lastEventRevision: revision ?? state.lastEventRevision };
  const changed = current !== state.current || pending !== state.pending || records !== state.records;
  return { state: next, upsert, arrived, changed };
}

/**
 * voyage snapshot으로 지금 항차의 항해일수·평균 속도를 갱신한다. voyageId가 같은 snapshot만 쓴다.
 * Navigator를 다시 켜면 `voyage.started` 없이 저장된 항차를 이어 가므로, 열린 항차가 없거나 다른 항차면
 * snapshot의 voyageId로 항차를 연다(앞 항차는 확정). 기록에 이미 그 항차가 있으면 출발·도착지를 이어 받는다.
 * 결과: { state, upsert: Record | null, changed, persist }
 *   persist: 항차가 바뀌었거나 항해일수가 바뀌어 저장할 만한지(쓰기마다 전체 snapshot이 퍼지므로 줄인다)
 */
export function applyVoyage(state, snapshot, toKnots) {
  const metrics = metricsFromVoyage(snapshot, toKnots);
  const none = { state, upsert: null, changed: false, persist: false };
  if (!metrics) return none;
  let { current, pending, records } = state;
  let upsert = null;
  let switched = false;
  if (!current || current.voyageId !== metrics.voyageId) {
    // 사용자가 지운 뒤라도 같은 항차를 다시 열 뿐이다. 앞 항차는 확정한다.
    const at = finiteOrNull(snapshot.emittedAtUnixMillis) ?? 0;
    if (current) {
      upsert = legToRecord(current, true, at);
      records = upsertRecord(records, upsert);
    }
    const known = records.find((record) => record.recordId === metrics.voyageId);
    current = known
      ? {
        voyageId: known.recordId,
        from: known.from,
        fromEstimated: known.fromEstimated === true,
        to: known.to,
        straight: known.straight,
        departedAt: known.departedAt,
        arrivedAt: known.to ? known.arrivedAt : null,
        metrics: null,
        regions: known.regions ?? [],
      }
      : openLeg(metrics.voyageId, pending, finiteOrNull(snapshot.startedAtUnixMillis) ?? at);
    if (!known) pending = null;
    switched = true;
  }
  const prev = current.metrics ?? { sailingDays: null, knots: null, distance: null };
  const merged = {
    sailingDays: metrics.sailingDays ?? prev.sailingDays,
    knots: metrics.knots ?? prev.knots,
    distance: metrics.distance ?? prev.distance ?? null,
  };
  const daysChanged = merged.sailingDays !== prev.sailingDays;
  if (!switched && !daysChanged && merged.knots === prev.knots && merged.distance === prev.distance) return none;
  current = { ...current, metrics: merged };
  return { state: { ...state, current, pending, records }, upsert, changed: true, persist: switched || daysChanged };
}

/**
 * voyage snapshot에서 기록용 값을 고른다. `toKnots`는 월드 단위/초를 knot로 바꾸는 함수(SDK `geo.mapSpeedToKnots`).
 * 항해일수는 게임 화면 항해일수의 마지막 값(`lastSailingDays`, 차이가 아니다)이다.
 * 평균 속도는 이동 거리 ÷ 경과 시간이다. 경과 시간은 판독 공백을 포함하므로 공백이 있던 항차는 조금 낮게 나온다.
 */
export function metricsFromVoyage(snapshot, toKnots) {
  if (!isObject(snapshot)) return null;
  const voyageId = stringOrNull(snapshot.voyageId);
  if (!voyageId) return null;
  const distance = finiteOrNull(snapshot.distanceTravelled);
  const elapsed = finiteOrNull(snapshot.elapsedMillis);
  let knots = null;
  if (distance !== null && elapsed !== null && elapsed >= 10_000 && distance > 0) {
    knots = finiteOrNull(toKnots(distance / (elapsed / 1000)));
  }
  return { voyageId, sailingDays: finiteOrNull(snapshot.lastSailingDays), knots, distance };
}

// ── 같은 구간 비교 ──

const identity = (id) => id;

/** 출발·도착 거점 ID로 만든 구간 key. `resolve`는 통합된 거점(redirect)을 새 종착 ID로 바꾼다. 둘 중 하나라도 모르면 null. */
export function routeKey(record, resolve = identity) {
  if (!record.from || !record.to) return null;
  const from = resolve(record.from.poiId);
  const to = resolve(record.to.poiId);
  if (!from || !to) return null;
  return `${from}>${to}`;
}

// ── 게임 계절 ──
// SDK `clock`과 같은 공개 공식: 2005-03-16 04:30 UTC가 여름 4월 1일 00:00이고 현실 9시간마다 여름·겨울이 바뀐다.
// 지난 시각의 계절도 시각만으로 알 수 있어 예전 기록에도 계절이 붙는다.

const GAME_CLOCK_EPOCH_MS = Date.UTC(2005, 2, 16, 4, 30, 0);
const GAME_SEASON_REAL_MS = 9 * 60 * 60 * 1000;
export const SEASON_LABELS = Object.freeze({ summer: '여름', winter: '겨울' });

/** 현실 시각의 게임 계절('summer' | 'winter'). 시각을 모르면 null. */
export function seasonAt(unixMillis) {
  if (finiteOrNull(unixMillis) === null) return null;
  const elapsed = Math.max(unixMillis, GAME_CLOCK_EPOCH_MS) - GAME_CLOCK_EPOCH_MS;
  return Math.floor(elapsed / GAME_SEASON_REAL_MS) % 2 === 0 ? 'summer' : 'winter';
}

/** 항차의 계절. 비교 기준은 출발 계절(출발 시각을 모르면 도착 계절)이다. */
export function recordSeason(record) {
  const start = seasonAt(record.departedAt);
  const end = seasonAt(record.arrivedAt);
  return { key: start ?? end, start, end };
}

/** "여름", "겨울", 항차 중에 바뀌었으면 "여름→겨울". */
export function formatSeason(record) {
  const { start, end } = recordSeason(record);
  if (start && end && start !== end) return `${SEASON_LABELS[start]}→${SEASON_LABELS[end]}`;
  const one = start ?? end;
  return one ? SEASON_LABELS[one] : '-';
}

// ── 우회 판정 ──

/** 이동 거리가 직선의 2배를 넘는지. 거리를 모르면 우회가 아니다. */
export function isDetour(record) {
  return record.distance !== null && record.straight !== null && record.straight > 0
    && record.distance > record.straight * DETOUR_RATIO;
}

/** 이 기록을 최고·평균·비교에 넣는지. 사용자가 고른 값이 자동 판정보다 우선한다. */
export function includedInComparison(record) {
  if (record.compare === 'include') return true;
  if (record.compare === 'exclude') return false;
  return !isDetour(record);
}

/**
 * 구간 통계. `records`는 최신이 앞이다. `excludeRecordId`는 기준에서 뺄 기록(이번 항차).
 * `season`을 주면 그 계절 기록만 센다. 비교에서 뺀 기록(우회 등)은 세지 않는다.
 * 결과: { count, best, average } (best는 가장 적은 항해일수, 항해일수가 없는 기록은 횟수에만 센다)
 */
export function routeStats(records, key, resolve = identity, excludeRecordId = null, season = null) {
  let count = 0;
  let sum = 0;
  let measured = 0;
  let best = null;
  for (const record of records) {
    if (record.recordId === excludeRecordId) continue;
    if (!includedInComparison(record)) continue;
    if (routeKey(record, resolve) !== key) continue;
    if (season !== null && recordSeason(record).key !== season) continue;
    count += 1;
    if (record.sailingDays !== null) {
      measured += 1;
      sum += record.sailingDays;
      best = best === null ? record.sailingDays : Math.min(best, record.sailingDays);
    }
  }
  return { count, best, average: measured > 0 ? sum / measured : null };
}

/**
 * 같은 구간 통계를 같은 계절 기록으로 먼저 내고, 같은 계절에 잴 기록이 없으면 계절을 가리지 않는다.
 * 결과: routeStats 결과 + { sameSeason: boolean, season }
 */
export function seasonalRouteStats(records, key, season, resolve = identity, excludeRecordId = null) {
  if (season !== null) {
    const sameSeason = routeStats(records, key, resolve, excludeRecordId, season);
    if (sameSeason.average !== null) return { ...sameSeason, sameSeason: true, season };
  }
  return { ...routeStats(records, key, resolve, excludeRecordId), sameSeason: false, season };
}

/**
 * 기록 하나를 그보다 앞선(더 오래된) 같은 구간 기록의 평균과 비교한다. 같은 계절 기록을 먼저 쓴다.
 * 결과: { kind: 'unknown' } (구간을 모름) | { kind: 'excluded' } (비교에서 뺀 항차) | { kind: 'first' }
 *   | { kind: 'diff', diff, average, count, sameSeason }
 */
export function compareWithPast(records, index, resolve = identity) {
  const record = records[index];
  const key = routeKey(record, resolve);
  if (key === null || record.sailingDays === null) return { kind: 'unknown' };
  if (!includedInComparison(record)) return { kind: 'excluded' };
  const older = records.slice(index + 1);
  const stats = seasonalRouteStats(older, key, recordSeason(record).key, resolve);
  if (stats.average === null) return { kind: 'first' };
  return {
    kind: 'diff',
    diff: record.sailingDays - stats.average,
    average: stats.average,
    count: stats.count,
    sameSeason: stats.sameSeason,
  };
}

/**
 * 출발 거점이 같은 구간들을 횟수가 많은 순으로(같으면 최근 순) 돌려준다. `season`을 주면 그 계절 통계를 먼저 쓴다.
 */
export function routesFrom(records, fromPoiId, resolve = identity, limit = 3, season = null) {
  const from = resolve(fromPoiId);
  if (!from) return [];
  const seen = new Map();
  for (const record of records) {
    const key = routeKey(record, resolve);
    if (key === null || !key.startsWith(`${from}>`)) continue;
    if (!seen.has(key)) seen.set(key, { key, latest: record, order: seen.size });
  }
  const routes = [];
  for (const entry of seen.values()) {
    routes.push({ ...entry, stats: seasonalRouteStats(records, entry.key, season, resolve) });
  }
  routes.sort((a, b) => b.stats.count - a.stats.count || a.order - b.order);
  return routes.slice(0, limit);
}

// ── 표시 ──

export const UNKNOWN_PLACE = '도착지 모름';
export const UNKNOWN_DEPARTURE = '출발지 모름';

export function placeName(place, fallback) {
  if (!place) return fallback;
  return place.name || place.poiId;
}

export function formatDays(days) {
  if (days === null) return '-';
  return `${Math.round(days)}일`;
}

export function formatKnots(knots) {
  if (knots === null) return '-';
  return `${knots.toFixed(1)} kn`;
}

/** 비교 결과를 "−0.5일", "+1일", "같음", "첫 기록"처럼 짧게. */
export function formatDiff(comparison) {
  if (comparison.kind === 'unknown') return '-';
  if (comparison.kind === 'excluded') return '비교 안 함';
  if (comparison.kind === 'first') return '첫 기록';
  const rounded = Math.round(comparison.diff * 10) / 10;
  if (rounded === 0) return '같음';
  const text = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(1);
  return `${rounded < 0 ? '−' : '+'}${text}일`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 현지 시각 기준 "MM-DD". */
export function formatShortDate(unixMillis) {
  const date = new Date(unixMillis);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 현지 시각 기준 운행 시간 "MM-DD HH:mm~HH:mm". 날짜가 바뀌면 도착에도 날짜를 붙인다. 출발 시각을 모르면
 * 도착 "MM-DD HH:mm"만.
 */
export function formatTimeRange(departedAt, arrivedAt) {
  const end = new Date(arrivedAt);
  const endText = `${formatShortDate(arrivedAt)} ${formatClock(end)}`;
  if (finiteOrNull(departedAt) === null) return endText;
  const start = new Date(departedAt);
  const startText = `${formatShortDate(departedAt)} ${formatClock(start)}`;
  const sameDay = formatShortDate(departedAt) === formatShortDate(arrivedAt)
    && start.getFullYear() === end.getFullYear();
  return `${startText}~${sameDay ? formatClock(end) : endText}`;
}

/** 현지 시각 기준 "YYYY-MM-DD HH:mm". */
export function formatDateTime(unixMillis) {
  if (unixMillis === null) return '';
  const date = new Date(unixMillis);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 도착 toast 문구. 제목 80자·본문 500자 상한 안에 맞춘다. */
export function arrivalNotice(record, comparison) {
  const fromName = placeName(record.from, UNKNOWN_DEPARTURE);
  const toName = placeName(record.to, UNKNOWN_PLACE);
  const title = record.sailingDays === null ? `${toName} 도착` : `${toName} 도착 · ${formatDays(record.sailingDays)}`;
  const parts = [`${fromName} → ${toName}`];
  if (record.knots !== null) parts.push(`평균 ${formatKnots(record.knots)}`);
  let line = parts.join(' · ');
  if (comparison.kind === 'excluded') line += '\n우회 항차라 비교하지 않음';
  if (comparison.kind === 'first') line += '\n이 구간 첫 기록';
  if (comparison.kind === 'diff') {
    const rounded = Math.round(comparison.diff * 10) / 10;
    const amount = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(1);
    const basis = comparison.sameSeason ? '같은 계절 지난 평균' : '지난 평균';
    line += rounded === 0 ? `\n${basis}과 같음` : `\n${basis}보다 ${amount}일 ${rounded < 0 ? '빠름' : '느림'}`;
  }
  return { title: title.slice(0, 80), body: line.slice(0, 500) };
}

// ── CSV ──

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // 엑셀이 수식으로 읽지 않게 =·+·-·@로 시작하는 값 앞에 '를 붙인다(거점·해역 이름은 외부 데이터다).
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  // 정규식 literal에 따옴표를 넣으면 공개 도구의 import 검사기가 문자열로 잘못 읽으므로 includes로 확인한다.
  const quote = String.fromCharCode(34);
  const needsQuote = text.includes(quote) || text.includes(',') || text.includes('\r') || text.includes('\n');
  return needsQuote ? quote + text.split(quote).join(quote + quote) + quote : text;
}

export const CSV_HEADER = [
  '도착 시각', '출발 시각', '출발 거점 ID', '출발', '도착 거점 ID', '도착', '항해일수', '평균 속도(kn)',
  '계절', '비교', '지나간 해역',
];

/** 엑셀이 한글을 바로 읽도록 UTF-8 BOM을 붙인 CSV. 줄 끝은 CRLF. 최신 기록이 위. */
export function toCsv(records) {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const record of records) {
    lines.push([
      formatDateTime(record.arrivedAt),
      formatDateTime(record.departedAt),
      record.from ? record.from.poiId : '',
      record.from && record.fromEstimated ? `${placeName(record.from, UNKNOWN_DEPARTURE)}(추정)` : placeName(record.from, UNKNOWN_DEPARTURE),
      record.to ? record.to.poiId : '',
      placeName(record.to, UNKNOWN_PLACE),
      record.sailingDays === null ? '' : Math.round(record.sailingDays),
      record.knots === null ? '' : record.knots.toFixed(1),
      formatSeason(record),
      includedInComparison(record) ? '포함' : (isDetour(record) && record.compare === 'auto' ? '우회' : '뺌'),
      (record.regions ?? []).map((region) => region.name || region.regionId).join(' → '),
    ].map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvFileName(now) {
  const date = new Date(now);
  return `voyage-log-${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}.csv`;
}
