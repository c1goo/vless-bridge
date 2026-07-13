import { parseVless, shortUuid } from "./vless.js";
import { fetchSubscription, isSubscriptionUrl } from "./subscription.js";

const $ = (id) => document.getElementById(id);
const linkInput = $("linkInput");
const addBtn = $("addBtn");
const addHint = $("addHint");
const serverList = $("serverList");
const toggleBtn = $("toggleBtn");
const statusDot = $("statusDot");
const statusLabel = $("statusLabel");
const ipBtn = $("ipBtn");
const ipResult = $("ipResult");
const errorLine = $("errorLine");
const subBar = $("subBar");
const subUrl = $("subUrl");
const refreshBtn = $("refreshBtn");
const listHead = $("listHead");
const pingAllBtn = $("pingAllBtn");
const appView = $("appView");
const onboard = $("onboard");
const obDownload = $("obDownload");
const obRecheck = $("obRecheck");
const obHint = $("obHint");
const obStepInstall = $("obStepInstall");
const obStepRestart = $("obStepRestart");

let servers = [];
let selectedIdx = -1;
let subscription = null; // { url, updatedAt }
let connected = false;
let busy = false;
let latencies = new Map(); // serverKey -> { state: "measuring"|"done"|"error", ms?, err? }
let pingingAll = false;    // идёт замер всех серверов по очереди

init();

async function init() {
  setupOnboarding();
  await checkHelperAndRoute();
}

// Определяем, установлен ли helper: "status" отвечает — значит есть.
// Если helper не установлен, connectNative тут же рвётся и status возвращает ok:false.
async function checkHelperAndRoute() {
  let status = null;
  try {
    status = await chrome.runtime.sendMessage({ cmd: "helperStatus" });
  } catch { /* фон недоступен — считаем, что helper'а нет */ }

  if (status?.ok) {
    await enterApp();
  } else {
    enterOnboarding();
  }
}

async function enterApp() {
  onboard.hidden = true;
  appView.hidden = false;
  statusLabel.style.visibility = "";

  const data = await chrome.storage.local.get(["servers", "selectedIdx", "state", "subscription"]);
  servers = data.servers || [];
  selectedIdx = data.selectedIdx ?? (servers.length ? 0 : -1);
  subscription = data.subscription || null;
  connected = !!data.state?.connected;
  if (data.state?.error) errorLine.textContent = data.state.error;
  render();
}

function enterOnboarding() {
  appView.hidden = true;
  onboard.hidden = false;
  statusLabel.style.visibility = "hidden"; // «выключено» на экране установки ни к чему
}

// Настраивает тексты/ссылку под ОС и вешает «Проверить снова». Вызывается один раз.
function setupOnboarding() {
  const plat = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  const isWindows = /win/.test(plat);

  obDownload.href = "https://github.com/c1goo/vless-bridge/releases/latest";
  obDownload.textContent = isWindows ? "Скачать для Windows" : "Скачать для macOS";
  obStepInstall.textContent = isWindows
    ? "Запустите install-windows.ps1 из папки."
    : "Запустите install-macos.sh из папки.";
  obStepRestart.innerHTML = isWindows
    ? "<b>Перезапустите Chrome полностью</b> — закройте все окна и откройте заново, иначе helper не подхватится."
    : "<b>Перезапустите Chrome полностью</b> — <b>Cmd+Q</b> и откройте заново, иначе helper не подхватится.";

  obRecheck.addEventListener("click", async () => {
    obHint.textContent = "Проверяю…";
    obRecheck.disabled = true;
    let status = null;
    try {
      status = await chrome.runtime.sendMessage({ cmd: "helperStatus" });
    } catch { /* нет фона */ }
    obRecheck.disabled = false;
    if (status?.ok) {
      obHint.textContent = "";
      await enterApp();
    } else {
      obHint.textContent = "Helper пока не найден. Установили приложение и перезапустили Chrome?";
    }
  });
}

