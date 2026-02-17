/**
 * OMusic Helper
 * 协议保持一致：
 * - package_name: "moe.orpu.omusic"
 * - message(payload): "MUSIC_U=...." 纯字符串
 */

const WATCH_APP_PKG_NAME = "moe.orpu.omusic";
const CONFIG_KEY_COOKIE = "savedCookie_bandburg";

let currentCookieInput = "";
let gui = null;

// ---- 简易持久化 ----
const storage = {
  get(key) {
    try {
      if (typeof localStorage !== "undefined") {
        return localStorage.getItem(key);
      }
    } catch (_) {}
    return null;
  },
  set(key, val) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(key, String(val ?? ""));
      }
    } catch (_) {}
  }
};

// ---- MUSIC_U 提取 ----
function extractMusicUCookie(fullCookie) {
  if (!fullCookie || typeof fullCookie !== "string") return null;

  const trimmed = fullCookie.trim();

  // 1️⃣ 完整 cookie
  const match = trimmed.match(/(MUSIC_U=[^;]+)/);
  if (match && match[0]) return match[0];

  // 2️⃣ 纯 MUSIC_U 值
  if (/^[A-Z0-9]{100,}$/.test(trimmed)) {
    sandbox.log("检测到可能为纯 MUSIC_U 值，自动补全。");
    return `MUSIC_U=${trimmed}`;
  }

  return null;
}

// ---- 状态显示 ----
function setStatus(text) {
  try {
    gui?.setValue("status", text);
  } catch (_) {}
}

function getDefaultStatus() {
  return currentCookieInput
    ? "已加载上次保存的 Cookie / MUSIC_U，可直接同步。"
    : "请粘贴 Cookie（包含 MUSIC_U=...）或直接粘贴 MUSIC_U 的值。";
}

// ---- 检查设备 ----
function ensureDeviceConnected() {
  if (!sandbox.currentDevice?.addr) {
    throw new Error("未检测到已连接设备。请先在设备页面连接手表。");
  }
  return sandbox.currentDevice.addr;
}

// ---- 同步流程 ----
async function handleSync() {
  // 每次点击时主动读取当前输入值
  const inputValue = gui?.getValue("cookie_input");
  currentCookieInput = inputValue ?? "";

  setStatus("正在提取凭证...");

  if (!currentCookieInput) {
    setStatus("错误：输入为空。");
    return;
  }

  const musicUCookie = extractMusicUCookie(currentCookieInput);
  if (!musicUCookie) {
    setStatus("错误：凭证格式无效，请检查输入。");
    return;
  }

  try {
    const deviceAddr = ensureDeviceConnected();

    setStatus("正在检查应用是否存在...");
    const list = await sandbox.wasm.thirdpartyapp_get_list(deviceAddr);

    const apps = Array.isArray(list)
      ? list
      : (list?.apps || list?.list || list?.data || []);

    const installed = Array.isArray(apps) && apps.some((app) => {
      const pkg =
        app?.package_name ||
        app?.packageName ||
        app?.package ||
        app?.id;
      return pkg === WATCH_APP_PKG_NAME;
    });

    if (!installed) {
      setStatus(`错误：手表未安装目标应用（${WATCH_APP_PKG_NAME}）。`);
      return;
    }

    setStatus("正在发送到手表...");

    await sandbox.wasm.thirdpartyapp_send_message(
      deviceAddr,
      WATCH_APP_PKG_NAME,
      musicUCookie
    );

    setStatus("同步成功！请在手表端确认是否提示“接收到登录凭证”。");

    setTimeout(() => {
      setStatus(getDefaultStatus());
    }, 3000);

  } catch (e) {
    setStatus("错误：发送失败，请检查设备连接状态。");
    sandbox.log(`失败详情：${String(e)}`);
  }
}

// ---- 初始化 UI ----
function initUI() {
  gui = sandbox.gui({
    title: "OMusic Helper",
    elements: [
      { type: "label", text: "第一步：请先在设备页面连接手表" },
      { type: "label", text: "第二步：粘贴 Cookie 或 MUSIC_U 并同步" },
      {
        type: "textarea",
        id: "cookie_input",
        label: "Cookie / MUSIC_U",
        placeholder: "支持：完整Cookie中包含 MUSIC_U=...；或直接粘贴纯 MUSIC_U 值",
        value: currentCookieInput
      },
      { type: "button", id: "sync_btn", text: "同步到手表" },
      {
        type: "input",
        id: "status",
        label: "状态",
        value: getDefaultStatus()
      }
    ]
  });

  // 可选：输入变化时保存
  gui.on("textarea:change", "cookie_input", (value) => {
    currentCookieInput = value ?? "";
    storage.set(CONFIG_KEY_COOKIE, currentCookieInput);
  });

  gui.on("button:click", "sync_btn", () => {
    handleSync();
  });

  gui.show();
}

// ---- 启动 ----
(function init() {
  currentCookieInput = storage.get(CONFIG_KEY_COOKIE) || "";
  sandbox.log("OMusic Helper 已启动。");
  initUI();
})();
