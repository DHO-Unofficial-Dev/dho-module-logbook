// 항차 기록의 순수 로직. SDK를 쓰지 않으므로 node --test로 바로 검사한다.
// 상태 모양: { current: Leg | null, records: Record[], lastEventRevision: number | null }
//
// Leg (열린 항차)
//   { legId, voyageId, from: Place | null, departed, departedAt, endingSince, metrics: Metrics | null }
//   departed: shore.departed로 열렸거나 출발지를 받았는지
// Place
//   { poiId, name }
// Metrics (service가 voyage snapshot으로 만든 값)
//   { voyageId, sailingDays, knots }
// Record (끝난 항차, 최신이 앞)
//   { recordId, voyageId, from: Place | null, to: Place | null, sailingDays, knots, departedAt, arrivedAt }

export const MAX_RECORDS = 500;
/** voyage.ended 뒤 shore.arrived를 기다리는 시간. 그 안에 입항이 오지 않으면 "도착지 모름"으로 닫는다. */
export const END_GRACE_MS = 8000;
/** 출항 이벤트와 항차 시작 시각의 허용 차이. */
const ADOPT_SLACK_MS = 60_000;

export function emptyState() {
  return { current: null, records: [], lastEventRevision: null };
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
  return {
    voyageId: stringOrNull(value.voyageId),
    sailingDays: finiteOrNull(value.sailingDays),
    knots: finiteOrNull(value.knots),
  };
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
    to: normalizePlace(value.to),
    sailingDays: finiteOrNull(value.sailingDays),
    knots: finiteOrNull(value.knots),
    departedAt: finiteOrNull(value.departedAt),
    arrivedAt,
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
  const legId = stringOrNull(value.legId);
  if (!legId) return null;
  return {
    legId,
    voyageId: stringOrNull(value.voyageId),
    from: normalizePlace(value.from),
    departed: value.departed === true,
    departedAt: finiteOrNull(value.departedAt),
    endingSince: finiteOrNull(value.endingSince),
    metrics: normalizeMetrics(value.metrics),
  };
}

/** 새 기록을 앞에 넣고 500개를 넘으면 가장 오래된 것부터 버린다. 같은 recordId는 두 번 넣지 않는다. */
export function prependRecord(records, record) {
  if (records.some((item) => item.recordId === record.recordId)) return records;
  return [record, ...records].slice(0, MAX_RECORDS);
}

function openLeg(legId, voyageId, from, at, departed) {
  return { legId, voyageId, from, departed, departedAt: at, endingSince: null, metrics: null };
}

function closeLeg(leg, to, at) {
  const metrics = leg.metrics;
  return {
    recordId: leg.legId,
    voyageId: leg.voyageId,
    from: leg.from,
    to,
    sailingDays: metrics ? metrics.sailingDays : null,
    knots: metrics ? metrics.knots : null,
    departedAt: leg.departedAt,
    arrivedAt: at,
  };
}

/**
 * 이벤트 하나를 상태에 반영한다. 이벤트 순서는 `revision`으로만 판단하며 이미 본 revision은 무시한다.
 * `place`는 service가 이벤트의 `nearestPoiId`를 거점으로 풀어 준 값이다(없으면 null).
 * 결과: { state, closed: Record | null, arrived: boolean, changed: boolean }
 */
export function applyEvent(state, event, place = null) {
  const unchanged = { state, closed: null, arrived: false, changed: false };
  if (!isObject(event) || typeof event.kind !== 'string') return unchanged;
  const revision = finiteOrNull(event.revision);
  if (revision !== null && state.lastEventRevision !== null && revision <= state.lastEventRevision) return unchanged;
  const at = finiteOrNull(event.occurredAtUnixMillis) ?? 0;
  const data = isObject(event.data) ? event.data : {};
  const legId = stringOrNull(event.eventId) ?? `leg-${revision ?? at}`;
  const next = { ...state, lastEventRevision: revision ?? state.lastEventRevision };
  let current = state.current;
  let records = state.records;
  let closed = null;
  let arrived = false;

  const closeCurrent = (to, closeAt) => {
    if (!current) return;
    closed = closeLeg(current, to, closeAt);
    records = prependRecord(records, closed);
    current = null;
  };

  switch (event.kind) {
    case 'shore.departed': {
      // data는 떠나기 직전 상태다. 출항 거점은 nearestPoiId.
      if (current && !current.departed && current.endingSince === null) {
        // voyage.started가 먼저 와서 출발지를 모르는 채 열린 항차에 출발지를 붙인다.
        current = { ...current, from: place, departed: true, departedAt: current.departedAt ?? at };
      } else {
        // 앞 항차의 입항을 놓쳤다. 도착지 모름으로 닫고 새로 연다.
        closeCurrent(null, at);
        current = openLeg(legId, null, place, at, true);
      }
      break;
    }
    case 'voyage.started': {
      const voyageId = stringOrNull(data.voyageId);
      if (current && current.endingSince === null && (current.voyageId === null || current.voyageId === voyageId)) {
        current = { ...current, voyageId };
      } else {
        closeCurrent(null, at);
        current = openLeg(legId, voyageId, null, at, false);
      }
      break;
    }
    case 'shore.arrived': {
      if (!current) return { ...unchanged, state: next, changed: next.lastEventRevision !== state.lastEventRevision };
      closeCurrent(place, at);
      arrived = true;
      break;
    }
    case 'voyage.ended': {
      const voyageId = stringOrNull(data.voyageId);
      if (current && current.endingSince === null && (current.voyageId === null || current.voyageId === voyageId)) {
        // 입항이 바로 뒤에 올 수 있으므로 잠시 기다린다(expireLeg).
        current = { ...current, voyageId: current.voyageId ?? voyageId, endingSince: at };
      }
      break;
    }
    default:
      return { ...unchanged, state: next, changed: next.lastEventRevision !== state.lastEventRevision };
  }
  return { state: { ...next, current, records }, closed, arrived, changed: true };
}

