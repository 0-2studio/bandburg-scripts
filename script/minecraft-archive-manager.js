// 我的世界 存档管理脚本 - BandBurg Script
// 实现手环我的世界游戏存档的导出和导入功能
// 通信协议: Base64编码, 8KB分块

const log = sandbox.log
const wasm = sandbox.wasm

// 配置
const CONFIG = {
  packageName: 'com.application.minecraft.demo', // 我的世界游戏包名
  chunkSize: 8192, // 8KB
  timeout: 30000 // 30秒
}

// 状态
let currentDevice = null
let archives = []
let receiveBuffer = null
let currentGUI = null
let messageCallbackRegistered = false
let lastProcessedChunk = '' // 用于去重数据块
let processedExportEnds = new Set() // 记录已处理的 export_data_end

// 工具函数: Base64编解码
const base64 = {
  encode: (str) => {
    try {
      // 先转为 UTF-8 字节，再编码为 Base64
      const encoder = new TextEncoder()
      const bytes = encoder.encode(str)
      return base64.encodeBytes(bytes)
    } catch (e) {
      return btoa(str)
    }
  },
  decode: (base64Str) => {
    try {
      // Base64 解码为字节，再转为 UTF-8 字符串
      const bytes = base64.decodeToBytes(base64Str)
      const decoder = new TextDecoder('utf-8', { fatal: false })
      return decoder.decode(bytes)
    } catch (e) {
      return atob(base64Str)
    }
  },
  encodeBytes: (bytes) => {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  },
  decodeToBytes: (base64Str) => {
    const binary = atob(base64Str)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
}

// 发送消息到手环
async function sendMessage(type, payload = null) {
  if (!currentDevice) {
    log('❌ 未连接设备')
    return false
  }

  // 构建消息 - 不带 payload 时只发送 type
  let message
  if (payload === null) {
    message = JSON.stringify({ type })
  } else {
    message = JSON.stringify({ type, payload })
  }

  log(`📤 发送: ${message}`)

  try {
    // 检查 WASM 函数是否可用
    if (!wasm.thirdpartyapp_send_message) {
      log('❌ thirdpartyapp_send_message 函数不可用')
      return false
    }

    const result = await wasm.thirdpartyapp_send_message(
      currentDevice.addr,
      CONFIG.packageName,
      message
    )
    log(`✅ 消息已发送`)
    return true
  } catch (e) {
    // 改进错误显示
    const errorMsg = e?.message || e?.toString() || JSON.stringify(e) || '未知错误'
    log(`❌ 发送失败: ${errorMsg}`)
    console.error('发送错误详情:', e)
    return false
  }
}

// 注册消息监听
function setupMessageListener() {
  if (messageCallbackRegistered) {
    log('⚠️ 消息监听器已注册，跳过重复注册')
    return
  }

  wasm.register_event_sink((event) => {
    // 只处理第三方应用消息
    if (event.type !== 'thirdpartyapp_message') return
    if (event.package_name !== CONFIG.packageName) return

    try {
      // 解析消息
      const data = event.data
      const msg = typeof data === 'string' ? JSON.parse(data) : data

      // 对于数据块消息，使用 seq 作为唯一标识进行去重
      if (msg.type === 'export_data_chunk') {
        const chunkKey = `chunk_${msg.seq}_${msg.total}`
        if (lastProcessedChunk === chunkKey) {
          return // 跳过重复的数据块
        }
        lastProcessedChunk = chunkKey
      }

      // 对于 export_data_end，使用 archiveId 去重
      if (msg.type === 'export_data_end') {
        const endKey = `end_${msg.payload?.archiveId || Date.now()}`
        if (processedExportEnds.has(endKey)) {
          log(`⚠️ 跳过重复的 export_data_end`)
          return
        }
        processedExportEnds.add(endKey)
      }

      log(`📥 收到: ${msg.type}`)
      handleMessage(msg)
    } catch (e) {
      log(`❌ 解析消息失败: ${e.message}`)
    }
  })

  messageCallbackRegistered = true
  log('✅ 事件监听器已注册')
}

// 处理接收到的消息
function handleMessage(msg) {
  const { type, payload, seq, total } = msg

  log(`📥 收到: ${type}`)

  switch (type) {
    case 'archive_list':
      handleArchiveList(payload)
      break
    case 'export_accept':
      log('✅ 手环接受导出请求')
      break
    case 'export_reject':
      log('❌ 手环拒绝导出请求')
      break
    case 'export_data_start':
      // payload 包含 {archiveId, archiveName, totalSize, totalChunks}
      handleExportStart(payload)
      break
    case 'export_data_chunk':
      // seq, total, payload 在消息根级别
      handleExportChunk(msg)
      break
    case 'export_data_end':
      handleExportEnd(payload)
      break
    case 'import_accept':
      log('✅ 手环接受导入请求')
      startImportData()
      break
    case 'import_reject':
      log('❌ 手环拒绝导入请求')
      break
    case 'import_data_start':
      log('✅ 手环开始接收数据')
      break
    case 'import_data_chunk':
      // 手环确认收到数据块
      handleChunkAck(seq)
      break
    case 'import_chunk_ack':
      // 手环确认收到数据块
      handleChunkAck(payload?.seq || seq)
      break
    case 'import_data_end':
      log('✅ 导入数据发送完成')
      break
    case 'success':
      log('✅ 操作成功')
      break
    case 'error':
      log(`❌ 操作失败: ${payload?.message || '未知错误'}`)
      break
    default:
      log(`⚠️ 未知消息类型: ${type}`)
  }
}

// 处理存档列表
function handleArchiveList(payload) {
  archives = payload.list || []
  log(`📋 收到 ${archives.length} 个存档`)

  if (currentGUI) {
    currentGUI.setValue('archiveCount', `共 ${archives.length} 个存档`)
    updateArchiveSelect()
  }
}

// 更新存档选择下拉框
function updateArchiveSelect() {
  if (!currentGUI) return

  const options = archives.map(a => ({
    value: a.id,
    text: `${a.name} (${formatTime(a.createTime)})`
  }))

  // 重新创建GUI来更新选项
  createMainGUI()
}

// 格式化时间
function formatTime(timestamp) {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN')
}

// 导出流程: 开始
function handleExportStart(payload) {
  // payload 格式: {archiveId, archiveName, totalSize, totalChunks}
  const { archiveId, archiveName, totalSize, totalChunks } = payload

  log(`📦 收到 export_data_start: ${JSON.stringify(payload)}`)

  // 如果已有接收缓冲区，说明上一次导出未完成或重复收到 start
  if (receiveBuffer && receiveBuffer.archiveId === archiveId) {
    log(`⚠️ 收到重复的 export_data_start，跳过`)
    return
  }

  // 清空接收缓冲区，准备接收新数据
  receiveBuffer = {
    archiveId,
    archiveName,
    totalSize,
    totalChunks,
    receivedChunks: 0,
    data: '',
    receivedSeqs: new Set(),
    exportEnded: false // 标记是否已完成
  }

  log(`📦 开始接收存档: ${archiveName}`)
  log(`   大小: ${(totalSize / 1024).toFixed(2)} KB, 分块: ${totalChunks}`)
}

// 导出流程: 接收数据块
function handleExportChunk(msg) {
  if (!receiveBuffer) {
    log('❌ 未初始化接收缓冲区')
    return
  }

  // 数据格式: {type, seq, total, payload: "base64数据"}
  const seq = msg.seq
  const total = msg.total
  const chunkData = msg.payload

  if (seq === undefined || total === undefined) {
    log(`❌ 数据块格式错误: ${JSON.stringify(msg).slice(0, 100)}`)
    return
  }

  // 检查是否已接收过此块（防止重复）
  if (receiveBuffer.receivedSeqs.has(seq)) {
    log(`⚠️ 跳过重复块: ${seq}/${total}`)
    return
  }

  // 记录已接收的块
  receiveBuffer.receivedSeqs.add(seq)

  // 解码并追加数据
  if (chunkData) {
    let decoded = base64.decode(chunkData)
    // 移除每个块末尾的错误字符（通常是最后一个字符）
    // 检查是否为有效JSON字符，如果不是则移除
    if (decoded.length > 0) {
      const lastChar = decoded.charAt(decoded.length - 1)
      // 只保留可打印ASCII字符和有效UTF-8字符
      const cleanDecoded = decoded.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\xFF]/g, '')
      receiveBuffer.data += cleanDecoded
    }
  }
  receiveBuffer.receivedChunks++

  const progress = Math.round((receiveBuffer.receivedChunks / receiveBuffer.totalChunks) * 100)

  if (currentGUI) {
    currentGUI.setValue('progress', `接收进度: ${progress}%`)
  }

  log(`📦 接收中: ${receiveBuffer.receivedChunks}/${receiveBuffer.totalChunks} (${progress}%)`)
}

