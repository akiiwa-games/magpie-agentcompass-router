// Sandbox only: logs what a real Magpie is about to send a provider, for an upstream the sandbox can't read the requests of.
// Model, effort and whether the flag is there; never the messages.
export function onProvider(body, ctx = {}) {
  const needs = body?.needs && typeof body.needs === "object" ? body.needs : {};
  console.log(
    `route-observer ${JSON.stringify({
      model: body?.model ?? null,
      effort: body?.reasoning_effort ?? body?.reasoning?.effort ?? null,
      flag: Boolean(body && ("realtime_loop" in body || "realtime_loop" in needs)),
      provider: ctx.provider?.id ?? null,
    })}`
  );
  return undefined;
}
