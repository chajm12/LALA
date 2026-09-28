type InternalRouteOptions = {
  timeoutMs?: number;
  timeoutMessage?: string;
};

// Cover both connection and response-body reads. Aborting fetch alone does not
// bound a stalled upstream implementation, so the caller also races the result.
export async function callInternalJson(
  req: Request,
  path: string,
  body: unknown,
  options: InternalRouteOptions = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStopped: (reason: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const stop = (error: Error) => {
    rejectStopped(error);
    controller.abort(error);
  };
  const onAbort = () => stop(new Error("요청이 취소되었습니다."));
  req.signal.addEventListener("abort", onAbort, { once: true });
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => stop(new Error(options.timeoutMessage ?? "요청 시간이 초과되었습니다.")), options.timeoutMs);
  }
  if (req.signal.aborted) onAbort();

  const operation = async () => {
    controller.signal.throwIfAborted();
    const response = await fetch(new URL(path, req.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error(path + " 응답을 읽지 못했습니다 (HTTP " + response.status + ")."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(path + " 응답 형식이 올바르지 않습니다.");
    }
    const record = data as Record<string, unknown>;
    if (!response.ok) throw new Error(String(record.error ?? path + " 요청 실패"));
    return record;
  };
  try { return await Promise.race([operation(), stopped]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    req.signal.removeEventListener("abort", onAbort);
  }
}
