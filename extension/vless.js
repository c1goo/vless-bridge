// Лёгкий парсер vless:// ссылок — только для отображения и валидации в UI.
// Полную конфигурацию xray строит helper на своей стороне.

export function parseVless(link) {
  if (typeof link !== "string") return null;
  const trimmed = link.trim();
  if (!trimmed.toLowerCase().startsWith("vless://")) return null;

  let url;
  try {
    // URL не понимает схему vless напрямую в некоторых сборках — подменяем на http для разбора
    url = new URL("http://" + trimmed.slice("vless://".length));
  } catch {
    return null;
  }

  const uuid = decodeURIComponent(url.username || "");
  const host = url.hostname;
  const port = Number(url.port || 443);
  if (!uuid || !host || !port) return null;

  const q = url.searchParams;
  const name = decodeURIComponent((url.hash || "").replace(/^#/, "")) || `${host}:${port}`;

  return {
    raw: trimmed,
    uuid,
    host,
    port,
    name,
    network: q.get("type") || "tcp",
    security: q.get("security") || "none",
    sni: q.get("sni") || "",
    fingerprint: q.get("fp") || "",
    flow: q.get("flow") || "",
    // reality
    publicKey: q.get("pbk") || "",
    shortId: q.get("sid") || ""
  };
}

export function shortUuid(uuid) {
  return uuid.length > 13 ? uuid.slice(0, 8) + "…" + uuid.slice(-4) : uuid;
}
