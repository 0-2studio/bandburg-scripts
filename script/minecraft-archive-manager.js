const log = sandbox.log
const wasm = sandbox.wasm

const CONFIG = {
  packageName: 'com.application.minecraft.demo',
  chunkSize: 8192,
  timeout: 30000
}

let currentDevice = null
let archives = []
let currentGUI = null
let messageCallbackRegistered = false
let exportSession = null
let importSession = null
let ackResolver = null
let completedArchiveExports = {}
let recentMessageIds = {}
let recentMessageOrder = []
let activeExportSessionId = null
let activeImportSessionId = null
let finalizedArchiveExports = {}
let exportFinalizeLocks = {}

function buildExportCompletionKey(archiveId, sessionId) {
  return `${archiveId || 'none'}::${sessionId || 'default'}`
}

function isRecentTimestamp(map, key, ttl = 30000) {
  return !!(map[key] && Date.now() - map[key] < ttl)
}

function tryAcquireFinalizeLock(archiveId, ttl = 30000) {
  const key = archiveId || 'none'
  if (isRecentTimestamp(exportFinalizeLocks, key, ttl)) {
    return false
  }
  exportFinalizeLocks[key] = Date.now()
  return true
}

function releaseFinalizeLock(archiveId) {
  delete exportFinalizeLocks[archiveId || 'none']
}

function simpleHash(text) {
  const str = String(text || '')
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return String(hash)
}