// 导出流程: 完成
function handleExportEnd(payload) {
  if (!receiveBuffer) {
    log('❌ 未初始化接收缓冲区')
    return
  }

  // 检查是否已经处理过
  if (receiveBuffer.exportEnded) {
    log('⚠️ 已处理过 export_data_end，跳过')
    return
  }

  // 标记为已完成
  receiveBuffer.exportEnded = true

  const { archiveId } = payload

  // 清理数据末尾可能的错误字符
  let cleanData = receiveBuffer.data.trimEnd()

  // 验证数据大小
  const actualSize = new Blob([cleanData]).size
  if (actualSize !== receiveBuffer.totalSize) {
    log(`⚠️ 数据大小不匹配: 期望 ${receiveBuffer.totalSize}, 实际 ${actualSize}`)
  }

  log(`📦 数据接收完成，共 ${receiveBuffer.receivedChunks} 块`)

  // 验证 JSON 格式并清理
  let jsonData = null
  try {
    jsonData = JSON.parse(cleanData)
    log('✅ JSON 格式验证通过')
  } catch (e) {
    log(`⚠️ JSON 格式验证失败: ${e.message}`)
    // 尝试找到最后一个有效的 JSON 结构
    let lastValidEnd = cleanData.lastIndexOf('}')
    if (lastValidEnd !== -1) {
      // 找到最后一个 } 的位置，截取到那里
      cleanData = cleanData.substring(0, lastValidEnd + 1)
      try {
        jsonData = JSON.parse(cleanData)
        log('✅ 修复后 JSON 格式验证通过')
      } catch (e2) {
        log(`❌ 无法修复 JSON 格式`)
      }
    }
  }

  // 保存文件
  const fileName = `${receiveBuffer.archiveName}_${Date.now()}.json`

  try {
    // 如果解析成功，使用格式化的 JSON
    const contentToSave = jsonData ? JSON.stringify(jsonData, null, 2) : cleanData
    downloadFile(fileName, contentToSave)
    log(`✅ 存档已保存: ${fileName}`)

    // 发送成功确认
    sendMessage('success', { archiveId })
  } catch (e) {
    log(`❌ 保存失败: ${e.message}`)
    sendMessage('error', { message: e.message })
  }

  // 清空接收缓冲区
  receiveBuffer = null
}

