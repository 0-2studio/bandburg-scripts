// BandBurg EBook Transfer Script
// 复刻 ebookastroboxpugin.js 功能，通过 interconnect 发送电子书 txt 文件到手环

sandbox.log("=== EBook 传输脚本加载 ===");
async function gotoapp(){
    await sandbox.wasm.thirdpartyapp_get_list(sandbox.currentDevice.addr);
    await sandbox.wasm.thirdpartyapp_launch(sandbox.currentDevice.addr,"com.bandbbs.ebook", "");
}


gotoapp();


// --- 工具函数 ---
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- EBookFile 类实现 ---

class EBookFile {
    // 常量
    FILE_SIZE = 1024 * 20; // 20KB，与原插件一致
    
    // 状态变量
    curFile = null;
    fileContent = "";
    totalChunk = 0;
    lastChunkTime = 0;
    chunkSize = 0;
    busy = false;
    currentChunk = 0;
    devicePackageName = "com.bandbbs.ebook"; // 默认电子书应用包名
    
    // 握手协议相关（仿照原版插件）
    handshakePromise = null;
    handshakeResolve = null;
    handshakeReject = null;
    handshakeTimeout = null;
    HANDSHAKE_TAG = "__hs__";
    HANDSHAKE_TIMEOUT = 3000; // 3秒超时
    
    // 回调函数
    onError = (message, count) => sandbox.log(`错误: ${message} (块 ${count})`);
    onSuccess = (message, count) => sandbox.log(`成功: ${message} (块 ${count})`);
    onProgress = (progress, status) => {
        const percent = Math.round(progress * 100);
        sandbox.log(`进度: ${percent}% - ${status}`);
    };
    
    // 事件监听器引用（用于清理）
    eventListener = null;
    
    constructor(packageName) {
        if (packageName) {
            this.devicePackageName = packageName;
        } else {
            this.devicePackageName = "com.bandbbs.ebook";
        }
        sandbox.log(`EBookFile 传输器初始化，目标应用: ${this.devicePackageName}`);
        this.setupEventListener();
    }
    
    /**
     * 设置事件监听器，监听设备响应
     */
    setupEventListener() {
        if (this.eventListener) {
            sandbox.wasm.register_event_sink(this.eventListener);
            return;
        }
        
        this.eventListener = (event) => {
            if (!this.busy || event.type !== 'thirdpartyapp_message') {
                return;
            }
            
            // 检查是否来自目标应用
            if (event.package_name !== this.devicePackageName) {
                return;
            }
            
            try {
                const fullMessage = event.data;
                if (!fullMessage || typeof fullMessage !== 'object') {
                    sandbox.log("收到无效消息格式");
                    return;
                }
                
                sandbox.log(`收到原始设备消息: ${JSON.stringify(fullMessage).substring(0, 100)}...`);
                
                // 按照原版插件格式：消息应包含 tag 字段
                const { tag, ...payload } = fullMessage;
                
                // 处理不同标签的消息
                if (tag === "file") {
                    // 文件传输消息
                    // 现在 payload 包含 type 字段（ready、error、success、next、cancel）
                    sandbox.log(`处理文件传输消息: ${JSON.stringify(payload).substring(0, 100)}...`);
                    
                    switch (payload.type) {
                        case "ready":
                            this.handleReadyMessage(payload);
                            break;
                            
                        case "error":
                            this.handleErrorMessage(payload);
                            break;
                            
                        case "success":
                            this.handleSuccessMessage(payload);
                            break;
                            
                        case "next":
                            this.handleNextMessage(payload);
                            break;
                            
                        case "cancel":
                            this.handleCancelMessage(payload);
                            break;
                            
                        default:
                            sandbox.log(`未知文件消息类型: ${payload.type}`);
                    }
                } else if (tag === this.HANDSHAKE_TAG) {
                    // 握手消息
                    sandbox.log(`收到握手消息: ${JSON.stringify(payload)}`);
                    this.handleHandshakeMessage(payload);
                } else {
                    // 其他未知标签的消息
                    sandbox.log(`收到未知标签消息，tag: ${tag}`);
                }
                return;
                
                // 现在 payload 包含 type 字段（ready、error、success、next、cancel）
                sandbox.log(`处理文件传输消息: ${JSON.stringify(payload).substring(0, 100)}...`);
                
                switch (payload.type) {
                    case "ready":
                        this.handleReadyMessage(payload);
                        break;
                        
                    case "error":
                        this.handleErrorMessage(payload);
                        break;
                        
                    case "success":
                        this.handleSuccessMessage(payload);
                        break;
                        
                    case "next":
                        this.handleNextMessage(payload);
                        break;
                        
                    case "cancel":
                        this.handleCancelMessage(payload);
                        break;
                        
                    default:
                        sandbox.log(`未知文件消息类型: ${payload.type}`);
                }
            } catch (e) {
                sandbox.log(`处理消息时出错: ${e.message}`);
                this.onError("解析消息失败", 0);
            }
        };
        
        // 注册事件监听器
        sandbox.wasm.register_event_sink(this.eventListener);
        sandbox.log("设备事件监听器已注册");
    }
    
