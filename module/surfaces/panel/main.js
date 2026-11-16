// 패널: service가 storage에 남긴 기록을 보여 주고, 지금 항차는 voyage snapshot으로 바로 갱신한다.
import { files, geo, storage, voyage, world } from '@dho/sdk';

import {
  SEASON_LABELS,
  UNKNOWN_DEPARTURE,
  UNKNOWN_PLACE,
  compareWithPast,
  csvFileName,
  formatDays,
  formatDiff,
  formatKnots,
  formatSeason,
  formatTimeRange,
  includedInComparison,
  metricsFromVoyage,
  nextCompareMode,
  normalizeLeg,
  normalizeRecords,
  recordSeason,
  routesFrom,
  seasonAt,
  setRecordCompare,
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
/** 펼친 기록(recordId). 패널을 닫으면 잊는다. */
const expanded = new Set();

function showStatus(text) {
  els.status.textContent = text;
}

/** 지금 카탈로그 이름을 먼저, 없으면 기록할 때 남긴 이름을 쓴다. */
function nameOf(place, fallback) {
  if (!place) return fallback;
  return resolver.nameOf(place.poiId) || place.name || place.poiId;
}

/** 첫 측량 위치로 추정한 출발지에는 "(추정)"을 붙인다. */
function departureName(item) {
  const name = nameOf(item.from, UNKNOWN_DEPARTURE);
  return item.from && item.fromEstimated ? `${name}(추정)` : name;
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
  // 값은 voyageId로 묶는다. 다른 항차의 snapshot 값은 쓰지 않는다.
  const sameVoyage = metrics && current && current.voyageId === metrics.voyageId;
  if (!current) {
    line.textContent = '항차 정보를 기다리는 중 · 게임을 연결하고 항구를 떠나면 기록을 시작합니다';
    return;
  }
  const parts = [current.to ? '입항 · 다음 출항 때 확정' : '항해 중'];
  const route = el('b', null, `${departureName(current)} → ${current.to ? nameOf(current.to, UNKNOWN_PLACE) : '?'}`);
  const days = sameVoyage && metrics.sailingDays !== null ? metrics.sailingDays : current.metrics?.sailingDays ?? null;
  const knots = sameVoyage && metrics.knots !== null ? metrics.knots : current.metrics?.knots ?? null;
  const tail = [];
  if (days !== null) tail.push(current.to ? formatDays(days) : `${Math.round(days)}일째`);
  if (knots !== null) tail.push(`평균 ${formatKnots(knots)}`);
  if (voyageSnapshot && voyageSnapshot.trackingQuality !== 'tracking') tail.push('판독 대기');
  line.append(`${parts.join(' · ')} · `, route);
  if (tail.length > 0) line.append(` · ${tail.join(' · ')}`);
}

function renderCompare() {
  els.compare.replaceChildren();
  const fromPoiId = current && current.from ? current.from.poiId : records.find((record) => record.from && record.to)?.from.poiId;
  // 지금 항차(없으면 지금 시각)의 계절 기록을 먼저 보인다. 바람이 계절마다 바뀐다.
  const season = current ? recordSeason({ departedAt: current.departedAt, arrivedAt: Date.now() }).key : seasonAt(Date.now());
  const routes = fromPoiId ? routesFrom(records, fromPoiId, resolve, 3, season) : [];
  const shown = routes.filter((route) => route.stats.count > 0);
  for (const route of shown) {
    const item = el('li');
    const latest = route.latest;
    item.append(el('span', 'vl-compare__route', `${nameOf(latest.from, UNKNOWN_DEPARTURE)} → ${nameOf(latest.to, UNKNOWN_PLACE)}`));
    const stats = [route.stats.sameSeason ? `${SEASON_LABELS[route.stats.season]}` : '계절 무관'];
    if (route.stats.best !== null) stats.push(`최고 ${formatDays(route.stats.best)}`);
    if (route.stats.average !== null) stats.push(`평균 ${(Math.round(route.stats.average * 10) / 10).toString()}일`);
    stats.push(`기록 ${route.stats.count}회`);
    item.append(el('span', 'vl-compare__stats', ` · ${stats.join(' · ')}`));
    els.compare.append(item);
  }
  els.compareEmpty.hidden = shown.length > 0;
}

const COLUMN_COUNT = 6;

/** 펼친 줄 id. 새 기록이 앞에 들어와도 같은 항차를 가리키게 recordId로 만든다. */
function detailIdOf(recordId) {
  return `detail-${recordId.replace(/[^A-Za-z0-9_-]/gu, '_')}`;
}

/** 펼친 줄: 지나간 해역(들어간 때의 계절)과 비교 포함 여부 바꾸기. */
function renderDetail(record, detailId) {
  const row = el('tr', 'vl-detail');
  row.id = detailId;
  const cell = el('td');
  cell.colSpan = COLUMN_COUNT;
  const regions = record.regions ?? [];
  if (regions.length > 0) {
    const list = el('ol', 'vl-regions');
    list.setAttribute('aria-label', '지나간 해역');
    for (const region of regions) {
      const item = el('li', 'vl-region', region.name || region.regionId);
      const season = seasonAt(region.at);
      if (season) item.append(el('span', 'vl-mute', ` ${SEASON_LABELS[season]}`));
      list.append(item);
    }
    cell.append(list);
  } else {
    cell.append(el('p', 'vl-mute', '지나간 해역 기록이 없습니다(이 기능을 넣기 전 항차이거나 해역을 바꾸지 않았습니다).'));
  }
  const line = el('p', 'vl-detail__line');
  if (record.distance !== null && record.straight !== null && record.straight > 0) {
    line.append(`이동 거리 직선의 ${(record.distance / record.straight).toFixed(1)}배`);
  } else {
    line.append('이동 거리를 몰라 우회를 판정하지 않았습니다');
  }
  const included = includedInComparison(record);
  const toggle = el('button', 'vl-link', included ? '비교에서 빼기' : '비교에 넣기');
  toggle.type = 'button';
  toggle.dataset.recordId = record.recordId;
  toggle.dataset.role = 'compare';
  toggle.addEventListener('click', () => {
    const mode = nextCompareMode(record);
    commit(storage, (values) => {
      const stored = normalizeRecords(values[RECORDS_KEY]);
      const next = setRecordCompare(stored, record.recordId, mode);
      return next === stored ? [] : [{ kind: 'set', key: RECORDS_KEY, value: next }];
    }).catch(() => showStatus('바꾸지 못했습니다. 잠시 뒤 다시 시도하세요.'));
  });
  line.append(' · ', toggle);
  cell.append(line);
  row.append(cell);
  return row;
}

function renderRows() {
  // 줄을 모두 새로 그리므로, 누르던 펼치기·비교 버튼의 키보드 포커스를 다시 그린 같은 버튼으로 돌려준다.
  const focused = document.activeElement;
  const focusKey = focused && focused.dataset && focused.dataset.recordId
    ? { recordId: focused.dataset.recordId, role: focused.dataset.role }
    : null;
  const rows = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const row = el('tr');
    row.append(el('td', 'vl-time', formatTimeRange(record.departedAt, record.arrivedAt)));
    row.append(el('td', null, formatSeason(record)));
    const route = el('td');
    const open = expanded.has(record.recordId);
    const detailId = detailIdOf(record.recordId);
    const button = el('button', 'vl-expand', open ? '▾' : '▸');
    button.type = 'button';
    button.dataset.recordId = record.recordId;
    button.dataset.role = 'expand';
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-controls', detailId);
    button.setAttribute('aria-label', open ? '상세 접기' : '상세 펼치기');
    button.addEventListener('click', () => {
      if (expanded.has(record.recordId)) expanded.delete(record.recordId);
      else expanded.add(record.recordId);
      renderRows();
    });
    route.append(button, `${departureName(record)} → `);
    route.append(el('span', record.to ? null : 'vl-mute', nameOf(record.to, UNKNOWN_PLACE)));
    if (!record.final) route.append(el('span', 'vl-mute', ' (확정 전)'));
    if (!includedInComparison(record) && record.compare === 'auto') route.append(el('span', 'vl-detour', '우회'));
    row.append(route);
    row.append(el('td', 'vl-num', formatDays(record.sailingDays)));
    row.append(el('td', 'vl-num', formatKnots(record.knots)));
    const comparison = compareWithPast(records, index, resolve);
    let tone = 'vl-mute';
    if (comparison.kind === 'diff' && comparison.diff < -0.05) tone = 'vl-faster';
    if (comparison.kind === 'diff' && comparison.diff > 0.05) tone = 'vl-slower';
    row.append(el('td', `vl-num ${tone}`, formatDiff(comparison)));
    rows.push(row);
    if (open) rows.push(renderDetail(record, detailId));
  }
  els.rows.replaceChildren(...rows);
  if (focusKey) {
    const again = [...els.rows.querySelectorAll('button')].find((node) => (
      node.dataset.recordId === focusKey.recordId && node.dataset.role === focusKey.role
    ));
    if (again) again.focus();
  }
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
