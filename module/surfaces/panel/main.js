// 패널: service가 storage에 남긴 기록을 보여 주고, 지금 항차는 voyage snapshot으로 바로 갱신한다.
import { files, geo, storage, voyage, world } from '@dho/sdk';

import {
  UNKNOWN_DEPARTURE,
  UNKNOWN_PLACE,
  compareWithPast,
  csvFileName,
  formatDays,
  formatDiff,
  formatKnots,
  formatShortDate,
  metricsFromVoyage,
  normalizeLeg,
  normalizeRecords,
  routesFrom,
  toCsv,
} from '../../lib/log.js';
import { createResolver, placeIdsOf } from '../../lib/resolver.js';
import { CURRENT_KEY, RECORDS_KEY, commit } from '../../lib/store.js';

const $ = (id) => document.getElementById(id);
const root = document.querySelector('.vl');
const els = {
  count: $('count'),
  current: $('current'),
  compare: $('compare'),
  compareEmpty: $('compare-empty'),
  rows: $('rows'),
  recordsEmpty: $('records-empty'),
  exportButton: $('export'),
  clearButton: $('clear'),
  status: $('status'),
};

const resolver = createResolver((poiId) => world.getPoi(poiId));
const resolve = (id) => resolver.resolve(id);

let records = [];
let current = null;
let voyageSnapshot = null;
let resolving = false;
let resolveAgain = false;

function showStatus(text) {
  els.status.textContent = text;
}

/** 지금 카탈로그 이름을 먼저, 없으면 기록할 때 남긴 이름을 쓴다. */
function nameOf(place, fallback) {
  if (!place) return fallback;
  return resolver.nameOf(place.poiId) || place.name || place.poiId;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderCurrent() {
  const line = els.current;
  line.replaceChildren();
  const metrics = metricsFromVoyage(voyageSnapshot, (value) => geo.mapSpeedToKnots(value));
  const sameVoyage = metrics && current && (current.voyageId === null || current.voyageId === metrics.voyageId);
  if (!current) {
    const underway = voyageSnapshot && voyageSnapshot.state === 'underway';
    line.textContent = underway ? '항해 중 · 출발 항구를 확인하지 못해 다음 출항부터 기록합니다' : '정박 중 · 항구를 떠나면 기록을 시작합니다';
    return;
  }
  const parts = [];
  if (current.endingSince !== null) parts.push('항차 끝남 · 입항 확인 중');
  else parts.push('항해 중');
  const route = el('b', null, `${nameOf(current.from, UNKNOWN_DEPARTURE)} → ?`);
  const days = sameVoyage && metrics.sailingDays !== null ? metrics.sailingDays : current.metrics?.sailingDays ?? null;
  const knots = sameVoyage && metrics.knots !== null ? metrics.knots : current.metrics?.knots ?? null;
  const tail = [];
  if (days !== null) tail.push(`${Math.round(days)}일째`);
  if (knots !== null) tail.push(`평균 ${formatKnots(knots)}`);
  if (voyageSnapshot && voyageSnapshot.trackingQuality !== 'tracking') tail.push('판독 대기');
  line.append(`${parts.join(' · ')} · `, route);
  if (tail.length > 0) line.append(` · ${tail.join(' · ')}`);
}

function renderCompare() {
  els.compare.replaceChildren();
  const fromPoiId = current && current.from ? current.from.poiId : records.find((record) => record.from && record.to)?.from.poiId;
  const routes = fromPoiId ? routesFrom(records, fromPoiId, resolve) : [];
  const shown = routes.filter((route) => route.stats.count > 0);
  for (const route of shown) {
    const item = el('li');
    const latest = route.latest;
    item.append(el('span', 'vl-compare__route', `${nameOf(latest.from, UNKNOWN_DEPARTURE)} → ${nameOf(latest.to, UNKNOWN_PLACE)}`));
    const stats = [];
    if (route.stats.best !== null) stats.push(`최고 ${formatDays(route.stats.best)}`);
    if (route.stats.average !== null) stats.push(`평균 ${(Math.round(route.stats.average * 10) / 10).toString()}일`);
    stats.push(`기록 ${route.stats.count}회`);
    item.append(el('span', 'vl-compare__stats', ` · ${stats.join(' · ')}`));
    els.compare.append(item);
  }
  els.compareEmpty.hidden = shown.length > 0;
}

function renderRows() {
  const rows = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const row = el('tr');
    row.append(el('td', null, formatShortDate(record.arrivedAt)));
    const route = el('td', null, `${nameOf(record.from, UNKNOWN_DEPARTURE)} → `);
    route.append(el('span', record.to ? null : 'vl-mute', nameOf(record.to, UNKNOWN_PLACE)));
    row.append(route);
    row.append(el('td', 'vl-num', formatDays(record.sailingDays)));
    row.append(el('td', 'vl-num', formatKnots(record.knots)));
    const comparison = compareWithPast(records, index, resolve);
    let tone = 'vl-mute';
    if (comparison.kind === 'diff' && comparison.diff < -0.05) tone = 'vl-faster';
    if (comparison.kind === 'diff' && comparison.diff > 0.05) tone = 'vl-slower';
    row.append(el('td', `vl-num ${tone}`, formatDiff(comparison)));
    rows.push(row);
  }
  els.rows.replaceChildren(...rows);
  els.recordsEmpty.hidden = records.length > 0;
  els.count.textContent = records.length > 0 ? `${records.length} / 500항차` : '';
  els.exportButton.disabled = records.length === 0;
  els.clearButton.disabled = records.length === 0;
}

