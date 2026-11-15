// storage 쓰기 도우미. 패널과 service가 같은 key를 쓰므로 expectedRevision으로 충돌을 확인하고 다시 시도한다.

export const RECORDS_KEY = 'records';
export const CURRENT_KEY = 'current';

const MAX_ATTEMPTS = 5;

/**
 * `mutate(values)`는 지금 저장값을 받아 storage operation 목록을 돌려준다(빈 목록이면 쓰지 않음).
 * @param {{ getSnapshot(): Promise<{ revision: number, values: object }>, batch(input: object): Promise<object> }} storage
 */
export async function commit(storage, mutate) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await storage.getSnapshot();
    const operations = mutate(snapshot.values ?? {});
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
