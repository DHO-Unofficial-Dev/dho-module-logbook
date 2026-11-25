// 방문별 누적값만 저장한다. runtime은 service 메모리에만 두고 복원 때 null로 시작한다.
export const REGION_SPEED_MAX_GAP_MS = 10_000;
export const MAX_REGION_STAT_SEGMENTS = 16;
export const MAX_REGION_STATS_JSON_LENGTH = 16_384;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value) => finite(value) && value >= 0;

/** 옛 기록에는 stats를 새로 만들지 않는다. 잘못 저장된 구간은 제외한다. */
export function normalizeRegionStats(value) {
  // 완료 기록은 SDK의 JSON 노드 상한을 지키려고 stats만 문자열로 저장할 수 있다.
  if (typeof value === 'string') {
    if (value.length > MAX_REGION_STATS_JSON_LENGTH) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || !Array.isArray(value.segments)) return null;
  const segments = value.segments.filter((s) => s && (s.season === 'summer' || s.season === 'winter')
    && finite(s.at) && finite(s.lastAt) && s.lastAt >= s.at
    && Number.isSafeInteger(s.samples) && s.samples > 0
    && nonnegative(s.min) && nonnegative(s.max) && s.max >= s.min
    && nonnegative(s.durationMs) && nonnegative(s.integralKnotsMs)
    && (s.durationMs > 0 || s.integralKnotsMs === 0))
    .slice(-MAX_REGION_STAT_SEGMENTS)
    .map((segment) => {
      const { season, at, lastAt, samples, min, max, durationMs, integralKnotsMs } = segment;
      return { season, at, lastAt, samples, min, max, durationMs, integralKnotsMs,
        ...(Object.hasOwn(segment, 'sailingDays') ? { sailingDays: nonnegative(segment.sailingDays) ? segment.sailingDays : null } : {}) };
    });
  return segments.length ? { segments } : null;
}

/** 한 표본 또는 연결할 수 없었던 표본만 있으면 평균을 추정하지 않는다. */
export function regionStatsAverage(segment) {
  return segment && segment.durationMs > 0 ? segment.integralKnotsMs / segment.durationMs : null;
}

/**
 * 마지막 해역 방문에 live 속도를 불변 갱신한다. at은 수신시각이 아닌 관측시각이다.
 * sailing은 입항 전 항해 여부이며 season은 호출자가 seasonAt(at)으로 계산한다.
 * changed는 저장값 변경, boundary는 새 통계/계절 구간 시작이다. 계절 구간은 최근 16개만 보관한다.
 * 같은 계절의 10초 이내 연속 관측만 사다리꼴 적분한다. 계절 경계의 미관측 속도는 추정하지 않는다.
 * sailingDays는 호출자가 live 검증한 항해일수이며 counterId는 해당 voyageId다.
 * 같은 counterId의 연속 판독 차이만 합산하고, 일수를 못 읽거나 감소하면 그 구간을 잇지 않는다.
 */
export function applyRegionSpeed(regions, runtime, observation) {
  const unchanged = (nextRuntime = runtime) => ({ regions, runtime: nextRuntime, changed: false, boundary: false });
  const visit = regions.at(-1);
  if (!visit) return unchanged(null);
  const key = `${regions.length}:${visit.regionId}:${visit.at}`;
  const saved = visit.stats?.segments ?? [];
  const previous = runtime?.key === key ? runtime : { key, lastAt: saved.at(-1)?.lastAt ?? null, previous: null };
  const { at, speedKnots, live, sailing, season, sailingDays, counterId } = observation ?? {};
  if (!finite(at) || live !== true || sailing !== true || !nonnegative(speedKnots)
    || (season !== 'summer' && season !== 'winter')) {
    return unchanged({ ...previous, previous: null });
  }
  if (at < visit.at || (previous.lastAt !== null && at <= previous.lastAt)) return unchanged(previous);
  const last = saved.at(-1);
  const boundary = !last || last.season !== season;
  const segment = boundary
    ? { season, at, lastAt: at, samples: 0, min: speedKnots, max: speedKnots, durationMs: 0, integralKnotsMs: 0, sailingDays: null }
    : { ...last };
  const prior = previous.previous;
  const span = prior ? at - prior.at : 0;
  if (!boundary && prior?.season === season && span > 0 && span <= REGION_SPEED_MAX_GAP_MS) {
    segment.durationMs += span;
    segment.integralKnotsMs += (prior.speedKnots / 2 + speedKnots / 2) * span;
    if (typeof counterId === 'string' && counterId.length > 0 && counterId === prior.counterId
      && nonnegative(sailingDays) && nonnegative(prior.sailingDays) && sailingDays >= prior.sailingDays) {
      const accumulated = (segment.sailingDays ?? 0) + (sailingDays - prior.sailingDays);
      if (finite(accumulated)) segment.sailingDays = accumulated;
    }
  }
  segment.samples += 1;
  segment.lastAt = at;
  segment.min = Math.min(segment.min, speedKnots);
  segment.max = Math.max(segment.max, speedKnots);
  const segments = boundary ? [...saved, segment] : [...saved.slice(0, -1), segment];
  return {
    regions: [...regions.slice(0, -1), { ...visit, stats: { segments: segments.slice(-MAX_REGION_STAT_SEGMENTS) } }],
    runtime: { key, lastAt: at, previous: { at, speedKnots, season,
      sailingDays: nonnegative(sailingDays) ? sailingDays : null,
      counterId: typeof counterId === 'string' && counterId.length > 0 ? counterId : null } },
    changed: true,
    boundary,
  };
}