/**
 * service를 다시 시작했을 때 열린 항차가 없고 voyage snapshot이 항해 중이면 출발지를 모르는 항차로 다시 연다.
 * `recentDeparture`는 `events.getRecent('shore.departed')` 결과와 그 거점(`place`)이며, 이번 항차 시작 이후의
 * 출항일 때만 출발지로 쓴다.
 */
export function resumeFromSnapshot(state, snapshot, recentDeparture = null, place = null) {
  if (state.current || !isObject(snapshot)) return { state, changed: false };
  const voyageId = stringOrNull(snapshot.voyageId);
  if (!voyageId || snapshot.state !== 'underway') return { state, changed: false };
  const startedAt = finiteOrNull(snapshot.startedAtUnixMillis);
  const departedAt = isObject(recentDeparture) ? finiteOrNull(recentDeparture.occurredAtUnixMillis) : null;
  const useDeparture = departedAt !== null && startedAt !== null && departedAt >= startedAt - 60_000;
  const legId = `resume-${voyageId}`;
  const leg = openLeg(legId, voyageId, useDeparture ? place : null, useDeparture ? departedAt : startedAt, useDeparture);
  // 시작 중에 같은 출항 이벤트가 구독으로도 오면 다시 처리하지 않는다.
  const seen = useDeparture ? finiteOrNull(recentDeparture.revision) : null;
  const lastEventRevision = seen !== null && (state.lastEventRevision === null || seen > state.lastEventRevision) ? seen : state.lastEventRevision;
  return { state: { ...state, current: leg, lastEventRevision }, changed: true };
}

/** voyage.ended 뒤 유예 시간이 지나도 입항이 없으면 "도착지 모름"으로 닫는다. */
export function expireLeg(state, now, graceMs = END_GRACE_MS) {
  const leg = state.current;
  if (!leg || leg.endingSince === null || now - leg.endingSince < graceMs) return { state, closed: null };
  const closed = closeLeg(leg, null, leg.endingSince);
  return { state: { ...state, current: null, records: prependRecord(state.records, closed) }, closed };
}

/**
 * 열린 항차의 항해일수·평균 속도를 갱신한다. 다른 항차의 snapshot이나 빈 값은 무시한다.
 * 결과: { state, changed }
 */
export function updateMetrics(state, metrics) {
  const leg = state.current;
  if (!leg || !isObject(metrics)) return { state, changed: false };
  const voyageId = stringOrNull(metrics.voyageId);
  if (!voyageId || (leg.voyageId !== null && leg.voyageId !== voyageId)) return { state, changed: false };
  if (leg.voyageId === null) {
    // 출항으로 열린 항차는 그 뒤에 시작한 항차의 snapshot만 받아들인다(멈춰 있는 앞 항차 값을 가져오지 않게).
    const startedAt = finiteOrNull(metrics.startedAt);
    if (startedAt === null || leg.departedAt === null || startedAt < leg.departedAt - ADOPT_SLACK_MS) return { state, changed: false };
  }
  const prev = leg.metrics ?? { voyageId: null, sailingDays: null, knots: null };
  const merged = {
    voyageId,
    sailingDays: finiteOrNull(metrics.sailingDays) ?? prev.sailingDays,
    knots: finiteOrNull(metrics.knots) ?? prev.knots,
  };
  const changed = leg.voyageId !== voyageId
    || merged.sailingDays !== prev.sailingDays
    || merged.knots !== prev.knots;
  if (!changed) return { state, changed: false };
  return { state: { ...state, current: { ...leg, voyageId, metrics: merged } }, changed: true };
}

