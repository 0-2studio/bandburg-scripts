/**
 * OMusic Helper
 * 协议保持一致：
 * - package_name: "moe.orpu.omusic"
 * - message(payload): "MUSIC_U=...." 纯字符串
 */

const WATCH_APP_PKG_NAME = "moe.orpu.omusic";
const CONFIG_KEY_COOKIE = "savedCookie_bandburg";
const CONFIG_KEY_DEVICE = "selectedDeviceAddr_bandburg";

let currentCookieInput = "";
let currentDeviceAddr = "";

// ---- 简易持久化（优先 localStorage）----
const storage = {
  get(key) {
    try {
      if (typeof localStorage !== "undefined") return localStorage.getItem(key);
    } catch (_) {}
    return null;
  },
  set(key, val) {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, String(val ?? ""));
    } catch (_) {}
  }
};

// ---- 与原 JS 相同的 MUSIC_U 智能提取 ----
function extractMusicUCookie(fullCookie) {
  if (!fullCookie || typeof fullCookie !== "string") return null;

  const trimmedCookie = fullCookie.trim();

  // 场景1：完整 cookie 字符串，提取 MUSIC_U=xxx（到分号前）
  const match = trimmedCookie.match(/(MUSIC_U=[^;]+)/);
  if (match && match[0]) return match[0];

  // 场景2：用户只粘贴 MUSIC_U 的值
  if (/^[A-Z0-9]{100,}$/.test(trimmedCookie)) {
    sandbox.log("检测到可能为纯 MUSIC_U 值，自动补全。");
    return `MUSIC_U=${trimmedCookie}`;
  }

  return null;
}

// ---- UI ----
let gui = null;

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

function getDeviceOptions() {
  const devices = Array.isArray(sandbox.devices) ? sandbox.devices : [];
  if (!devices.length) {
    return [{ value: "", label: "（未发现已保存设备，请先在设备页配对/保存）", selected: true }];
  }

  // 如果当前没选设备，默认选第一个
  const ensuredSelected = currentDeviceAddr || devices[0]?.addr || "";

  return devices.map((d) => {
    const addr = d?.addr ?? "";
    const name = d?.name ?? addr ?? "Unknown";
    return {
      value: addr,
      label: `${name}${addr ? " (" + addr + ")" : ""}`,
      selected: addr === ensuredSelected
    };
  });
}

async function ensureDeviceConnected() {
  const addr = currentDeviceAddr || gui?.getValue("device_select") || sandbox.currentDevice?.addr;
  if (!addr) throw new Error("未选择设备。");

  if (sandbox.currentDevice?.addr === addr) return addr;

  setStatus("正在连接设备...");
  await sandbox.wasm.miwear_connect(addr);
  return addr;
}

async function isAppInstalled(deviceAddr) {
  const list = await sandbox.wasm.thirdpartyapp_get_list(deviceAddr);
  // list 结构可能是数组或对象数组；做宽松匹配
  const arr = Array.isArray(list) ? list : (list?.apps || list?.list || []);
  return Array.isArray(arr) && arr.some((app) => {
    const pkg = app?.package_name || app?.packageName || app?.package || app?.id;
    return pkg === WATCH_APP_PKG_NAME;
  });
}

// ---- 通信回执等待：收到来自目标包名的 thirdpartyapp_message 即视为“通信OK” ----
let pendingAck = null; // { resolve, timeoutId }

function waitForAck(ms) {
  return new Promise((resolve) => {
    // 若已有等待中的，先清理
    if (pendingAck?.timeoutId) clearTimeout(pendingAck.timeoutId);

    const timeoutId = setTimeout(() => {
      pendingAck = null;
      resolve(false);
    }, ms);

    pendingAck = { resolve, timeoutId };
  });
}

