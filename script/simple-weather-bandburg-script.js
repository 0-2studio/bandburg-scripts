// 创建GUI界面
const guiConfig = {
    title: '简明天气同步器',
    elements: [
        {
            type: 'input',
            id: 'text',
            placeholder: '请粘贴天气数据',
            value: ''
        },
        {
            type: 'button',
            id: 'submit',
            text: '发送'
        },
        {
            type: 'button',
            id: 'openBrowser',
            text: '打开天气数据查询网站'
        },
        {
            type: 'button',
            id: 'openGuide',
            text: '打开数据传输教程'
        },
        {
            type: 'label',
            text: 'QQ交流群：947038648'
        }
    ]
}

// 创建GUI
const gui = sandbox.gui(guiConfig)

// 监听按钮点击事件
gui.on('button:click', 'submit', () => {
    const values = gui.getValues()
    
    // 检查输入内容是否为空
    if (!values.text || values.text.trim() === '') {
        sandbox.log('⚠️ 请先粘贴天气数据')
        return
    }
    
    // 示例脚本：发送消息到第三方应用
    // 需要先连接设备，然后执行此脚本

    async function sendMessageToApp(rpkid, text) {
        const log = sandbox.log
        const wasm = sandbox.wasm

        // 检查是否有连接设备
        if (!sandbox.currentDevice) {
            log('❌ 没有连接设备，请先连接设备')
            return
        }

        const deviceAddr = sandbox.currentDevice.addr
        const packageName = 'com.application.zaona.weather'
        const message = text

        try {
            // 发送消息
            await wasm.thirdpartyapp_send_message(deviceAddr, packageName, message)
            log(`✅ 发送成功`)
        } catch (error) {
            log(`❌ 发送失败: ${error}`)
        }
    }

    // 执行函数
    sendMessageToApp(values.rpkid, values.text)
})

// 监听打开新标签按钮
gui.on('button:click', 'openBrowser', () => {
    window.open('https://weather.zaona.top/weather', '_blank')
})
gui.on('button:click', 'openGuide', () => {
    window.open('https://www.yuque.com/zaona/weather/script', '_blank')
})