function render() {
  statusDot.classList.toggle("on", connected);
  statusLabel.textContent = connected ? "подключено" : "выключено";
  toggleBtn.textContent = busy ? "…" : connected ? "Отключить" : "Подключить";
  toggleBtn.classList.toggle("on", connected);
  toggleBtn.disabled = busy || (!connected && selectedIdx < 0);

  // строка подписки
  if (subscription) {
    subBar.hidden = false;
    subUrl.textContent = shortUrl(subscription.url);
    subUrl.title = subscription.url;
    refreshBtn.disabled = busy;
  } else {
    subBar.hidden = true;
  }

  // шапка списка с кнопкой «пинг всех»
  listHead.hidden = !servers.length;
  pingAllBtn.disabled = busy;
  pingAllBtn.textContent = pingingAll ? "Стоп" : "Пинг всех";

  serverList.innerHTML = "";
  if (!servers.length) {
    serverList.innerHTML =
      `<div class="empty">Серверов пока нет — вставьте ссылку-подписку или vless:// выше</div>`;
    return;
  }
  servers.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = "server" + (i === selectedIdx ? " selected" : "");
    el.innerHTML = `
      <div class="info">
        <div class="name"></div>
        <div class="meta"></div>
      </div>
      <button class="ping" title="Измерить задержку через туннель"></button>
      <button class="del" title="Удалить">&#10005;</button>`;
    el.querySelector(".name").textContent = s.name;
    const proto = s.protocol || "vless";
    el.querySelector(".meta").textContent =
      `${s.host}:${s.port} · ${proto}/${s.network}/${s.security}` +
      (s.uuid ? ` · ${shortUuid(s.uuid)}` : "");

    // кнопка пинга: состояние из latencies
    const ping = el.querySelector(".ping");
    const lat = latencies.get(serverKey(s));
    if (lat?.state === "measuring") {
      ping.textContent = "…";
    } else if (lat?.state === "done") {
      ping.textContent = String(lat.ms);
      ping.classList.add(lat.ms < 300 ? "good" : lat.ms < 1000 ? "slow" : "bad");
      ping.title = `${lat.ms} мс через туннель`;
    } else if (lat?.state === "error") {
      ping.textContent = "×";
      ping.classList.add("bad");
      ping.title = lat.err || "не удалось измерить";
    } else {
      ping.textContent = "мс?";
    }
    ping.disabled = pingingAll || lat?.state === "measuring";
    ping.addEventListener("click", (e) => {
      e.stopPropagation();
      measureOne(i);
    });

    el.addEventListener("click", () => selectServer(i));
    el.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      removeServer(i);
    });
    serverList.appendChild(el);
  });
}

function serverKey(s) {
  return `${s.protocol || "vless"}|${s.host}|${s.port}|${s.uuid || s.name}`;
}

// Замер одного сервера. Не блокирует UI: помечаем «…», ждём helper, рисуем результат.
async function measureOne(i) {
  const s = servers[i];
  if (!s) return;
  const key = serverKey(s);
  if (latencies.get(key)?.state === "measuring") return;
  latencies.set(key, { state: "measuring" });
  render();
  try {
    const res = await chrome.runtime.sendMessage(
      s.kind === "config"
        ? { cmd: "latency", config: s.config }
        : { cmd: "latency", link: s.raw }
    );
    if (res?.ok && typeof res.ms === "number") {
      latencies.set(key, { state: "done", ms: res.ms });
    } else {
      latencies.set(key, { state: "error", err: res?.error || "нет ответа" });
    }
  } catch (e) {
    latencies.set(key, { state: "error", err: e?.message || String(e) });
  }
  render();
}

// Замер всех серверов ПО ОДНОМУ (не 51 xray разом). Повторный клик — стоп.
async function measureAll() {
  if (pingingAll) return;
  pingingAll = true;
  render();
  try {
    for (let i = 0; i < servers.length; i++) {
      if (!pingingAll) break; // пользователь нажал «Стоп»
      await measureOne(i);
    }
  } finally {
    pingingAll = false;
    render();
  }
}

