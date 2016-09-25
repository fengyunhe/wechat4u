# wechat4u.js
![](http://7xr8pm.com1.z0.glb.clouddn.com/nodeWechat.png)

wechat4u core版本，提供完善的API和持续同步功能，不处理和储存其他信息

## 运行

```
npm install
npm run core
```

## 启动实例

```js
'use strict'
import WechatCore from './src/core.js'

start()

async function start() {
  let bot = new WechatCore()
  let res = undefined
  try {
    res = await bot.getUUID()
    console.log('https://login.weixin.qq.com/qrcode/' + res)
    do {
      res = await bot.checkLogin()
      console.log(res)
    } while (res.code !== 200)
    res = await bot.login()
    console.log(res)
    res = await bot.init()
    console.log(res)
    res = await bot.notifyMobile()
    console.log(res)
    res = await bot.getContact()
    console.log(Object.keys(res).length)
    bot.syncPolling(msg => {
      if (msg.AddMsgCount)
        console.log(msg.AddMsgList[0])
    })
  } catch (err) {
    console.log(err)
  }
}
```
