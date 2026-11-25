// storage 쓰기 도우미. 패널과 service가 같은 key를 쓰므로 expectedRevision으로 충돌을 확인하고 다시 시도한다.

export const RECORDS_KEY = 'records';
export const CURRENT_KEY = 'current';
export const PENDING_KEY = 'pendingDeparture';

const MAX_ATTEMPTS = 5;

/**
 * `mutate(values)`는 지금 저장값을 받아 storage operation 목록을 돌려준다(빈 목록이면 쓰지 않음).
 * @param {{ getSnapshot(): Promise<{ revision: number, values: object }>, batch(input: object): Promise<object> }} storage
 */
export async function commit(storage, mutate) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await storage.getSnapshot();
    const operations = mutate(snapshot.values ?? {}).map((operation) => {
      if (operation.kind !== 'set' || operation.key !== RECORDS_KEY || !Array.isArray(operation.value)) return operation;
      // 방문별 누적 통계를 문자열로 보관하여 전체 기록의 SDK JSON 노드 비용을 억제한다.
      return { ...operation, value: operation.value.map(record => !Array.isArray(record?.regions) ? record : ({ ...record,
        regions: (record.regions || []).map(region => region.stats && typeof region.stats === 'object'
          ? { ...region, stats: JSON.stringify(region.stats) } : region),
      })) };
    });
    if (operations.length === 0) return snapshot;
    try {
      return await storage.batch({ expectedRevision: snapshot.revision, operations });
    } catch (error) {
      if (!error || error.code !== 'storage.conflict') throw error;
    }
  }
  const error = new Error('저장값이 계속 바뀌어 저장하지 못했습니다.');
  error.code = 'storage.conflict';
  throw error;
}