// 下载文件到本地
function downloadFile(fileName, content) {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

// 导入流程: 全局变量
let importData = null
let importChunks = []
let currentChunkIndex = 0
let ackResolver = null // 用于等待 ACK 的 Promise resolver

// 等待手环返回 chunk ACK
function waitForChunkAck(expectedSeq, timeout = 10000) {
  return new Promise((resolve) => {
    ackResolver = { expectedSeq, resolve }

    // 超时处理
    setTimeout(() => {
      if (ackResolver && ackResolver.expectedSeq === expectedSeq) {
        ackResolver = null
        log(`⚠️ 等待 ACK 超时: seq=${expectedSeq}`)
        resolve(false)
      }
    }, timeout)
  })
}

// 处理 chunk ACK
function handleChunkAck(seq) {
  if (ackResolver && ackResolver.expectedSeq === seq) {
    ackResolver.resolve(true)
    ackResolver = null
  }
}

// 开始导入数据传输
async function startImportData() {
  if (!importData || importChunks.length === 0) {
    log('❌ 没有待导入的数据')
    return
  }

  currentChunkIndex = 0
  await sendImportStart()

  // 开始发送数据块
  await sendImportChunks()
}

// 发送导入开始
async function sendImportStart() {
  const payload = {
    archiveId: importData.archiveId,
    archiveName: importData.archiveName,
    totalSize: importData.totalSize,
    totalChunks: importChunks.length
  }

  await sendMessage('import_data_start', payload)
  log(`📤 开始发送存档数据: ${importData.archiveName}`)
}

// 发送所有数据块（带 ACK 确认）
async function sendImportChunks() {
  log(`📤 开始发送 ${importChunks.length} 个数据块`)

  for (let i = 0; i < importChunks.length; i++) {
    // 直接构建消息，不使用 sendMessage（避免 payload 嵌套）
    // 手环期望格式: {type, seq, total, payload}
    const message = JSON.stringify({
      type: 'import_data_chunk',
      seq: i + 1,
      total: importChunks.length,
      payload: importChunks[i]
    })

    try {
      await wasm.thirdpartyapp_send_message(
        currentDevice.addr,
        CONFIG.packageName,
        message
      )

      // 等待手环返回 ACK
      const ackReceived = await waitForChunkAck(i + 1, 10000)
      if (!ackReceived) {
        log(`⚠️ 未收到 ACK，继续发送下一块`)
      }
    } catch (e) {
      log(`❌ 发送块 ${i + 1} 失败: ${e.message}`)
    }

    const progress = Math.round(((i + 1) / importChunks.length) * 100)

    if (currentGUI) {
      currentGUI.setValue('progress', `发送进度: ${progress}%`)
    }

    // 每发送5个块输出一次日志
    if ((i + 1) % 5 === 0 || i === importChunks.length - 1) {
      log(`📤 发送中: ${i + 1}/${importChunks.length} (${progress}%)`)
    }
  }

  // 发送结束
  await sendMessage('import_data_end', { archiveId: importData.archiveId })
  log('✅ 所有数据块已发送')

  importData = null
  importChunks = []
  currentChunkIndex = 0
}

// 准备导入数据
function prepareImportData(fileContent, archiveName) {
  try {
    // 验证JSON格式
    const json = JSON.parse(fileContent)

    // 转为字符串（不使用格式化，保持原始大小）
    const content = typeof fileContent === 'string' ? fileContent : JSON.stringify(json)

    log(`📄 文件内容长度: ${content.length} 字符`)

    // 计算字节大小
    const encoder = new TextEncoder()
    const bytes = encoder.encode(content)
    const totalSize = bytes.length

    log(`📄 字节大小: ${totalSize} bytes`)

    // 按字节分块，Base64编码
    importChunks = []
    for (let i = 0; i < bytes.length; i += CONFIG.chunkSize) {
      const chunkBytes = bytes.slice(i, i + CONFIG.chunkSize)
      // 将字节块转为 Base64
      const base64Chunk = base64.encodeBytes(chunkBytes)
      importChunks.push(base64Chunk)
    }

    importData = {
      archiveId: `import_${Date.now()}`,
      archiveName: archiveName || '未命名存档',
      totalSize,
      totalChunks: importChunks.length
    }

    log(`📦 准备导入: ${importData.archiveName}`)
    log(`   大小: ${(totalSize / 1024).toFixed(2)} KB, 分块: ${importChunks.length}`)

    return true
  } catch (e) {
    log(`❌ 解析存档文件失败: ${e.message}`)
    return false
  }
}

// 创建主界面
function createMainGUI() {
  if (currentGUI) {
    try { currentGUI.close() } catch (e) {}
  }

  const elements = [
    { type: 'label', id: 'title', text: '⛏️ 我的世界 存档管理' },
    { type: 'label', id: 'deviceStatus', text: currentDevice ? `设备: ${currentDevice.name}` : '未连接设备' },
    { type: 'label', id: 'archiveCount', text: `共 ${archives.length} 个存档` },
    { type: 'button', id: 'refreshBtn', text: '🔄 刷新存档列表' },
    { type: 'label', id: 'exportLabel', text: '--- 导出存档 ---' },
    { type: 'select', id: 'archiveSelect', options: archives.map(a => ({ value: a.id, text: a.name })) },
    { type: 'button', id: 'exportBtn', text: '📤 导出选中存档' },
    { type: 'label', id: 'importLabel', text: '--- 导入存档 ---' },
    { type: 'file', id: 'importFile', accept: '.json' },
    { type: 'button', id: 'importBtn', text: '📥 导入存档' },
    { type: 'label', id: 'progress', text: '' }
  ]

  currentGUI = sandbox.gui({
    title: '我的世界 存档管理',
    elements: elements
  })

  // 绑定事件
  currentGUI.on('button:click', 'refreshBtn', async () => {
    if (!currentDevice) {
      log('❌ 请先连接设备')
      return
    }
    await sendMessage('get_archive_list')
  })

  currentGUI.on('button:click', 'exportBtn', async () => {
    const selectedId = currentGUI.getValue('archiveSelect')
    if (!selectedId) {
      log('❌ 请选择要导出的存档')
      return
    }

    const archive = archives.find(a => a.id === selectedId)
    if (!archive) {
      log('❌ 存档不存在')
      return
    }

    await sendMessage('export_request', { id: selectedId, name: archive.name })
  })

  currentGUI.on('button:click', 'importBtn', async () => {
    const fileData = currentGUI.getValue('importFile')
    if (!fileData || !fileData.data) {
      log('❌ 请先选择存档文件')
      return
    }

    // 解码文件内容
    const content = base64.decodeToBytes(fileData.data)
    const decoder = new TextDecoder()
    const fileContent = decoder.decode(content)

    if (prepareImportData(fileContent, fileData.name.replace('.json', ''))) {
      await sendMessage('import_request', {
        archiveId: importData.archiveId,
        archiveName: importData.archiveName,
        totalSize: importData.totalSize,
        totalChunks: importData.totalChunks
      })
    }
  })

  currentGUI.on('file:change', 'importFile', (data) => {
    log(`📁 已选择文件: ${data.name}`)
  })
}

// 主函数
async function main() {
  log('⛏️ 我的世界 存档管理脚本启动')

  // 检查设备连接
  if (!sandbox.currentDevice) {
    log('❌ 未连接设备，请先在设备页面连接手环')
    log('💡 连接设备后重新运行此脚本')
    return
  }

  currentDevice = sandbox.currentDevice
  log(`✅ 已连接设备: ${currentDevice.name}`)

  // 自动打开我的世界应用
  log('🚀 正在启动我的世界应用...')
  await gotoapp()

  // 设置消息监听
  setupMessageListener()
  log('✅ 消息监听已设置')

  // 创建GUI界面
  createMainGUI()

  // 自动获取存档列表
  log('📋 正在获取存档列表...')
  await sendMessage('get_archive_list')
}

// 自动启动应用
async function gotoapp() {
  try {
    // 获取应用列表
    log('📋 获取应用列表...')
    await wasm.thirdpartyapp_get_list(currentDevice.addr)

    // 启动我的世界应用
    log(`🎮 启动应用: ${CONFIG.packageName}`)
    await wasm.thirdpartyapp_launch(currentDevice.addr, CONFIG.packageName, "")
    log('✅ 应用已启动')

    // 等待应用启动
    await new Promise(resolve => setTimeout(resolve, 1000))
  } catch (e) {
    const errorMsg = e?.message || e?.toString() || JSON.stringify(e) || '未知错误'
    log(`⚠️ 启动应用失败: ${errorMsg}`)
    log('💡 请确保手环已安装我的世界应用')
  }
}

// 启动
main()