/** Parse a JSON request body, or produce the 400 to send back. */
export async function readJson<T>(req: Request): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  try {
    const data = (await req.json()) as T;
    if (!data || typeof data !== "object") throw new Error("not an object");
    return { ok: true, data };
  } catch {
    return { ok: false, response: Response.json({ error: "The request was garbled. Reload and try again." }, { status: 400 }) };
  }
}

/**
 * Wrap a route handler so an unexpected error becomes a JSON 500 the app can show,
 * not an HTML error page, and gets logged with the route name.
 */
export function guarded<A extends unknown[]>(name: string, handler: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (e) {
      console.error(`[${name}]`, e);
      return Response.json({ error: "Something went wrong on the server. Try again in a moment." }, { status: 500 });
    }
  };
}