function render() {
  root.dataset.state = 'ready';
  renderCurrent();
  renderCompare();
  renderRows();
}

/** 기록에 나오는 거점을 지금 카탈로그로 풀고(통합된 거점은 새 ID로) 다시 그린다. */
async function resolvePlaces() {
  if (resolving) {
    resolveAgain = true;
    return;
  }
  resolving = true;
  try {
    do {
      resolveAgain = false;
      const ids = placeIdsOf(records);
      if (current && current.from) ids.push(current.from.poiId);
      const pending = ids.filter((id) => !resolver.has(id));
      if (pending.length > 0 && (await resolver.ensure(pending))) render();
    } while (resolveAgain);
  } finally {
    resolving = false;
  }
}

function applyValues(values) {
  records = normalizeRecords(values?.[RECORDS_KEY]);
  current = normalizeLeg(values?.[CURRENT_KEY]);
  render();
  void resolvePlaces();
}

// CSV 내보내기: 사용자 동작 안에서 바로 picker를 연다(앞에서 await하지 않는다).
els.exportButton.addEventListener('click', () => {
  if (records.length === 0) return;
  const text = toCsv(records);
  showStatus('');
  files.exportText({ suggestedName: csvFileName(Date.now()), text }).then((result) => {
    showStatus(result.status === 'exported' ? `${records.length}항차를 CSV로 내보냈습니다.` : '');
  }, (error) => {
    showStatus(error && error.code === 'files.busy' ? '파일 선택 창이 이미 열려 있습니다.' : '내보내지 못했습니다. 다시 시도하세요.');
  });
});

// 기록 지우기: 실수로 누르지 않도록 한 번 더 눌러야 지운다. 지금 항차는 남긴다.
let confirmTimer = null;
els.clearButton.addEventListener('click', () => {
  const button = els.clearButton;
  if (button.dataset.confirm !== 'true') {
    button.dataset.confirm = 'true';
    button.textContent = '한 번 더 누르면 모두 지웁니다';
    confirmTimer = setTimeout(() => {
      button.dataset.confirm = 'false';
      button.textContent = '기록 지우기';
    }, 4000);
    return;
  }
  clearTimeout(confirmTimer);
  button.dataset.confirm = 'false';
  button.textContent = '기록 지우기';
  commit(storage, () => [{ kind: 'set', key: RECORDS_KEY, value: [] }]).then(() => {
    showStatus('기록을 지웠습니다.');
  }, () => {
    showStatus('지우지 못했습니다. 잠시 뒤 다시 시도하세요.');
  });
});

const stops = [];
try {
  // storage.subscribe는 시작 snapshot을 먼저 주고, service가 쓴 새 값을 계속 준다.
  stops.push(await storage.subscribe((snapshot) => applyValues(snapshot.values)));
} catch {
  root.dataset.state = 'error';
  els.current.textContent = '저장된 기록을 읽지 못했습니다. 패널을 다시 열어 보세요.';
}

try {
  stops.push(await voyage.subscribe((snapshot) => {
    voyageSnapshot = snapshot;
    renderCurrent();
  }));
} catch {
  voyageSnapshot = null;
}

try {
  let catalogRevision = null;
  stops.push(await world.subscribe((snapshot) => {
    if (catalogRevision !== null && snapshot.catalogRevision !== catalogRevision) {
      resolver.reset();
      void resolvePlaces();
    }
    catalogRevision = snapshot.catalogRevision;
  }));
} catch {
  // 거점 이름은 기록할 때 남긴 이름으로 보인다.
}

addEventListener('pagehide', () => {
  clearTimeout(confirmTimer);
  for (const stop of stops) stop();
}, { once: true });
