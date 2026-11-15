// 거점 ID를 지금 월드 카탈로그의 종착 거점으로 푸는 캐시. SDK 함수는 밖에서 넣는다(테스트에서 바꿔 끼움).
// world.getPois는 같은 종착 ID를 한 번만 넣고 없는 ID를 빼므로 입력과 결과의 순서가 맞지 않는다.
// 그래서 ID마다 world.getPoi로 하나씩 푼다(getPoi는 참고 데이터 읽기 상한에 들지 않는다).

/**
 * @param {(poiId: string) => Promise<{ poiId: string, name: string } | null>} getPoi
 */
export function createResolver(getPoi) {
  /** poiId → { poiId, name } | null(지금 카탈로그에 없음) */
  let cache = new Map();
  let generation = 0;

  async function lookup(poiId) {
    const poi = await getPoi(poiId);
    return poi && typeof poi.poiId === 'string' ? { poiId: poi.poiId, name: typeof poi.name === 'string' ? poi.name : '' } : null;
  }

  return {
    /** 아직 풀지 않은 ID를 하나씩 푼다. 실패한 ID는 캐시에 넣지 않고 원래 ID를 그대로 쓴다. */
    async ensure(poiIds) {
      const started = generation;
      for (const poiId of new Set(poiIds)) {
        if (typeof poiId !== 'string' || cache.has(poiId)) continue;
        let value;
        try {
          value = await lookup(poiId);
        } catch {
          continue;
        }
        if (started !== generation) return false;
        cache.set(poiId, value);
      }
      return true;
    },
    /** 종착 ID. 모르면 원래 ID. */
    resolve(poiId) {
      const entry = cache.get(poiId);
      return entry ? entry.poiId : poiId;
    },
    /** 지금 카탈로그의 거점 이름. 모르면 null. */
    nameOf(poiId) {
      const entry = cache.get(poiId);
      return entry ? entry.name : null;
    },
    /** 이미 풀어 본 ID인지(없는 거점이었던 것 포함). */
    has(poiId) {
      return cache.has(poiId);
    },
    /** 카탈로그가 바뀌면 비운다. */
    reset() {
      generation += 1;
      cache = new Map();
    },
  };
}

/** 기록에 나오는 거점 ID 전부. */
export function placeIdsOf(records) {
  const ids = [];
  for (const record of records) {
    if (record.from) ids.push(record.from.poiId);
    if (record.to) ids.push(record.to.poiId);
  }
  return ids;
}
