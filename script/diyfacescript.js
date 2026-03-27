// DIY Face 图片传输脚本
// 用于通过 interconnect 协议传输 PNG 图片到 DIY Face 快应用

async function gotoapp(){
    await sandbox.wasm.thirdpartyapp_get_list(sandbox.currentDevice.addr);
    await sandbox.wasm.thirdpartyapp_launch(sandbox.currentDevice.addr,"com.02studio.diyface.demo", "");
}


gotoapp();

(function() {
  'use strict';

  const PACKAGE_NAME = 'com.02studio.diyface.demo';
  const CHUNK_SIZE = 2048;
  const MAX_FILE_SIZE = 1048576; // 1MB

  let currentFile = null;
  let currentFileData = null;
  let isTransferring = false;
  let transferProgress = 0;
  let targetWidth = 212;  // 默认宽度
  let targetHeight = 520; // 默认高度

  sandbox.log('=== DIY Face 图片传输脚本已加载 ===');
  sandbox.log(`目标应用: ${PACKAGE_NAME}`);
  sandbox.log('');
  sandbox.log('请选择 PNG 格式图片进行传输');
  sandbox.log('默认尺寸: 宽212 x 高520 像素');
  sandbox.log('');

  // 初始化 GUI 界面
  const guiConfig = {
    title: 'DIY Face 图片传输',
    width: 500,
    height: 580,
    elements: [
      {
        type: 'label',
        text: 'DIY Face 背景图片传输',
        style: 'font-size: 20px; font-weight: bold; margin-bottom: 10px;'
      },
      {
        type: 'label',
        text: '选择 PNG 图片文件并设置目标尺寸',
        style: 'margin-bottom: 15px;'
      },
      {
        type: 'file',
        id: 'imageFile',
        label: '选择 PNG 图片',
        accept: '.png',
        multiple: false
      },
      {
        type: 'label',
        id: 'fileInfo',
        text: '未选择文件',
        style: 'margin-top: 10px; font-size: 14px; color: #666;'
      },
      {
        type: 'label',
        text: '目标尺寸 (像素):',
        style: 'margin-top: 15px; font-weight: bold;'
      },
      {
        type: 'input',
        id: 'widthInput',
        label: '宽度 (默认 212)',
        placeholder: '212',
        value: '212',
        required: true
      },
      {
        type: 'input',
        id: 'heightInput',
        label: '高度 (默认 520)',
        placeholder: '520',
        value: '520',
        required: true
      },
      {
        type: 'label',
        text: '传输进度:',
        style: 'margin-top: 15px; font-weight: bold;'
      },
      {
        type: 'label',
        id: 'progressText',
        text: '0%',
        style: 'font-size: 24px; font-weight: bold; color: #000;'
      },
      {
        type: 'button',
        id: 'processBtn',
        text: '处理并发送'
      },
      {
        type: 'button',
        id: 'clearBtn',
        text: '清除选择'
      },
      {
        type: 'label',
        id: 'statusText',
        text: '等待操作...',
        style: 'margin-top: 15px; font-size: 14px; color: #666;'
      }
    ]
  };

  const gui = sandbox.gui(guiConfig);

  // 文件选择处理（GUI 返回的是 {name, type, size, data} 对象，data 是 Base64）
  function handleFileSelect(fileData) {
    if (!fileData || !fileData.data) {
      currentFile = null;
      currentFileData = null;
      updateStatus('未选择文件', 'fileInfo');
      updateStatus('等待操作...', 'statusText');
      return;
    }

    currentFile = fileData;
    sandbox.log(`选择文件: ${fileData.name}`);
    sandbox.log(`文件大小: ${fileData.size} bytes`);
    sandbox.log(`文件类型: ${fileData.type}`);

    updateStatus(`已选择: ${fileData.name} (${formatFileSize(fileData.size)})`, 'fileInfo');

    // 检查文件大小
    if (fileData.size > MAX_FILE_SIZE * 5) {
      updateStatus('错误: 文件大小超过 5MB 限制', 'statusText');
      sandbox.log('错误: 文件大小超过 5MB 限制');
      currentFile = null;
      return;
    }

    updateStatus('文件已选择，点击"处理并发送"开始处理', 'statusText');
    sandbox.log('文件已选择，准备处理');
  }

  // 读取输入的尺寸
  function readTargetDimensions() {
    try {
      const values = gui.getValues && gui.getValues();
      if (values) {
        const width = parseInt(values.widthInput) || 212;
        const height = parseInt(values.heightInput) || 520;
        // 限制尺寸范围
        targetWidth = Math.max(50, Math.min(1000, width));
        targetHeight = Math.max(50, Math.min(1000, height));
      }
    } catch (e) {
      sandbox.log('读取尺寸失败，使用默认值');
      targetWidth = 212;
      targetHeight = 520;
    }
    sandbox.log(`目标尺寸: 宽${targetWidth} x 高${targetHeight} 像素`);
  }

  // 加载图片（从 data URL）
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('加载图片失败'));
      img.src = dataUrl;
    });
  }

  // 调整图片尺寸并压缩为PNG
  async function resizeImageToPNG(img, targetW, targetH) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    canvas.width = targetW;
    canvas.height = targetH;

    // 使用高质量的图像平滑
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 计算裁剪区域（居中裁剪，保持比例）
    const imgRatio = img.width / img.height;
    const targetRatio = targetW / targetH;

    let sx, sy, sw, sh;

    if (imgRatio > targetRatio) {
      // 图片更宽，裁剪左右
      sh = img.height;
      sw = img.height * targetRatio;
      sx = (img.width - sw) / 2;
      sy = 0;
    } else {
      // 图片更高，裁剪上下
      sw = img.width;
      sh = img.width / targetRatio;
      sx = 0;
      sy = (img.height - sh) / 2;
    }

    // 绘制图片到 Canvas（居中裁剪并缩放）
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);

    // 转换为 PNG 格式
    return canvas.toDataURL('image/png');
  }

  // 格式化文件大小
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // 更新 GUI 状态
  function updateStatus(text, elementId) {
    try {
      if (gui && gui.setValue) {
        gui.setValue(elementId, text);
      }
    } catch (e) {
      sandbox.log(`[状态] ${text}`);
    }
  }

  // 更新进度
  function updateProgress(progress) {
    transferProgress = progress;
    updateStatus(`${progress}%`, 'progressText');
    sandbox.log(`传输进度: ${progress}%`);
  }

  // 处理并发送图片
  async function processAndSendImage() {
    if (!currentFile) {
      updateStatus('错误: 请先选择 PNG 图片', 'statusText');
      sandbox.log('错误: 未选择文件');
      return;
    }

    const device = sandbox.currentDevice;
    if (!device) {
      updateStatus('错误: 未连接设备', 'statusText');
      sandbox.log('错误: 未连接设备');
      return;
    }

    if (isTransferring) {
      updateStatus('错误: 传输正在进行中', 'statusText');
      sandbox.log('错误: 传输正在进行中');
      return;
    }

    isTransferring = true;
    updateStatus('正在处理图片...', 'statusText');
    updateProgress(0);

    try {
      // 读取目标尺寸
      readTargetDimensions();

      // 直接使用 GUI 已转换的 Base64 数据创建 data URL
      // currentFile 是 {name, type, size, data} 对象，data 是 Base64 编码
      const dataUrl = `data:${currentFile.type || 'image/png'};base64,${currentFile.data}`;

      // 加载图片
      updateStatus('正在加载图片...', 'statusText');
      const img = await loadImage(dataUrl);
      sandbox.log(`原始图片尺寸: ${img.width}x${img.height}`);

      // 调整尺寸并转换为 PNG
      updateStatus(`正在调整尺寸为 ${targetWidth}x${targetHeight}...`, 'statusText');
      const processedDataUrl = await resizeImageToPNG(img, targetWidth, targetHeight);

      // 提取 Base64 数据
      const base64Data = processedDataUrl.split(',')[1];

      // 计算处理后的大小
      const processedSize = Math.ceil(base64Data.length * 0.75);
      sandbox.log(`处理后图片大小: ${formatFileSize(processedSize)}`);

      // 检查处理后的大小
      if (processedSize > MAX_FILE_SIZE) {
        updateStatus(`错误: 处理后图片超过 1MB (${formatFileSize(processedSize)})，请减小尺寸`, 'statusText');
        sandbox.log('错误: 处理后图片超过 1MB');
        isTransferring = false;
        return;
      }

      // 保存处理后的数据
      currentFileData = {
        name: currentFile.name,
        size: processedSize,
        type: 'image/png',
        base64: base64Data,
        format: 'png',
        width: targetWidth,
        height: targetHeight
      };

      updateStatus(`图片处理完成: ${targetWidth}x${targetHeight} (${formatFileSize(processedSize)})，开始传输...`, 'statusText');
      sandbox.log('图片处理完成，开始传输...');

      // 发送请求
      const request = {
        type: 'request_image',
        target: 'background',
        maxWidth: targetWidth,
        maxHeight: targetHeight,
        acceptFormats: ['png'],
        maxFileSize: MAX_FILE_SIZE,
        timestamp: Date.now()
      };

      sandbox.wasm.thirdpartyapp_send_message(
        device.addr,
        PACKAGE_NAME,
        JSON.stringify(request)
      );

      // 等待一小段时间后开始传输
      await delay(500);

      // 发送图片分片
      await sendImageChunks(device.addr);

      updateStatus('传输完成!', 'statusText');
      sandbox.log('图片传输完成');

    } catch (error) {
      updateStatus(`错误: ${error.message}`, 'statusText');
      sandbox.log(`处理/传输错误: ${error.message}`);

      // 发送错误消息
      sendError(device.addr, 'TRANSFER_ERROR', error.message);
    } finally {
      isTransferring = false;
    }
  }

  // 发送图片分片
  async function sendImageChunks(deviceAddr) {
    const base64Data = currentFileData.base64;
    const totalChunks = Math.ceil(base64Data.length / CHUNK_SIZE);

    sandbox.log(`总分片数: ${totalChunks}`);
    sandbox.log(`图片大小: ${base64Data.length} bytes`);

    // 发送每个分片
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, base64Data.length);
      const chunk = base64Data.substring(start, end);

      const message = {
        type: 'image_chunk',
        target: 'background',
        index: i,
        total: totalChunks,
        data: chunk,
        format: 'png',
        chunkSize: chunk.length,
        timestamp: Date.now()
      };

      sandbox.wasm.thirdpartyapp_send_message(
        deviceAddr,
        PACKAGE_NAME,
        JSON.stringify(message)
      );

      // 更新进度
      const progress = Math.floor(((i + 1) / totalChunks) * 100);
      updateProgress(progress);

      // 添加小延迟避免消息堆积
      await delay(50);
    }

    // 发送完成消息
    const completeMessage = {
      type: 'image_complete',
      target: 'background',
      format: 'png',
      totalSize: currentFileData.size,
      width: targetWidth,
      height: targetHeight,
      timestamp: Date.now()
    };

    sandbox.wasm.thirdpartyapp_send_message(
      deviceAddr,
      PACKAGE_NAME,
      JSON.stringify(completeMessage)
    );

    sandbox.log('所有分片已发送');
  }

  // 发送错误消息
  function sendError(deviceAddr, errorCode, message) {
    const errorMsg = {
      type: 'image_error',
      target: 'background',
      error: errorCode,
      message: message,
      timestamp: Date.now()
    };

    sandbox.wasm.thirdpartyapp_send_message(
      deviceAddr,
      PACKAGE_NAME,
      JSON.stringify(errorMsg)
    );
  }

  // 延迟函数
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 注册事件监听器
  sandbox.wasm.register_event_sink((event) => {
    sandbox.log(`收到事件: ${event.type}`);

    if (event.type === 'thirdpartyapp_message') {
      sandbox.log(`来自 ${event.package_name} 的消息`);

      if (event.package_name === PACKAGE_NAME) {
        try {
          const data = event.data;
          sandbox.log(`消息内容: ${JSON.stringify(data).substring(0, 200)}`);

          // 处理 DIY Face 的响应
          if (data.type === 'chunk_ack') {
            sandbox.log(`收到分片确认: index=${data.index}`);
          } else if (data.type === 'image_error') {
            sandbox.log(`设备报告错误: ${data.error} - ${data.message}`);
            updateStatus(`设备错误: ${data.message}`, 'statusText');
          }
        } catch (e) {
          sandbox.log(`解析消息失败: ${e.message}`);
        }
      }
    }

    if (event.type === 'device_connected') {
      sandbox.log('设备已连接');
      updateStatus('设备已连接', 'statusText');
    }

    if (event.type === 'device_disconnected') {
      sandbox.log('设备已断开');
      updateStatus('设备已断开', 'statusText');
      isTransferring = false;
    }
  });

  // 绑定按钮事件
  gui.on('button:click', 'processBtn', processAndSendImage);

  gui.on('button:click', 'clearBtn', () => {
    currentFile = null;
    currentFileData = null;
    isTransferring = false;
    transferProgress = 0;
    updateProgress(0);
    updateStatus('未选择文件', 'fileInfo');
    updateStatus('等待操作...', 'statusText');
    sandbox.log('已清除选择');
  });

  // 监听文件选择
  let lastFileValue = null;
  setInterval(() => {
    try {
      const values = gui.getValues && gui.getValues();
      if (values && values.imageFile) {
        if (values.imageFile !== lastFileValue) {
          lastFileValue = values.imageFile;
          handleFileSelect(values.imageFile);
        }
      }
    } catch (e) {
      // 忽略错误
    }
  }, 500);

  sandbox.log('GUI 界面已创建');
  sandbox.log('等待用户操作...');

  // 检查设备连接状态
  const device = sandbox.currentDevice;
  if (device) {
    updateStatus('设备已连接，请选择图片', 'statusText');
    sandbox.log(`当前设备: ${device.name}`);
  } else {
    updateStatus('未连接设备，请先连接设备', 'statusText');
  }

})();