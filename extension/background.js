// Service worker: связь с локальным helper'ом (Native Messaging) и управление chrome.proxy.
// Прокси меняется ТОЛЬКО в Chrome (scope: "regular"), система не затрагивается.

const HOST_NAME = "com.vlessbridge.helper";

let nativePort = null; // держит service worker живым, пока соединение открыто (Chrome 116+)
let pending = new Map(); // id -> resolve
let msgId = 0;

function connectHelper() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST_NAME);

  nativePort.onMessage.addListener((msg) => {
    if (msg && msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  nativePort.onDisconnect.addListener(async () => {
    const err = chrome.runtime.lastError?.message || "helper disconnected";
    nativePort = null;
    for (const resolve of pending.values()) resolve({ ok: false, error: err });
    pending.clear();
    // Helper упал/закрылся — снимаем прокси, чтобы браузер не остался без сети
    await clearProxy();
    await setState({ connected: false, error: err });
  });

  return nativePort;
}

function callHelper(cmd, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let port;
    try {
      port = connectHelper();
    } catch (e) {
      resolve({ ok: false, error: String(e) });
      return;
    }
    const id = ++msgId;
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, error: "helper не отвечает (таймаут)" });
      }
    }, timeoutMs);
    try {
      port.postMessage({ id, cmd, ...payload });
    } catch (e) {
      pending.delete(id);
      resolve({ ok: false, error: "не удалось отправить команду helper'у: " + String(e) });
    }
  });
}

async function applyProxy(port) {
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "socks5", host: "127.0.0.1", port },
        bypassList: ["localhost", "127.0.0.1"]
      }
    },
    scope: "regular"
  });
}

async function clearProxy() {
  try {
    await chrome.proxy.settings.clear({ scope: "regular" });
  } catch (_) { /* ignore */ }
}

async function setState(patch) {
  const { state = {} } = await chrome.storage.local.get("state");
  const next = { ...state, ...patch };
  await chrome.storage.local.set({ state: next });
  updateBadge(next.connected);
  return next;
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2f9e6e" });
}

// --- Команды из popup ---

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  (async () => {
    switch (req.cmd) {
      case "connect": {
        // server.kind === "config" → отдаём helper'у готовый конфиг xray,
        // server.kind === "link"   → helper соберёт конфиг из vless:// ссылки
        const payload = req.config ? { config: req.config } : { link: req.link };
        const res = await callHelper("start", payload);
        if (res.ok && res.port) {
          await applyProxy(res.port);
          await setState({ connected: true, socksPort: res.port, error: null });
          sendResponse({ ok: true, port: res.port });
        } else {
          await clearProxy();
          await setState({ connected: false, error: res.error || "неизвестная ошибка" });
          sendResponse({ ok: false, error: res.error || "неизвестная ошибка" });
        }
        break;
      }
      case "disconnect": {
        await callHelper("stop");
        await clearProxy();
        await setState({ connected: false, socksPort: null, error: null });
        sendResponse({ ok: true });
        break;
      }
      case "helperStatus": {
        const res = await callHelper("status", {}, 4000);
        sendResponse(res);
        break;
      }
      case "fetchSub": {
        // Подписку качает helper (ходит в сеть как curl), а не браузер —
        // так антибот-прокси провайдера (DDoS-Guard) её не блокирует.
        const res = await callHelper("fetchSub", { url: req.url }, 20000);
        sendResponse(res);
        break;
      }
      case "latency": {
        // helper поднимает временный xray и мерит задержку через туннель.
        const payload = req.config ? { config: req.config } : { link: req.link };
        const res = await callHelper("latency", payload, 15000);
        sendResponse(res);
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown cmd" });
    }
  })();
  return true; // async response
});

// При старте браузера восстанавливаем чистое состояние (helper мог не подняться)
chrome.runtime.onStartup.addListener(async () => {
  await clearProxy();
  await setState({ connected: false, socksPort: null });
});