sandbox.wasm.register_event_sink((event) => {
  if (event.type === "device_connected") sandbox.log("✅ 设备已连接");
  if (event.type === "device_disconnected") sandbox.log("⚠️ 设备已断开");

  if (event.type === "thirdpartyapp_message" && event.package_name === WATCH_APP_PKG_NAME) {
    sandbox.log(`📨 收到 ${WATCH_APP_PKG_NAME} 消息: ${JSON.stringify(event.data)}`);

    if (pendingAck?.resolve) {
      clearTimeout(pendingAck.timeoutId);
      const resolve = pendingAck.resolve;
      pendingAck = null;
      resolve(true);
    }
  }
});

// ---- 同步流程（发送 payload 与原 JS 完全一致）----
async function handleSync() {
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
    const deviceAddr = await ensureDeviceConnected();

    setStatus("正在检查应用是否存在...");
    const installed = await isAppInstalled(deviceAddr);
    if (!installed) {
      setStatus(`错误：手表未安装目标应用（${WATCH_APP_PKG_NAME}）。`);
      return;
    }

    setStatus("正在发送到手表...");
    // ✅ 包名 + 纯字符串 payload（保持协议一致）
    const ackPromise = waitForAck(5000);
    await sandbox.wasm.thirdpartyapp_send_message(deviceAddr, WATCH_APP_PKG_NAME, musicUCookie);

    // ✅ 通信状态判断：等待回执（若应用不回消息，也会提示）
    setStatus("已发送，等待应用响应...");
    const gotAck = await ackPromise;

    if (gotAck) {
      setStatus("同步成功（已收到应用响应）！");
      setTimeout(() => setStatus(getDefaultStatus()), 3000);
    } else {
      setStatus("已发送，但未收到应用响应（可能应用未打开或不发送回执）。");
    }
  } catch (e) {
    setStatus("错误：发送失败，请检查手表连接和应用是否可用。");
    sandbox.log(`失败详情：${String(e)}`);
  }
}

function initUI() {
  gui = sandbox.gui({
    title: "OMusic Helper",
    elements: [
      { type: "label", text: "第一步：选择设备并连接" },
      {
        type: "select",
        id: "device_select",
        label: "设备",
        options: getDeviceOptions()
      },
      { type: "button", id: "connect_btn", text: "连接设备" },

      { type: "label", text: "第二步：粘贴 Cookie 或 MUSIC_U 并同步" },
      {
        type: "textarea",
        id: "cookie_input",
        label: "Cookie / MUSIC_U",
        placeholder: "支持：完整Cookie中包含 MUSIC_U=...；或直接粘贴纯 MUSIC_U 值",
        value: currentCookieInput
      },
      { type: "button", id: "sync_btn", text: "同步到手表" },

      // 单一状态显示：只保留这一处
      {
        type: "input",
        id: "status",
        label: "状态",
        value: getDefaultStatus()
      }
    ]
  });

  // 设备选择变化
  gui.on("select:change", "device_select", (value) => {
    currentDeviceAddr = value || "";
    storage.set(CONFIG_KEY_DEVICE, currentDeviceAddr);
    setStatus(currentDeviceAddr ? `已选择设备：${currentDeviceAddr}` : "未选择设备。");
  });

  // 连接按钮
  gui.on("button:click", "connect_btn", async () => {
    try {
      const addr = currentDeviceAddr || gui.getValue("device_select");
      if (!addr) {
        setStatus("错误：未选择设备。");
        return;
      }
      setStatus("正在连接设备...");
      await sandbox.wasm.miwear_connect(addr);
      setStatus("设备连接成功。");
    } catch (e) {
      setStatus(`错误：连接失败：${String(e)}`);
    }
  });

  // 输入变化：实时保存
  gui.on("textarea:change", "cookie_input", (value) => {
    currentCookieInput = value ?? "";
    storage.set(CONFIG_KEY_COOKIE, currentCookieInput);
    setStatus(getDefaultStatus());
  });

  // 同步按钮
  gui.on("button:click", "sync_btn", () => {
    handleSync();
  });

  gui.show();
}

// ---- 启动 ----
(function init() {
  currentCookieInput = storage.get(CONFIG_KEY_COOKIE) || "";
  currentDeviceAddr = storage.get(CONFIG_KEY_DEVICE) || "";

  sandbox.log("脚本已启动。");
  initUI();
})();
