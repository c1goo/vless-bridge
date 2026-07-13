import { parseVless } from "./vless.js";

// Подписка (subscription URL). Провайдеры отдают её в разных форматах:
//   A) full config — готовый JSON-конфиг xray (dns/inbounds/outbounds/routing).
//      Может быть одним объектом или массивом объектов (несколько серверов).
//   B) список ссылок — base64 (обычный или URL-safe) либо plain text построчно.
// Определяем формат по содержимому.

export function isSubscriptionUrl(s) {
  return /^https?:\/\//i.test((s || "").trim());
}

// --- A) full config xray ---

function isXrayConfig(o) {
  return o && typeof o === "object" && Array.isArray(o.outbounds);
}

// Выбираем «боевой» outbound, игнорируя служебные (freedom = прямой трафик,
// blackhole = блокировка, dns = перехват DNS).
const SERVICE = new Set(["freedom", "blackhole", "dns", "loopback"]);

function mainOutbound(config) {
  return config.outbounds.find((o) => o && !SERVICE.has(o.protocol)) || null;
}

// Достаём адрес/порт/uuid из outbound — структура зависит от протокола.
function outboundEndpoint(ob) {
  const s = ob.settings || {};
  const node =
    s.vnext?.[0] ||       // vless, vmess
    s.servers?.[0] ||     // trojan, shadowsocks
    null;
  if (!node) return null;
  return {
    host: node.address || "",
    port: Number(node.port) || 0,
    uuid: node.users?.[0]?.id || node.password || node.id || ""
  };
}

function serverFromConfig(config, idx) {
  const ob = mainOutbound(config);
  if (!ob) return null;
  const ep = outboundEndpoint(ob);
  if (!ep || !ep.host) return null;

  const stream = ob.streamSettings || {};
  // имя: remarks (v2rayN), tag аутбаунда, иначе адрес
  const name =
    config.remarks || config.name || ob.tag || `${ep.host}:${ep.port}` || `Сервер ${idx + 1}`;

  return {
    kind: "config",          // помечаем: запускается из готового конфига
    name: String(name),
    protocol: ob.protocol || "?",
    host: ep.host,
    port: ep.port,
    uuid: ep.uuid,
    network: stream.network || "tcp",
    security: stream.security || "none",
    config                    // полный конфиг xray — отдадим helper'у как есть
  };
}

// --- B) список ссылок ---

function tryBase64(text) {
  const compact = text.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/\-_=]+$/.test(compact)) return null;
  try {
    let b64 = compact.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = atob(b64);
    return /:\/\//.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

// Только строки, которые целиком являются ссылкой на прокси-конфиг.
// Важно: НЕ хватаем любые "://" внутри JSON (иначе DNS-адрес вроде
// https://8.8.8.8/dns-query принимается за конфиг).
const PROXY_SCHEME = /^(vless|vmess|trojan|ss|ssr|hy2|hysteria2?|tuic):\/\//i;

function extractLinks(text) {
  return text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => PROXY_SCHEME.test(l));
}

// --- основной вход ---

export async function fetchSubscription(url) {
  // Качаем подписку не из браузера, а через helper: провайдер может прятаться
  // за антибот-прокси (DDoS-Guard/Cloudflare), который блокирует fetch с
  // браузерным User-Agent и отдаёт HTML-страницу проверки. Helper ходит в сеть
  // обычным HTTP-клиентом (как curl), и антибот его пропускает.
  let res;
  try {
    res = await chrome.runtime.sendMessage({ cmd: "fetchSub", url });
  } catch (e) {
    throw new Error("не удалось связаться с helper'ом: " + (e?.message || e));
  }
  if (!res || !res.ok) {
    throw new Error(res?.error || "не удалось скачать подписку");
  }

  const body = (res.body || "").trim();
  if (!body) throw new Error("подписка пустая");

  // A) пробуем как JSON full config
  let json = null;
  try {
    json = JSON.parse(body);
  } catch { /* не JSON — идём дальше */ }

  if (json) {
    const configs = Array.isArray(json) ? json : [json];
    const valid = configs.filter(isXrayConfig);
    if (valid.length) {
      const servers = valid.map(serverFromConfig, undefined).filter(Boolean);
      if (!servers.length) {
        throw new Error("конфиг xray получен, но в нём нет рабочего outbound'а");
      }
      return { servers, skipped: 0, total: servers.length, format: "xray-config" };
    }
    throw new Error("получен JSON, но это не похоже на конфиг xray");
  }

  // B) список ссылок: base64 или plain text
  const links = extractLinks(tryBase64(body) ?? body);
  if (!links.length) {
    throw new Error("формат подписки не распознан (ни конфиг xray, ни список ссылок)");
  }

  const servers = [];
  const skippedSchemes = new Set();
  for (const link of links) {
    const parsed = parseVless(link);
    if (parsed) servers.push({ ...parsed, kind: "link", protocol: "vless" });
    else skippedSchemes.add((link.split("://")[0] || "?").toLowerCase());
  }

  if (!servers.length) {
    throw new Error(
      `в подписке ${links.length} конфиг(ов), протокол: ${[...skippedSchemes].join(", ")}. ` +
        `Из ссылок пока поддерживается только VLESS.`
    );
  }

  return {
    servers,
    skipped: links.length - servers.length,
    total: links.length,
    format: "links"
  };
}
