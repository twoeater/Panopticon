export class ExecutionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`AI 작업 실행 제한 시간(${timeoutMs / 1000}초)을 초과했습니다. turn.timeoutSeconds를 확인해 주세요. 자동 재시도하지 않았습니다.`);
    this.name = "ExecutionTimeoutError";
  }
}
export async function withExecutionTimeout<T>(timeoutMs: number, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new ExecutionTimeoutError(timeoutMs)), timeoutMs);
  try {
    combined.throwIfAborted();
    const result = await operation(combined);
    combined.throwIfAborted();
    return result;
  } catch (error) {
    // Provider SDKs and child processes may replace the abort reason.
    if (timeout.signal.aborted && !signal.aborted) throw timeout.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
