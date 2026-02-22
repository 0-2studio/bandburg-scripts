/**
 * 真智学 - 手表端Cookie同步工具
 * 将智学网登录凭证同步至手表应用
 */

// ========== 配置区 ==========
var _PKG = "moe.riseforever.realzx";
var _STORE_KEY = "zhixue_cookie_cache_v1";
var _DEBUG = true;

// 全局变量（能跑就行）
let _gui_ref = null;
let _cookie_buf = "";
let _last_status = "";

// ========== 工具函数 ==========

// 存储相关
var __save = function(k, v) {
    if (typeof localStorage == "undefined") return;
    try { localStorage.setItem(k, v || ""); } catch(e) {}
};

var __load = function(k) {
    if (typeof localStorage == "undefined") return null;
    try { return localStorage.getItem(k); } catch(e) { return null; }
};

// 日志输出
var _log = function(msg) {
    if (_DEBUG) sandbox.log("[真智学同步] " + msg);
};

// 更新状态栏
var refreshStatus = function(txt) {
    _last_status = txt;
    try {
        if (_gui_ref) _gui_ref.setValue("status_display", txt);
    } catch(ignore) {}
};

// ========== Cookie 解析模块 ==========

var parseCookieData = function(raw) {
    // 基础校验
    if (!raw) return {ok: false, err: "啥都没有欸..."};
    
    var s = String(raw).trim();
    if (s.indexOf("=") < 0) return {ok: false, err: "这格式不对吧？"};
    
    // 智学网特征检测
    var checkFields = {
        must: ["JSESSIONID", "loginUserName"],
        optional: ["SSO_R_SESSION_ID", "ui", "token"]
    };
    
    var found_must = false;
    var found_opt = false;
    
    // 检测逻辑
    for (var i = 0; i < checkFields.must.length; i++) {
        if (s.indexOf(checkFields.must[i] + "=") >= 0) {
            found_must = true;
            break;
        }
    }
    
    if (!found_must) {
        for (var j = 0; j < checkFields.optional.length; j++) {
            if (s.indexOf(checkFields.optional[j] + "=") >= 0) {
                found_opt = true;
                break;
            }
        }
    }
    
    if (!found_must && !found_opt) {
        return {ok: false, err: "这Cookie看起来不是智学网的啊？"};
    }
    
    // 解析键值对
    var items = s.split(";");
    var valid_count = 0;
    var user_info = {};
    
    for (var k = 0; k < items.length; k++) {
        var item = items[k].trim();
        if (item.indexOf("=") > 0) {
            valid_count++;
            
            // 提取关键信息
            var eq_pos = item.indexOf("=");
            var key_name = item.substring(0, eq_pos);
            var key_val = item.substring(eq_pos + 1);
            
            if (key_name == "loginUserName") user_info.name = key_val;
            if (key_name == "ui") user_info.uid = key_val;
            if (key_name == "help_role") user_info.role = key_val;
        }
    }
    
    if (valid_count < 3) {
        return {ok: false, err: "Cookie项太少(" + valid_count + "个)，是不是没复制全？"};
    }
    
    // 构建返回
    var desc = "识别到 " + valid_count + " 个Cookie项";
    if (user_info.name) desc += "，用户: " + user_info.name;
    if (user_info.uid) desc += "，ID: " + user_info.uid;
    
    _log(desc);
    
    return {
        ok: true,
        data: s,
        count: valid_count,
        info: user_info,
        desc: desc
    };
};

// ========== 设备通信模块 ==========

var getDeviceAddr = function() {
    var dev = sandbox.currentDevice;
    if (!dev || !dev.addr) {
        throw new Error("没连设备，先去设备页面连手表啊");
    }
    return dev.addr;
};

var checkAppExists = async function(addr, pkg_name) {
    var result = await sandbox.wasm.thirdpartyapp_get_list(addr);
    
    // 兼容各种返回格式
    var app_list = [];
    if (Array.isArray(result)) {
        app_list = result;
    } else if (result) {
        app_list = result.apps || result.list || result.data || [];
    }
    
    // 查找目标应用
    for (var i = 0; i < app_list.length; i++) {
        var app = app_list[i];
        var id = app.package_name || app.packageName || app.package || app.id;
        if (id == pkg_name) return true;
    }
    
    return false;
};

var pushToWatch = async function(addr, pkg, msg) {
    await sandbox.wasm.thirdpartyapp_send_message(addr, pkg, msg);
};

// ========== 主流程 ==========

var doSync = async function() {
    // 获取输入
    var input_val = "";
    try {
        input_val = _gui_ref.getValue("cookie_textarea") || "";
    } catch(e) {
        input_val = _cookie_buf;
    }
    
    _cookie_buf = input_val;
    
    // 校验
    refreshStatus("正在检查Cookie格式...");
    
    if (!input_val) {
        refreshStatus("错误：输入框是空的！");
        return;
    }
    
    var parse_result = parseCookieData(input_val);
    if (!parse_result.ok) {
        refreshStatus("错误：" + parse_result.err);
        return;
    }
    
    _log("校验通过: " + parse_result.desc);
    
    // 连接设备
    try {
        var addr = getDeviceAddr();
        
        refreshStatus("检查手表应用...");
        var exists = await checkAppExists(addr, _PKG);
        
        if (!exists) {
            refreshStatus("手表上没装真智学啊，先装一下");
            return;
        }
        
        refreshStatus("发送中...");
        await pushToWatch(addr, _PKG, parse_result.data);
        
        refreshStatus("OK！发送成功，看手表有没有收到");
        _log("同步完成，共 " + parse_result.count + " 个字段");
        
        // 3秒后恢复默认状态
        setTimeout(function() {
            refreshStatus(_cookie_buf ? 
                "有缓存Cookie，可直接同步" : 
                "粘贴Cookie然后点同步");
        }, 3000);
        
    } catch(ex) {
        refreshStatus("发送失败：" + String(ex));
        _log("出错: " + String(ex));
    }
};

// ========== UI 初始化 ==========

var buildUI = function() {
    var default_msg = _cookie_buf ? 
        "有缓存Cookie，可直接同步" : 
        "粘贴Cookie然后点同步";
    
    _gui_ref = sandbox.gui({
        title: "真智学 - Cookie同步",
        elements: [
            {type: "label", text: "① 设备页面连接手表"},
            {type: "label", text: "② 粘贴智学网Cookie"},
            {type: "label", text: "③ 点击同步按钮"},
            {
                type: "textarea",
                id: "cookie_textarea",
                label: "Cookie内容",
                placeholder: "JSESSIONID=xxx; loginUserName=xxx; 其他=xxx; ...",
                value: _cookie_buf
            },
            {
                type: "button",
                id: "sync_button",
                text: "同步到手表"
            },
            {
                type: "input",
                id: "status_display",
                label: "状态",
                value: default_msg
            }
        ]
    });
    
    // 绑定事件
    _gui_ref.on("textarea:change", "cookie_textarea", function(v) {
        _cookie_buf = v || "";
        __save(_STORE_KEY, _cookie_buf);
    });
    
    _gui_ref.on("button:click", "sync_button", function() {
        doSync();
    });
    
    _gui_ref.show();
};

// ========== 入口 ==========

(function init() {
    _log("启动");
    _log("目标包名: " + _PKG);
    
    // 恢复缓存
    _cookie_buf = __load(_STORE_KEY) || "";
    
    // 构建界面
    buildUI();
})();
