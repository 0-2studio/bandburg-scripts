// 创建GUI界面
const guiConfig = {
  title: 'interconnect',
  elements: [
    {
      type: 'label',
      text: 'interconnect panel'
    },
    {
      type: 'input',
      id: 'rpkid',
      label: 'rpkid',
      placeholder: 'rpkid',
      value: ''
    },
{
      type: 'input',
      id: 'text',
      label: 'text',
      placeholder: 'text',
      value: ''
    },
    {
      type: 'button',
      id: 'submit',
      text: '执行操作'
    }
  ]
}

// 创建GUI
const gui = sandbox.gui(guiConfig)

// 监听按钮点击事件
gui.on('button:click', 'submit', () => {
  const values = gui.getValues()
  sandbox.log(`🎯 按钮被点击，当前值：${JSON.stringify(values)}`)
// 示例脚本：发送消息到第三方应用
// 需要先连接设备，然后执行此脚本

async function sendMessageToApp(rpkid,text) {
  const log = sandbox.log
  const wasm = sandbox.wasm
  
  // 检查是否有连接设备
  if (!sandbox.currentDevice) {
    log('❌ 没有连接设备，请先连接设备')
    return
  }
  
  const deviceAddr = sandbox.currentDevice.addr
  const packageName = rpkid // 替换为实际包名
  const message = text
  
  log(`📤 准备发送消息到应用 ${packageName}`)
  
  try {
    // 发送消息
    await wasm.thirdpartyapp_send_message(deviceAddr, packageName, message)
    log(`✅ 消息发送成功: "${message}"`)
  } catch (error) {
    log(`❌ 消息发送失败: ${error}`)
  }
}

// 执行函数
sendMessageToApp(values.rpkid,values.text)
})

sandbox.log('✅ GUI界面已创建，请与界面交互')