    /**
     * 处理 ready 消息
     */
    handleReadyMessage(message) {
        sandbox.log(`设备准备就绪，存储使用: ${formatBytes(message.usage)}`);
        
        if (message.usage > 25 * 1024 * 1024) { // 25MB
            this.onError("存储空间不足", 0);
            this.busy = false;
            return;
        }
        
        if (message.found && message.length && message.length > 0) {
            // 设备上已有部分文件，从断点继续
            const resumeChunk = Math.floor(message.length / this.FILE_SIZE);
            this.currentChunk = resumeChunk > this.totalChunk ? 0 : resumeChunk;
            sandbox.log(`从块 ${this.currentChunk} 继续传输`);
            this.sendNextChunk(this.currentChunk, true);
        } else {
            // 全新传输
            this.currentChunk = 0;
            this.sendNextChunk(0);
        }
    }
    
    /**
     * 处理 error 消息
     */
    handleErrorMessage(message) {
        sandbox.log(`设备报告错误: ${message.message} (块 ${message.count})`);
        this.sendNextChunk(message.count);
    }
    
    /**
     * 处理 success 消息
     */
    handleSuccessMessage(message) {
        this.busy = false;
        this.onProgress(1.0, "传输完成");
        this.onSuccess(message.message, message.count);
        sandbox.log(`电子书传输成功: ${message.message}`);
    }
    
    /**
     * 处理 next 消息
     */
    handleNextMessage(message) {
        sandbox.log(`收到 next 消息: count=${message.count}, message="${message.message}"`);
        
        // 检查消息是否包含 "success" 字符串（设备可能使用 next 类型发送成功消息）
        if (message.message && message.message.includes("success")) {
            sandbox.log("检测到成功消息，传输完成");
            this.handleSuccessMessage(message);
            return;
        }
        
        // 检查是否所有块都已发送完成
        if (message.count >= this.totalChunk) {
            sandbox.log(`所有 ${this.totalChunk} 块已发送，传输完成`);
            this.handleSuccessMessage({
                message: `传输完成，共 ${this.totalChunk} 块`,
                count: this.totalChunk
            });
            return;
        }
        
        // 正常情况：请求下一个数据块
        sandbox.log(`设备请求下一块: ${message.count}`);
        this.sendNextChunk(message.count);
    }
    
    /**
     * 处理 cancel 消息
     */
    handleCancelMessage() {
        this.busy = false;
        this.onSuccess("传输已由设备取消", 0);
        sandbox.log("设备取消了传输");
    }
    
