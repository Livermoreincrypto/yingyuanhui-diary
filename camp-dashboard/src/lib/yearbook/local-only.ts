/** The yearbook endpoints expose private match data only to this loopback app. */
export function isLocalYearbookRequest(req: Request) {
  const host = (req.headers.get("host") || new URL(req.url).host).toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