function createSessionId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000000)}`
}

function buildClientMessageId(type, sessionId, archiveId, entryIndex, seq) {
  return `${type}:${sessionId || 'default'}:${archiveId || 'none'}:${entryIndex || 0}:${seq || 0}`
}

function buildInboundMessageId(msg, rawData) {
  if (!msg) return ''
  if (msg.messageId) return msg.messageId
  if (msg.payload && msg.payload.messageId) return msg.payload.messageId

  if (msg.type === 'export_data_start' && msg.payload) {
    return `export_data_start:${msg.payload.archiveId}:${msg.payload.entryIndex}:0`
  }
  if (msg.type === 'export_data_end' && msg.payload) {
    return `export_data_end:${msg.payload.archiveId}:${msg.payload.entryIndex}:0`
  }
  if (msg.type === 'export_data_chunk') {
    return `export_data_chunk:${msg.archiveId || ''}:${msg.entryIndex || ''}:${msg.seq || 0}:${simpleHash(msg.payload || '')}`
  }
  return `${msg.type}:${simpleHash(rawData || JSON.stringify(msg))}`
}

function cleanupRecentMessageIds(now) {
  const cutoff = now - 60000
  while (recentMessageOrder.length > 0 && recentMessageOrder[0].time < cutoff) {
    const item = recentMessageOrder.shift()
    delete recentMessageIds[item.id]
  }
  while (recentMessageOrder.length > 5000) {
    const item = recentMessageOrder.shift()
    delete recentMessageIds[item.id]
  }
}

function shouldIgnoreDuplicateMessage(msg, rawData) {
  const id = buildInboundMessageId(msg, rawData)
  if (!id) return false
  const now = Date.now()
  cleanupRecentMessageIds(now)
  if (recentMessageIds[id]) {
    return true
  }
  recentMessageIds[id] = now
  recentMessageOrder.push({ id, time: now })
  return false
}

function createExportEntryState(payload) {
  return {
    entryKind: payload.entryKind,
    entryPath: payload.entryPath,
    entryIndex: payload.entryIndex,
    totalEntries: payload.totalEntries,
    totalChunks: payload.totalChunks,
    chunksBySeq: {},
    finished: false
  }
}

const base64 = {
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
  },
  encode: (str) => {
    const encoder = new TextEncoder()
    return base64.encodeBytes(encoder.encode(str))
  },
  decode: (base64Str) => {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    return decoder.decode(base64.decodeToBytes(base64Str))
  }
}

function parseChunkKey(chunkKey) {
  const parts = String(chunkKey).split('|')
  return {
    chunkX: parseInt(parts[0], 10) || 0,
    chunkY: parseInt(parts[1], 10) || 0
  }
}

function chunkSort(a, b) {
  const ac = parseChunkKey(a)
  const bc = parseChunkKey(b)
  if (ac.chunkX !== bc.chunkX) return ac.chunkX - bc.chunkX
  return ac.chunkY - bc.chunkY
}

function buildChunkFileName(chunkKey) {
  const coords = parseChunkKey(chunkKey)
  return `overworld_${coords.chunkX}_${coords.chunkY}.json`
}

function splitLegacyWorldJson(worldData) {
  const data = worldData && worldData.data ? worldData.data : {}
  const overworld = data.world && data.world.overworld ? data.world.overworld : {}
  const metadata = {
    version: 4,
    storageFormat: 'chunked',
    chunkSize: 11,
    data: {
      camx: data.camx || 0,
      camy: data.camy || 0,
      player: data.player || {},
      world: {
        overworld: {
          index: {}
        }
      },
      mobs: Array.isArray(data.mobs) ? data.mobs : [],
      spawnPoint: data.spawnPoint || null,
      hasSpawnPoint: !!data.hasSpawnPoint
    }
  }

  const entries = [{
    entryKind: 'metadata',
    entryPath: 'metadata.json',
    text: JSON.stringify(metadata)
  }]

  Object.keys(overworld).sort(chunkSort).forEach((chunkKey) => {
    const relativePath = `chunks/${buildChunkFileName(chunkKey)}`
    metadata.data.world.overworld.index[chunkKey] = relativePath
  })

  entries[0].text = JSON.stringify(metadata)

  Object.keys(overworld).sort(chunkSort).forEach((chunkKey) => {
    entries.push({
      entryKind: 'chunk',
      entryPath: metadata.data.world.overworld.index[chunkKey],
      chunkKey,
      text: JSON.stringify(overworld[chunkKey])
    })
  })

  return {
    metadata,
    entries
  }
}

function rebuildLegacyWorldJson(metadata, chunkEntries) {
  const meta = metadata || {}
  const data = meta.data || {}
  const index = (((data.world || {}).overworld || {}).index) || {}
  const overworld = {}

  Object.keys(index).sort(chunkSort).forEach((chunkKey) => {
    const entryPath = index[chunkKey]
    const chunkText = chunkEntries[entryPath]
    if (!chunkText) return
    overworld[chunkKey] = JSON.parse(chunkText)
  })

  return {
    version: 3,
    data: {
      camx: data.camx || 0,
      camy: data.camy || 0,
      player: data.player || {},
      world: {
        overworld,
        underground: {}
      },
      mobs: Array.isArray(data.mobs) ? data.mobs : [],
      spawnPoint: data.spawnPoint || null,
      hasSpawnPoint: !!data.hasSpawnPoint
    }
  }
}

async function sendMessage(type, payload = null) {
  if (!currentDevice) {
    log('未连接设备')
    return false
  }

  const message = payload === null ? JSON.stringify({ type }) : JSON.stringify({ type, payload })
  try {
    await wasm.thirdpartyapp_send_message(currentDevice.addr, CONFIG.packageName, message)
    return true
  } catch (e) {
    log(`发送失败: ${e && e.message ? e.message : e}`)
    return false
  }
}

function setupMessageListener() {
  if (messageCallbackRegistered) return

  wasm.register_event_sink((event) => {
    if (event.type !== 'thirdpartyapp_message') return
    if (event.package_name !== CONFIG.packageName) return

    try {
      const rawData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
      const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      if (shouldIgnoreDuplicateMessage(msg, rawData)) return
      handleMessage(msg)
    } catch (e) {
      log(`解析消息失败: ${e.message}`)
    }
  })

  messageCallbackRegistered = true
}

function handleMessage(msg) {
  const { type, payload, seq } = msg

  switch (type) {
    case 'archive_list':
      archives = payload && payload.list ? payload.list : []
      if (currentGUI) {
        currentGUI.setValue('archiveCount', `共 ${archives.length} 个存档`)
        createMainGUI()
      }
      break
    case 'export_accept':
      if (!activeExportSessionId || !payload || payload.sessionId !== activeExportSessionId) break
      log('手环接受导出请求')
      break
    case 'export_reject':
      if (!activeExportSessionId || !payload || payload.sessionId !== activeExportSessionId) break
      activeExportSessionId = null
      log('手环拒绝导出请求')
      break
    case 'export_data_start':
      if (!activeExportSessionId || !payload || payload.sessionId !== activeExportSessionId) break
      handleExportStart(payload)
      break
    case 'export_data_chunk':
      if (!activeExportSessionId || msg.sessionId !== activeExportSessionId) break
      handleExportChunk(msg)
      break
    case 'export_data_end':
      if (!activeExportSessionId || !payload || payload.sessionId !== activeExportSessionId) break
      handleExportEnd(payload)
      break
    case 'import_accept':
      if (!activeImportSessionId || !payload || payload.sessionId !== activeImportSessionId) break
      log('手环接受导入请求')
      startImportData()
      break
    case 'import_reject':
      if (!activeImportSessionId || !payload || payload.sessionId !== activeImportSessionId) break
      activeImportSessionId = null
      importSession = null
      log('鎵嬬幆鎷掔粷瀵煎叆璇锋眰')
      break
    case 'import_chunk_ack':
      if (!activeImportSessionId || !payload || payload.sessionId !== activeImportSessionId) break
      handleChunkAck(payload && payload.seq ? payload.seq : seq, payload && payload.entryIndex)
      break
    case 'success':
      if (!activeImportSessionId || !payload || payload.sessionId !== activeImportSessionId) break
      activeImportSessionId = null
      log('操作成功')
      break
    case 'error':
      if (!payload || !payload.sessionId) break
      if (activeExportSessionId && payload.sessionId === activeExportSessionId) {
        activeExportSessionId = null
        exportSession = null
      } else if (activeImportSessionId && payload.sessionId === activeImportSessionId) {
        activeImportSessionId = null
        importSession = null
      } else {
        break
      }
      log(`鎿嶄綔澶辫触: ${payload && payload.message ? payload.message : '鏈煡閿欒'}`)
      break
      if (
        payload &&
        payload.sessionId &&
        ((activeExportSessionId && payload.sessionId !== activeExportSessionId) &&
        (activeImportSessionId && payload.sessionId !== activeImportSessionId))
      ) break
      log(`操作失败: ${payload && payload.message ? payload.message : '未知错误'}`)
      break
    default:
      break
  }
}

function handleExportStart(payload) {
  if (!payload) return
  if (isRecentTimestamp(finalizedArchiveExports, payload.archiveId)) return
  const completionKey = buildExportCompletionKey(payload.archiveId, payload.sessionId)
  if (
    completedArchiveExports[completionKey] &&
    Date.now() - completedArchiveExports[completionKey] < 30000
  ) {
    return
  }
  if (
    completedArchiveExports[payload.archiveId] &&
    Date.now() - completedArchiveExports[payload.archiveId] < 30000
  ) {
    return
  }

  if (exportSession) {
    if (
      exportSession.archiveId !== payload.archiveId ||
      exportSession.sessionId !== payload.sessionId
    ) {
      return
    }
  }

  if (!exportSession) {
    exportSession = {
      sessionId: payload.sessionId,
      archiveId: payload.archiveId,
      archiveName: payload.archiveName,
      totalEntries: payload.totalEntries,
      receivedMetadataText: '',
      receivedChunks: {},
      currentEntry: null,
      completedEntryMap: {}
    }
  }

  if (exportSession.completedEntryMap[payload.entryIndex]) return
  if (
    exportSession.currentEntry &&
    !exportSession.currentEntry.finished &&
    exportSession.currentEntry.entryIndex === payload.entryIndex
  ) {
    return
  }

  exportSession.currentEntry = createExportEntryState(payload)
}

function handleExportChunk(msg) {
  if (!exportSession || !exportSession.currentEntry) return
  if (msg.sessionId !== exportSession.sessionId) return
  if (msg.entryIndex && msg.entryIndex !== exportSession.currentEntry.entryIndex) return
  const seq = parseInt(msg.seq, 10) || 1
  if (exportSession.currentEntry.finished) return
  if (exportSession.currentEntry.chunksBySeq[seq] !== undefined) return
  exportSession.currentEntry.chunksBySeq[seq] = base64.decode(msg.payload)
  if (currentGUI) {
    currentGUI.setValue('progress', `接收中: 文件 ${exportSession.currentEntry.entryIndex}/${exportSession.currentEntry.totalEntries} 块 ${msg.seq}/${msg.total}`)
  }
}

function handleExportEnd(payload) {
  if (!exportSession || !exportSession.currentEntry) return
  if (!payload || payload.sessionId !== exportSession.sessionId) return
  if (isRecentTimestamp(finalizedArchiveExports, exportSession.archiveId)) return
  if (payload && payload.entryIndex && payload.entryIndex !== exportSession.currentEntry.entryIndex) return
  if (exportSession.currentEntry.finished) return
  if (payload && exportSession.completedEntryMap[payload.entryIndex]) return

  const parts = []
  for (let seq = 1; seq <= exportSession.currentEntry.totalChunks; seq++) {
    if (exportSession.currentEntry.chunksBySeq[seq] === undefined) {
      log(`瀵煎嚭鏉＄洰缂哄皯鍧? entry=${exportSession.currentEntry.entryIndex} seq=${seq}`)
      sendMessage('error', { message: '导出数据块缺失', sessionId: exportSession.sessionId })
      activeExportSessionId = null
      exportSession = null
      return
    }
    parts.push(exportSession.currentEntry.chunksBySeq[seq])
  }

  const entryText = parts.join('')
  if (exportSession.currentEntry.entryKind === 'metadata') {
    exportSession.receivedMetadataText = entryText
  } else {
    exportSession.receivedChunks[exportSession.currentEntry.entryPath] = entryText
  }
  exportSession.currentEntry.finished = true
  exportSession.completedEntryMap[exportSession.currentEntry.entryIndex] = true

  if (payload && payload.isLastEntry) {
    if (!tryAcquireFinalizeLock(exportSession.archiveId)) {
      activeExportSessionId = null
      exportSession = null
      return
    }
    try {
      if (isRecentTimestamp(finalizedArchiveExports, exportSession.archiveId)) {
        releaseFinalizeLock(exportSession.archiveId)
        activeExportSessionId = null
        exportSession = null
        return
      }
      finalizedArchiveExports[exportSession.archiveId] = Date.now()
      const metadata = JSON.parse(exportSession.receivedMetadataText)
      const worldData = rebuildLegacyWorldJson(metadata, exportSession.receivedChunks)
      const fileName = `${exportSession.archiveName || 'archive'}_${Date.now()}.json`
      downloadFile(fileName, JSON.stringify(worldData, null, 2))
      completedArchiveExports[buildExportCompletionKey(exportSession.archiveId, exportSession.sessionId)] = Date.now()
      completedArchiveExports[exportSession.archiveId] = Date.now()
      activeExportSessionId = null
      sendMessage('success', { archiveId: exportSession.archiveId, sessionId: exportSession.sessionId })
      if (currentGUI) {
        currentGUI.setValue('progress', '导出完成')
      }
    } catch (e) {
      releaseFinalizeLock(exportSession.archiveId)
      log(`导出重组失败: ${e.message}`)
      sendMessage('error', { message: '导出重组失败', sessionId: exportSession.sessionId })
      activeExportSessionId = null
    }
    exportSession = null
  } else {
    exportSession.currentEntry = null
  }
}

function downloadFile(fileName, content) {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

function waitForChunkAck(expectedSeq, expectedEntryIndex, timeout = 10000) {
  return new Promise((resolve) => {
    ackResolver = { expectedSeq, expectedEntryIndex, resolve }
    setTimeout(() => {
      if (
        ackResolver &&
        ackResolver.expectedSeq === expectedSeq &&
        ackResolver.expectedEntryIndex === expectedEntryIndex
      ) {
        ackResolver = null
        resolve(false)
      }
    }, timeout)
  })
}

function handleChunkAck(seq, entryIndex) {
  if (
    ackResolver &&
    ackResolver.expectedSeq === seq &&
    ackResolver.expectedEntryIndex === entryIndex
  ) {
    ackResolver.resolve(true)
    ackResolver = null
  }
}

async function startImportData() {
  if (!importSession || !importSession.entries || importSession.entries.length === 0) {
    log('没有待导入的数据')
    return
  }

  for (let entryIndex = 0; entryIndex < importSession.entries.length; entryIndex++) {
    const entry = importSession.entries[entryIndex]
    const totalChunks = entry.chunks.length

    await sendMessage('import_data_start', {
      sessionId: importSession.sessionId,
      messageId: buildClientMessageId('import_data_start', importSession.sessionId, importSession.archiveId, entryIndex + 1, 0),
      archiveName: importSession.archiveName,
      entryKind: entry.entryKind,
      entryPath: entry.entryPath,
      entryIndex: entryIndex + 1,
      totalEntries: importSession.entries.length,
      totalSize: entry.text.length,
      totalChunks
    })

    await new Promise((resolve) => setTimeout(resolve, 120))

    for (let chunkIndex = 0; chunkIndex < entry.chunks.length; chunkIndex++) {
      const message = JSON.stringify({
        type: 'import_data_chunk',
        sessionId: importSession.sessionId,
        entryIndex: entryIndex + 1,
        messageId: buildClientMessageId('import_data_chunk', importSession.sessionId, importSession.archiveId, entryIndex + 1, chunkIndex + 1),
        seq: chunkIndex + 1,
        total: totalChunks,
        payload: entry.chunks[chunkIndex]
      })

      await wasm.thirdpartyapp_send_message(currentDevice.addr, CONFIG.packageName, message)
      const acked = await waitForChunkAck(chunkIndex + 1, entryIndex + 1, 10000)
      if (!acked) {
        log(`等待 ACK 超时: 文件 ${entryIndex + 1} 块 ${chunkIndex + 1}`)
        await sendMessage('error', { message: '导入 ACK 超时', sessionId: importSession.sessionId })
        activeImportSessionId = null
        importSession = null
        return
      }

      if (currentGUI) {
        currentGUI.setValue('progress', `发送中: 文件 ${entryIndex + 1}/${importSession.entries.length} 块 ${chunkIndex + 1}/${totalChunks}`)
      }
    }

    await sendMessage('import_data_end', {
      sessionId: importSession.sessionId,
      messageId: buildClientMessageId('import_data_end', importSession.sessionId, importSession.archiveId, entryIndex + 1, 0),
      entryPath: entry.entryPath,
      entryIndex: entryIndex + 1,
      totalEntries: importSession.entries.length,
      isLastEntry: entryIndex === importSession.entries.length - 1
    })
  }

  importSession = null
}

function prepareImportData(fileContent, archiveName) {
  try {
    const json = JSON.parse(fileContent)
    const splitData = splitLegacyWorldJson(json)
    const entries = splitData.entries.map((entry) => {
      const encoder = new TextEncoder()
      const bytes = encoder.encode(entry.text)
      const chunks = []
      for (let i = 0; i < bytes.length; i += CONFIG.chunkSize) {
        chunks.push(base64.encodeBytes(bytes.slice(i, i + CONFIG.chunkSize)))
      }
      return {
        ...entry,
        chunks
      }
    })

    importSession = {
      sessionId: createSessionId('import'),
      archiveId: `import_${Date.now()}`,
      archiveName: archiveName || '未命名存档',
      entries
    }
    return true
  } catch (e) {
    log(`解析存档文件失败: ${e.message}`)
    return false
  }
}

function formatTime(timestamp) {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN')
}

function createMainGUI() {
  if (currentGUI) {
    try { currentGUI.close() } catch (e) {}
  }

  currentGUI = sandbox.gui({
    title: '我的世界 存档管理',
    elements: [
      { type: 'label', id: 'title', text: '我的世界 存档管理' },
      { type: 'label', id: 'deviceStatus', text: currentDevice ? `设备: ${currentDevice.name}` : '未连接设备' },
      { type: 'label', id: 'archiveCount', text: `共 ${archives.length} 个存档` },
      { type: 'button', id: 'refreshBtn', text: '刷新存档列表' },
      { type: 'label', id: 'exportLabel', text: '--- 导出存档 ---' },
      { type: 'select', id: 'archiveSelect', options: archives.map(a => ({ value: a.id, text: `${a.name} (${formatTime(a.createTime)})` })) },
      { type: 'button', id: 'exportBtn', text: '导出选中存档' },
      { type: 'label', id: 'importLabel', text: '--- 导入存档 ---' },
      { type: 'file', id: 'importFile', accept: '.json' },
      { type: 'button', id: 'importBtn', text: '导入存档' },
      { type: 'label', id: 'progress', text: '' }
    ]
  })

  currentGUI.on('button:click', 'refreshBtn', async () => {
    if (!currentDevice) {
      log('请先连接设备')
      return
    }
    await sendMessage('get_archive_list')
  })

  currentGUI.on('button:click', 'exportBtn', async () => {
    if (activeExportSessionId || exportSession) {
      log('已有导出任务进行中')
      return
    }
    const selectedId = currentGUI.getValue('archiveSelect')
    if (!selectedId) {
      log('请选择要导出的存档')
      return
    }

    const archive = archives.find(a => a.id === selectedId)
    if (!archive) {
      log('存档不存在')
      return
    }

    activeExportSessionId = createSessionId('export')
    exportSession = null
    const sent = await sendMessage('export_request', {
      id: selectedId,
      name: archive.name,
      sessionId: activeExportSessionId,
      messageId: buildClientMessageId('export_request', activeExportSessionId, selectedId, 0, 0)
    })
    if (!sent) {
      activeExportSessionId = null
    }
  })

  currentGUI.on('button:click', 'importBtn', async () => {
    if (activeImportSessionId || importSession) {
      log('已有导入任务进行中')
      return
    }
    const fileData = currentGUI.getValue('importFile')
    if (!fileData || !fileData.data) {
      log('请先选择存档文件')
      return
    }

    const content = base64.decodeToBytes(fileData.data)
    const decoder = new TextDecoder()
    const fileContent = decoder.decode(content)

    if (prepareImportData(fileContent, fileData.name.replace('.json', ''))) {
      activeImportSessionId = importSession.sessionId
      const sent = await sendMessage('import_request', {
        sessionId: importSession.sessionId,
        messageId: buildClientMessageId('import_request', importSession.sessionId, importSession.archiveId, 0, 0),
        archiveName: importSession.archiveName,
        totalEntries: importSession.entries.length
      })
      if (!sent) {
        activeImportSessionId = null
        importSession = null
      }
    }
  })
}

async function gotoapp() {
  try {
    await wasm.thirdpartyapp_get_list(currentDevice.addr)
    await wasm.thirdpartyapp_launch(currentDevice.addr, CONFIG.packageName, "")
    await new Promise(resolve => setTimeout(resolve, 1000))
  } catch (e) {
    log(`启动应用失败: ${e && e.message ? e.message : e}`)
  }
}

async function main() {
  if (!sandbox.currentDevice) {
    log('请先连接手环')
    return
  }

  currentDevice = sandbox.currentDevice
  await gotoapp()
  setupMessageListener()
  createMainGUI()
  await sendMessage('get_archive_list')
}

main()