    /**
     * 发送文件到手环设备
     * @param {File} file - 用户选择的文件对象
     * @param {Function} onProgress - 进度回调 (0-1, 状态字符串)
     * @param {Function} onSuccess - 成功回调 (消息, 块计数)
     * @param {Function} onError - 错误回调 (消息, 块计数)
     */
    async sendFile(file, onProgress, onSuccess, onError) {
        if (this.busy) {
            onError("已有文件传输正在进行中", 0);
            return;
        }
        
        // 检查设备连接
        const device = sandbox.currentDevice;
        if (!device) {
            onError("未连接设备", 0);
            return;
        }
        
        this.busy = true;
        this.onProgress = onProgress || this.onProgress;
        this.onSuccess = onSuccess || this.onSuccess;
        this.onError = onError || this.onError;
        this.lastChunkTime = 0;
        this.currentChunk = 0;
        
        // 读取文件内容
        try {
            sandbox.log(`读取文件: ${file.name} (${formatBytes(file.size)})`);
            this.fileContent = await this.readFileAsText(file);
            this.curFile = file;
            
            // 计算分块
            this.totalChunk = Math.ceil(file.size / this.FILE_SIZE);
            this.chunkSize = Math.floor(this.fileContent.length / this.totalChunk);
            
            if (this.totalChunk === 0) {
                onSuccess("文件为空，无需发送", 0);
                this.busy = false;
                return;
            }
            
            sandbox.log(`文件将分为 ${this.totalChunk} 块传输，每块约 ${formatBytes(this.FILE_SIZE)}`);
            
            // 1. 执行握手协议，确保设备准备就绪
            try {
                await this.performHandshake();
                sandbox.log("握手成功，设备已准备就绪");
            } catch (e) {
                this.onError(`握手失败: ${e.message}`, 0);
                this.busy = false;
                return;
            }
            
            // 2. 启动目标应用（仿照原版插件逻辑）
            try {
                sandbox.log(`启动目标应用: ${this.devicePackageName}`);
                // 使用 thirdpartyapp_launch 启动应用
                await sandbox.wasm.thirdpartyapp_launch(device.addr, this.devicePackageName, "");
                sandbox.log("应用启动成功");
                
                // 等待1秒让应用完全启动（仿照原版插件）
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                sandbox.log(`应用启动失败，继续尝试传输: ${e.message}`);
                // 即使启动失败也继续尝试传输
            }
            
            // 3. 发送开始传输命令
            await this.sendStartTransfer(device.addr, file.name);
            
        } catch (e) {
            this.onError(`文件处理失败: ${e.message}`, 0);
            this.busy = false;
        }
    }
    