/**
 * voyage snapshot에서 기록용 값을 고른다. `toKnots`는 월드 단위/초를 knot로 바꾸는 함수(SDK `geo.mapSpeedToKnots`).
 * 항해일수는 게임 화면의 항해일수(출항 뒤 지난 날) 마지막 값이다.
 * 평균 속도는 이동 거리 ÷ 경과 시간이다. 판독 공백 구간은 거리에서 빠지므로 실제보다 조금 낮게 나올 수 있다.
 */
export function metricsFromVoyage(snapshot, toKnots) {
  if (!isObject(snapshot)) return null;
  const voyageId = stringOrNull(snapshot.voyageId);
  if (!voyageId) return null;
  // 항해 중·일시 정지일 때만 쓴다. 멈춰 있는 snapshot에는 앞 항차 값이 남아 있을 수 있다.
  if (snapshot.state !== 'underway' && snapshot.state !== 'paused') return null;
  const distance = finiteOrNull(snapshot.distanceTravelled);
  const elapsed = finiteOrNull(snapshot.elapsedMillis);
  let knots = null;
  if (distance !== null && elapsed !== null && elapsed >= 10_000 && distance > 0) {
    const value = toKnots(distance / (elapsed / 1000));
    knots = finiteOrNull(value);
  }
  return { voyageId, startedAt: finiteOrNull(snapshot.startedAtUnixMillis), sailingDays: finiteOrNull(snapshot.lastSailingDays), knots };
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

/**
 * 구간 통계. `records`는 최신이 앞이다. `excludeRecordId`는 기준에서 뺄 기록(이번 항차).
 * 결과: { count, best, average } (best는 가장 적은 항해일수, 항해일수가 없는 기록은 횟수에만 센다)
 */
export function routeStats(records, key, resolve = identity, excludeRecordId = null) {
  let count = 0;
  let sum = 0;
  let measured = 0;
  let best = null;
  for (const record of records) {
    if (record.recordId === excludeRecordId) continue;
    if (routeKey(record, resolve) !== key) continue;
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
 * 기록 하나를 그보다 앞선(더 오래된) 같은 구간 기록의 평균과 비교한다.
 * 결과: { kind: 'unknown' } (구간을 모름) | { kind: 'first' } | { kind: 'diff', diff, average, count }
 */
export function compareWithPast(records, index, resolve = identity) {
  const record = records[index];
  const key = routeKey(record, resolve);
  if (key === null || record.sailingDays === null) return { kind: 'unknown' };
  const older = records.slice(index + 1);
  const stats = routeStats(older, key, resolve);
  if (stats.average === null) return { kind: 'first' };
  return { kind: 'diff', diff: record.sailingDays - stats.average, average: stats.average, count: stats.count };
}

/** 출발 거점이 같은 구간들을 횟수가 많은 순으로(같으면 최근 순) 돌려준다. */
export function routesFrom(records, fromPoiId, resolve = identity, limit = 3) {
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
    routes.push({ ...entry, stats: routeStats(records, entry.key, resolve) });
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
  if (comparison.kind === 'first') line += '\n이 구간 첫 기록';
  if (comparison.kind === 'diff') {
    const rounded = Math.round(comparison.diff * 10) / 10;
    const amount = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(1);
    line += rounded === 0 ? '\n지난 평균과 같음' : `\n지난 평균보다 ${amount}일 ${rounded < 0 ? '빠름' : '느림'}`;
  }
  return { title: title.slice(0, 80), body: line.slice(0, 500) };
}

// ── CSV ──

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  // 정규식 literal에 따옴표를 넣으면 공개 도구의 import 검사기가 문자열로 잘못 읽으므로 includes로 확인한다.
  const quote = String.fromCharCode(34);
  const needsQuote = text.includes(quote) || text.includes(',') || text.includes('\r') || text.includes('\n');
  return needsQuote ? quote + text.split(quote).join(quote + quote) + quote : text;
}

export const CSV_HEADER = ['도착 시각', '출발 시각', '출발 거점 ID', '출발', '도착 거점 ID', '도착', '항해일수', '평균 속도(kn)'];

/** 엑셀이 한글을 바로 읽도록 UTF-8 BOM을 붙인 CSV. 줄 끝은 CRLF. 최신 기록이 위. */
export function toCsv(records) {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const record of records) {
    lines.push([
      formatDateTime(record.arrivedAt),
      formatDateTime(record.departedAt),
      record.from ? record.from.poiId : '',
      placeName(record.from, UNKNOWN_DEPARTURE),
      record.to ? record.to.poiId : '',
      placeName(record.to, UNKNOWN_PLACE),
      record.sailingDays === null ? '' : Math.round(record.sailingDays),
      record.knots === null ? '' : record.knots.toFixed(1),
    ].map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvFileName(now) {
  const date = new Date(now);
  return `voyage-log-${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}.csv`;
}