pingAllBtn.addEventListener("click", () => {
  if (pingingAll) pingingAll = false; // сигнал остановки — текущий замер добежит
  else measureAll();
});

function shortUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname + (url.pathname.length > 20
      ? url.pathname.slice(0, 12) + "…"
      : url.pathname);
  } catch {
    return u;
  }
}

async function persist() {
  await chrome.storage.local.set({ servers, selectedIdx, subscription });
}

addBtn.addEventListener("click", addFromInput);
linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addFromInput(); });
refreshBtn.addEventListener("click", () => loadSubscription(subscription.url, true));

async function addFromInput() {
  errorLine.textContent = "";
  const value = linkInput.value.trim();
  if (!value) return;

  if (isSubscriptionUrl(value)) {
    await loadSubscription(value, false);
    return;
  }

  const parsed = parseVless(value);
  if (!parsed) {
    addHint.textContent = "Нужна ссылка-подписка (https://…) или vless://";
    return;
  }
  servers.push({ ...parsed, kind: "link", protocol: "vless" });
  selectedIdx = servers.length - 1;
  linkInput.value = "";
  addHint.textContent = `Добавлен: ${parsed.name}`;
  await persist();
  render();
}

async function loadSubscription(url, isRefresh) {
  busy = true;
  addHint.textContent = isRefresh ? "Обновляю подписку…" : "Загружаю подписку…";
  render();

  try {
    const { servers: fetched, skipped, total } = await fetchSubscription(url);

    // серверы, добавленные вручную, сохраняем; из подписки — заменяем целиком
    const manual = servers.filter((s) => !s.fromSub);
    const fromSub = fetched.map((s) => ({ ...s, fromSub: true }));
    servers = [...fromSub, ...manual];

    // стараемся сохранить выбор пользователя между обновлениями
    const key = (s) => `${s.protocol}|${s.host}|${s.port}|${s.name}`;
    const prev = selectedIdx >= 0 ? servers[selectedIdx] : null;
    const keep = prev ? servers.findIndex((s) => key(s) === key(prev)) : -1;
    selectedIdx = keep >= 0 ? keep : (servers.length ? 0 : -1);

    subscription = { url, updatedAt: Date.now() };
    linkInput.value = "";

    let msg = `Загружено серверов: ${fromSub.length}`;
    if (skipped) msg += ` (пропущено ${skipped} из ${total} — не VLESS)`;
    addHint.textContent = msg;

    await persist();
  } catch (e) {
    addHint.textContent = "";
    errorLine.textContent = e.message || String(e);
  } finally {
    busy = false;
    render();
  }
}

async function selectServer(i) {
  if (connected || busy) return;
  selectedIdx = i;
  await persist();
  render();
}

async function removeServer(i) {
  if (connected && i === selectedIdx) return;
  servers.splice(i, 1);
  if (selectedIdx >= servers.length) selectedIdx = servers.length - 1;
  await persist();
  render();
}

toggleBtn.addEventListener("click", async () => {
  errorLine.textContent = "";
  busy = true;
  render();
  try {
    if (!connected) {
      const srv = servers[selectedIdx];
      const res = await chrome.runtime.sendMessage(
        srv?.kind === "config"
          ? { cmd: "connect", config: srv.config }
          : { cmd: "connect", link: srv?.raw }
      );
      if (res?.ok) connected = true;
      else errorLine.textContent = res?.error || "не удалось подключиться";
    } else {
      await chrome.runtime.sendMessage({ cmd: "disconnect" });
      connected = false;
    }
  } finally {
    busy = false;
    render();
  }
});

ipBtn.addEventListener("click", async () => {
  ipResult.textContent = "проверяю…";
  try {
    const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    const j = await r.json();
    ipResult.textContent = `Текущий IP браузера: ${j.ip}`;
  } catch {
    ipResult.textContent = "не удалось проверить IP";
  }
});