    /**
     * 读取文件为文本
     */
    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(new Error("读取文件失败"));
            reader.readAsText(file);
        });
    }
    
    /**
     * 发送开始传输命令
     */
    async sendStartTransfer(deviceAddr, filename) {
        const startMessage = {
            stat: "startTransfer",
            filename: filename,
            total: this.totalChunk,
            chunkSize: this.FILE_SIZE,
        };
        
        sandbox.log(`发送开始传输命令: ${JSON.stringify(startMessage)}`);
        
        try {
            await this.sendMessageToDevice(deviceAddr, startMessage, "file");
            this.onProgress(0.0, "准备发送...");
        } catch (e) {
            throw new Error(`发送开始命令失败: ${e.message}`);
        }
    }
    
    /**
     * 发送下一个数据块
     */
    async sendNextChunk(chunkIndex, isReSend = false) {
        if (chunkIndex >= this.totalChunk) {
            sandbox.log("所有块已发送，等待设备确认完成");
            return;
        }
        
        // 计算块在文本中的位置
        const startPos = chunkIndex * this.chunkSize;
        const endPos = Math.min(startPos + this.chunkSize, this.fileContent.length);
        const chunkData = this.fileContent.substring(startPos, endPos);
        
        const message = {
            stat: "d",
            count: chunkIndex,
            data: chunkData,
            setCount: isReSend ? chunkIndex : null,
        };
        
        // 计算传输速度
        const currentTime = Date.now();
        if (this.lastChunkTime !== 0) {
            const timeTakenMs = currentTime - this.lastChunkTime;
            const speed = this.FILE_SIZE / (timeTakenMs / 1000.0);
            const remainingTimeS = (this.totalChunk - chunkIndex) * (timeTakenMs / 1000.0);
            this.onProgress(
                chunkIndex / this.totalChunk,
                ` ${formatBytes(speed)}/s, 剩余 ${Math.round(remainingTimeS)}秒`
            );
        } else {
            this.onProgress(chunkIndex / this.totalChunk, "开始传输...");
        }
        this.lastChunkTime = currentTime;
        
        // 发送数据块
        try {
            const device = sandbox.currentDevice;
            if (!device) {
                throw new Error("设备已断开连接");
            }
            
            await this.sendMessageToDevice(device.addr, message, "file");
            sandbox.log(`已发送块 ${chunkIndex + 1}/${this.totalChunk}`);
            
        } catch (e) {
            this.onError(`发送块 #${chunkIndex} 失败: ${e.message}`, chunkIndex);
            this.busy = false;
        }
    }
    
    /**
     * 发送消息到设备
     * @param {string} deviceAddr - 设备地址
     * @param {object} data - 消息数据（不包含 tag）
     * @param {string} tag - 消息标签，默认为 "file"
     */
    async sendMessageToDevice(deviceAddr, data, tag = "file") {
        return new Promise((resolve, reject) => {
            try {
                // 按照原版插件格式发送消息：{tag, ...data}
                const message = { tag, ...data };
                sandbox.wasm.thirdpartyapp_send_message(
                    deviceAddr,
                    this.devicePackageName,
                    JSON.stringify(message)
                );
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    }
    
    /**
     * 取消当前传输
     */
    cancel() {
        if (!this.busy) return;
        
        sandbox.log("用户取消传输");
        
        const cancelMessage = { stat: "cancel" };
        const device = sandbox.currentDevice;
        
        if (device) {
            this.sendMessageToDevice(device.addr, cancelMessage, "file").catch(e => {
                sandbox.log(`发送取消消息失败: ${e.message}`);
            });
        }
        
        this.busy = false;
        this.onSuccess("传输已由用户取消", 0);
    }
    
    /**
     * 获取设备存储使用情况
     */
    async getUsage() {
        const device = sandbox.currentDevice;
        if (!device) {
            throw new Error("未连接设备");
        }
        
        const message = { stat: "getUsage" };
        await this.sendMessageToDevice(device.addr, message, "file");
        sandbox.log("已发送存储使用查询请求");
    }
    
    /**
     * 更新目标应用包名
     */
    setPackageName(packageName) {
        this.devicePackageName = packageName;
        sandbox.log(`目标应用包名已更新为: ${packageName}`);
    }
    
    /**
     * 处理握手消息
     */
    handleHandshakeMessage(payload) {
        sandbox.log(`处理握手消息: count=${payload.count}`);
        
        // 仿照原版插件逻辑
        if (payload.count > 0) {
            if (this.handshakePromise) {
                this.handshakeResolve?.();
                this.handshakeResolve = null;
                this.handshakeReject = null;
            } else {
                this.handshakePromise = Promise.resolve();
            }
        }
        
        // 如果 count 小于 2，继续发送握手响应
        if (payload.count < 2) {
            const nextCount = payload.count + 1;
            this.sendMessageToDevice(
                sandbox.currentDevice?.addr,
                { count: nextCount },
                this.HANDSHAKE_TAG
            ).catch(e => {
                sandbox.log(`发送握手响应失败: ${e.message}`);
            });
        }
    }
    
    /**
     * 执行握手协议
     */
    async performHandshake() {
        if (this.handshakePromise) {
            await this.handshakePromise;
            return;
        }
        
        sandbox.log("开始握手协议...");
        
        this.handshakePromise = new Promise((resolve, reject) => {
            this.handshakeResolve = resolve;
            this.handshakeReject = reject;
            
            this.handshakeTimeout = setTimeout(() => {
                reject(new Error("握手超时"));
                this.handshakePromise = null;
                this.handshakeResolve = null;
                this.handshakeReject = null;
            }, this.HANDSHAKE_TIMEOUT);
        });
        
        // 发送初始握手消息
        try {
            await this.sendMessageToDevice(
                sandbox.currentDevice?.addr,
                { count: 0 },
                this.HANDSHAKE_TAG
            );
            await this.handshakePromise;
            sandbox.log("握手成功");
        } catch (e) {
            sandbox.log(`握手失败: ${e.message}`);
            throw e;
        } finally {
            clearTimeout(this.handshakeTimeout);
            this.handshakeTimeout = null;
        }
    }
    
    /**
     * 清理资源
     */
    cleanup() {
        this.busy = false;
        this.curFile = null;
        this.fileContent = "";
        sandbox.log("EBookFile 传输器已清理");
    }
}

// --- 创建传输器实例 ---
const ebookTransfer = new EBookFile();

// --- 创建 GUI 界面 ---
function createEBookGUI() {
    sandbox.log("创建电子书传输界面");
    
    const guiConfig = {
        title: "电子书传输工具",
        width: 500,
        height: 500,
        elements: [
            {
                type: "label",
                text: "电子书文件传输",
                style: "font-size: 18px; font-weight: bold; margin-bottom: 10px;"
            },
            {
                type: "label",
                text: "将 TXT 电子书文件传输到手环设备",
                style: "color: #666; margin-bottom: 15px;"
            },
            {
                type: "input",
                id: "packageName",
                label: "目标应用包名",
                placeholder: "com.bandbbs.ebook",
                value: "com.bandbbs.ebook",
                required: true
            },
            {
                type: "file",
                id: "ebookFile",
                label: "选择电子书文件",
                accept: ".txt,.text",
                multiple: false
            },
            {
                type: "label",
                id: "fileInfo",
                text: "未选择文件",
                style: "margin-top: 5px; color: #888; font-size: 12px;"
            },
            {
                type: "label",
                id: "progressLabel",
                text: "准备就绪",
                style: "margin-top: 15px; font-weight: bold;"
            },
            {
                type: "label",
                id: "progressText",
                text: "",
                style: "color: #666; font-size: 12px; margin-bottom: 15px;"
            },
            {
                type: "button",
                id: "startTransfer",
                text: "开始传输"
            },
            {
                type: "button",
                id: "cancelTransfer",
                text: "取消传输"
            },
            {
                type: "button",
                id: "checkStorage",
                text: "检查存储"
            },
            {
                type: "button",
                id: "testConnection",
                text: "测试连接"
            }
        ]
    };
    
    // 创建 GUI 并保存实例
    const gui = sandbox.gui(guiConfig);
    
    // 更新进度显示的辅助函数
    function updateProgress(title, text) {
        sandbox.log(`进度更新: ${title} - ${text}`);
    }
    
    // 绑定按钮点击事件
    gui.on('button:click', 'startTransfer', async () => {
        const values = gui.getValues();
        const file = values.ebookFile;
        
        if (!file) {
            sandbox.log("错误：请先选择文件");
            return;
        }
        
        const device = sandbox.currentDevice;
        if (!device) {
            sandbox.log("错误：未连接设备");
            return;
        }
        
        // 更新包名
        const packageName = values.packageName || "com.bandbbs.ebook";
        ebookTransfer.setPackageName(packageName);
        
        sandbox.log(`开始传输文件: ${file.name} 到应用: ${packageName}`);
        
        // 更新 GUI 状态
        updateProgress("准备文件...", "");
        
        // 定义回调函数
        const onProgress = (progress, status) => {
            const percent = Math.round(progress * 100);
            updateProgress(`传输中: ${percent}%`, status);
        };
        
        const onSuccess = (message, count) => {
            updateProgress("传输完成", message);
            sandbox.log(`传输成功: ${message}`);
        };
        
        const onError = (message, count) => {
            updateProgress("传输失败", message);
            sandbox.log(`传输错误: ${message}`);
        };
        
        // 开始传输
        try {
            await ebookTransfer.sendFile(file, onProgress, onSuccess, onError);
        } catch (error) {
            sandbox.log(`传输异常: ${error.message}`);
            updateProgress("传输异常", error.message);
        }
    });
    
    gui.on('button:click', 'cancelTransfer', () => {
        ebookTransfer.cancel();
        updateProgress("已取消", "用户取消了传输");
    });
    
    gui.on('button:click', 'checkStorage', async () => {
        try {
            await ebookTransfer.getUsage();
            updateProgress("检查中", "已发送存储查询请求");
        } catch (e) {
            sandbox.log(`检查存储失败: ${e.message}`);
            updateProgress("检查失败", e.message);
        }
    });
    
    gui.on('button:click', 'testConnection', () => {
        const device = sandbox.currentDevice;
        if (device) {
            sandbox.log(`设备连接正常: ${device.name} (${device.addr})`);
            updateProgress("连接正常", `设备: ${device.name}`);
        } else {
            sandbox.log("未连接设备");
            updateProgress("未连接", "请先连接设备");
        }
    });
    
    // 绑定文件选择事件（如果支持）
    // 注意：实际实现可能不支持 'file:change' 事件，这里尝试绑定
    gui.on('file:change', 'ebookFile', () => {
        const values = gui.getValues();
        const file = values.ebookFile;
        if (file) {
            sandbox.log(`已选择文件: ${file.name} (${formatBytes(file.size)})`);
            // 更新文件信息标签
            updateProgress("文件已选择", `${file.name} (${formatBytes(file.size)})`);
        }
    });
    
    sandbox.log("电子书传输界面已创建");
}

// --- 脚本入口点 ---
sandbox.log("=== 电子书传输脚本就绪 ===");
sandbox.log("功能：将 TXT 电子书文件传输到小米手环设备");
sandbox.log("重要说明：");
sandbox.log("1. 确保设备已连接");
sandbox.log("2. 输入目标应用的包名（默认为 com.bandbbs.ebook）");
sandbox.log("3. 选择 TXT 文件开始传输");
sandbox.log("4. 设备端需要运行对应的电子书接收应用");

// 自动创建 GUI 界面
createEBookGUI();

// 导出对象供其他脚本使用
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { EBookFile, ebookTransfer };
}

sandbox.log("电子书传输脚本初始化完成，等待用户操作");