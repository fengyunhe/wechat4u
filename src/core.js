import fs from 'fs'
import path from 'path'

import _debug from 'debug'
import FormData from 'form-data'
import mime from 'mime'
import {
  getCONF,
  Request,
  isStandardBrowserEnv,
  assert,
  getClientMsgId
} from './util'

const debug = _debug('core')
  // Private
const PROP = Symbol()

export default class WechatCore {

  constructor() {
    this[PROP] = {
      uuid: '',
      uin: '',
      sid: '',
      skey: '',
      passTicket: '',
      formatedSyncKey: '',
      webwxDataTicket: '',
      deviceId: 'e' + Math.random().toString().substring(2, 17),

      baseRequest: {},
      syncKey: {}
    }

    this.CONF = getCONF()
    this.user = {}
    this.syncErrorCount = 0
    this.mediaSend = 0
    this.baseUri = ''
    this.request = new Request()
  }

  getUUID() {
    return this.request({
      method: 'POST',
      url: this.CONF.API_jsLogin
    }).then(res => {
      let window = {
        QRLogin: {}
      }
      eval(res.data)
      assert.equal(window.QRLogin.code, 200, res)

      return this[PROP].uuid = window.QRLogin.uuid
    }).catch(err => {
      debug(err)
      throw new Error('获取UUID失败')
    })
  }

  checkLogin() {
    let params = {
      'tip': 0,
      'uuid': this[PROP].uuid,
      'loginicon': true
    }
    return this.request({
      method: 'GET',
      url: this.CONF.API_login,
      params: params
    }).then(res => {
      let window = {}
      eval(res.data)
      assert.notEqual(window.code, 400, res)
      if (window.code == 200) {
        this.CONF = getCONF(window.redirect_uri.match(/(?:\w+\.)+\w+/)[0])
        this.rediUri = window.redirect_uri
        this.baseUri = this.CONF.baseUri
      }
      return window
    }).catch(err => {
      debug(err)
      throw new Error('获取手机确认登录信息失败')
    })
  }

  login() {
    return this.request({
      method: 'GET',
      url: this.rediUri,
      params: {
        fun: 'new'
      }
    }).then(res => {
      let pm = res.data.match(/<ret>(.*)<\/ret>/)
      if (pm && pm[1] == 0) {
        this[PROP].skey = res.data.match(/<skey>(.*)<\/skey>/)[1]
        this[PROP].sid = res.data.match(/<wxsid>(.*)<\/wxsid>/)[1]
        this[PROP].uin = res.data.match(/<wxuin>(.*)<\/wxuin>/)[1]
        this[PROP].passTicket = res.data.match(/<pass_ticket>(.*)<\/pass_ticket>/)[1]
      }
      if (res.headers['set-cookie']) {
        res.headers['set-cookie'].forEach(item => {
          if (/webwx.*?data.*?ticket/i.test(item)) {
            this[PROP].webwxDataTicket = item.match(/=(.*?);/)[1]
          } else if (/wxuin/i.test(item)) {
            this[PROP].uin = item.match(/=(.*?);/)[1]
          } else if (/wxsid/i.test(item)) {
            this[PROP].sid = item.match(/=(.*?);/)[1]
          }
        })
      }
      this[PROP].baseRequest = {
        'Uin': parseInt(this[PROP].uin, 10),
        'Sid': this[PROP].sid,
        'Skey': this[PROP].skey,
        'DeviceID': this[PROP].deviceId
      }
    }).catch(err => {
      debug(err)
      throw new Error('登录失败')
    })
  }

  init() {
    let params = {
      'pass_ticket': this[PROP].passTicket,
      'skey': this[PROP].skey,
      'r': ~new Date()
    }
    let data = {
      BaseRequest: this[PROP].baseRequest
    }
    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxinit,
      params: params,
      data: data
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)
      this[PROP].baseRequest.Skey = this[PROP].skey = data.SKey || this[PROP].skey
      this.updateSyncKey(data.SyncKey)
      this.user = data.User
      return this.user
    }).catch(err => {
      debug(err)
      throw new Error('微信初始化失败')
    })
  }

  notifyMobile() {
    let params = {
      pass_ticket: this[PROP].passTicket
    }
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Code': 3,
      'FromUserName': this.user['UserName'],
      'ToUserName': this.user['UserName'],
      'ClientMsgId': +new Date()
    }
    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxstatusnotify,
      params: params,
      data: data
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)
    }).catch(err => {
      debug(err)
      throw new Error('开启状态通知失败')
    })
  }

  getContact() {
    let params = {
      'lang': 'zh_CN',
      'pass_ticket': this[PROP].passTicket,
      'seq': 0,
      'skey': this[PROP].skey,
      'r': +new Date()
    }
    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxgetcontact,
      params: params
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)

      debug('获取联系人数量：' + data.MemberList.length)
      return data.MemberList
    }).catch(err => {
      debug(err)
      throw new Error('获取通讯录失败')
    })
  }

  batchGetContact(contacts) {
    let params = {
      'pass_ticket': this[PROP].passTicket,
      'type': 'ex',
      'r': +new Date()
    }
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Count': contacts.length,
      'List': contacts
    }
    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxbatchgetcontact,
      params: params,
      data: data
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)

      debug('批量获取联系人数量: ', data.ContactList.length)
      return data.ContactList
    }).catch(err => {
      debug(err)
      throw new Error('批量获取联系人失败')
    })
  }

  syncPolling(callback) {
    this.syncCheck().then(selector => {
      if (selector !== this.CONF.SYNCCHECK_SELECTOR_NORMAL) {
        return this.sync().then(data => {
          callback(data)
          this.syncPolling(callback)
        })
      } else {
        debug('WebSync Normal')
        this.syncPolling(callback)
      }
    }).catch(err => {
      if (++this.syncErrorCount > 1) {
        debug(err)
        this.logout().then(res => {
          debug(res)
          callback()
        })
      } else {
        setTimeout(() => {
          this.syncPolling(callback)
        }, 1000)
      }
    })
  }

  syncCheck() {
    let params = {
      'r': +new Date(),
      'sid': this[PROP].sid,
      'uin': this[PROP].uin,
      'skey': this[PROP].skey,
      'deviceid': this[PROP].deviceId,
      'synckey': this[PROP].formatedSyncKey
    }
    return this.request({
      method: 'GET',
      url: this.CONF.API_synccheck,
      params: params
    }).then(res => {
      let window = {
        synccheck: {}
      }
      eval(res.data)
      assert.equal(window.synccheck.retcode, this.CONF.SYNCCHECK_RET_SUCCESS, res)

      return window.synccheck.selector
    }).catch(err => {
      debug(err)
      throw new Error('同步失败')
    })
  }

  sync() {
    let params = {
      'sid': this[PROP].sid,
      'skey': this[PROP].skey,
      'pass_ticket': this[PROP].passTicket
    }
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'SyncKey': this[PROP].syncKey,
      'rr': ~new Date()
    }
    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxsync,
      params: params,
      data: data
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)

      this.updateSyncKey(data['SyncKey'])
      return data
    }).catch(err => {
      debug(err)
      throw new Error('获取新信息失败')
    })
  }

  updateSyncKey(syncKey) {
    this[PROP].syncKey = syncKey
    let synckeylist = []
    for (let e = this[PROP].syncKey['List'], o = 0, n = e.length; n > o; o++) {
      synckeylist.push(e[o][' '] + '_' + e[o]['Val'])
    }
    this[PROP].formatedSyncKey = synckeylist.join('|')
  }

  logout() {
    let params = {
      redirect: 1,
      type: 0,
      skey: this[PROP].skey
    }

    // data加上会出错，不加data也能登出
    // let data = {
    //   sid: this[PROP].sid,
    //   uin: this[PROP].uin
    // }
    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxlogout,
      params: params
    }).then(res => {
      return '登出成功'
    }).catch(err => {
      debug(err)
      return '可能登出成功'
    })
  }

  sendText(msg, to) {
    let params = {
      'pass_ticket': this[PROP].passTicket
    }
    let clientMsgId = this.getClientMsgId()
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Msg': {
        'Type': this.CONF.MSGTYPE_TEXT,
        'Content': msg,
        'FromUserName': this.user['UserName'],
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendmsg,
      params: params,
      data: data
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)
    }).catch(err => {
      debug(err)
      throw new Error('发送文本信息失败')
    })
  }

  sendEmoticon(id, to) {
    let params = {
      'fun': 'sys',
      'pass_ticket': this[PROP].passTicket
    }
    let clientMsgId = this.getClientMsgId()
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Msg': {
        'Type': this.CONF.MSGTYPE_EMOTICON,
        'EmojiFlag': 2,
        'FromUserName': this.user['UserName'],
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      },
      'Scene': 0
    }

    if (id.indexOf('@') === 0) {
      data.Msg.MediaId = id
    } else {
      data.Msg.EMoticonMd5 = id
    }

    this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendemoticon,
      params: params,
      data: data
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)
    }).catch(err => {
      debug(err)
      throw new Error('发送表情信息失败')
    })
  }

  // file: Stream, File
  uploadMedia(file) {
    let name, type, size, lastModifiedDate
    if (isStandardBrowserEnv) {
      name = file.name
      type = file.type
      size = file.size
      lastModifiedDate = file.lastModifiedDate
    } else {
      name = path.basename(file.path)
      type = mime.lookup(name)
      let stat = fs.statSync(file.path)
      size = stat.size
      lastModifiedDate = stat.mtime
    }

    let ext = name.match(/.*\.(.*)/)
    if (ext) {
      ext = ext[1]
    }

    let mediatype
    switch (ext) {
      case 'bmp':
      case 'jpeg':
      case 'jpg':
      case 'png':
        mediatype = 'pic'
        break
      case 'mp4':
        mediatype = 'video'
        break
      default:
        mediatype = 'doc'
    }

    let clientMsgId = this.getClientMsgId()

    let uploadMediaRequest = JSON.stringify({
      BaseRequest: this[PROP].baseRequest,
      ClientMediaId: clientMsgId,
      TotalLen: size,
      StartPos: 0,
      DataLen: size,
      MediaType: 4
    })

    let form = new FormData()
    form.append('id', 'WU_FILE_' + this.mediaSend++)
    form.append('name', name)
    form.append('type', type)
    form.append('lastModifiedDate', lastModifiedDate.toGMTString())
    form.append('size', size)
    form.append('mediatype', mediatype)
    form.append('uploadmediarequest', uploadMediaRequest)
    form.append('webwx_data_ticket', this[PROP].webwxDataTicket)
    form.append('pass_ticket', encodeURI(this[PROP].passTicket))
    form.append('filename', file, {
      filename: name,
      contentType: type,
      knownLength: size
    })

    let params = {
      f: 'json'
    }

    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxuploadmedia,
      headers: form.getHeaders(),
      params: params,
      data: form
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)
      let mediaId = data.MediaId
      assert.ok(mediaId, res)

      return {
        name: name,
        size: size,
        ext: ext,
        mediatype: mediatype,
        mediaId: mediaId
      }
    }).catch(err => {
      debug(err)
      throw new Error('上传媒体文件失败')
    })
  }

  sendPic(mediaId, to) {
    let params = {
      'pass_ticket': this[PROP].passTicket,
      'fun': 'async',
      'f': 'json'
    }
    let clientMsgId = this.getClientMsgId()
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Msg': {
        'Type': this.CONF.MSGTYPE_IMAGE,
        'MediaId': mediaId,
        'FromUserName': this.user.UserName,
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendmsgimg,
      params: params,
      data: data
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)
    }).catch(err => {
      debug(err)
      throw new Error('发送图片失败')
    })
  }

  sendVideo(mediaId, to) {
    let params = {
      'pass_ticket': this[PROP].passTicket,
      'fun': 'async',
      'f': 'json'
    }
    let clientMsgId = this.getClientMsgId()
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Msg': {
        'Type': this.CONF.MSGTYPE_VIDEO,
        'MediaId': mediaId,
        'FromUserName': this.user.UserName,
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendmsgvedio,
      params: params,
      data: data
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)
    }).catch(err => {
      debug(err)
      throw new Error('发送视频失败')
    })
  }

  sendDoc(mediaId, name, size, ext, to) {
    let params = {
      'pass_ticket': this[PROP].passTicket,
      'fun': 'async',
      'f': 'json'
    }
    let clientMsgId = this.getClientMsgId()
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Msg': {
        'Type': this.CONF.APPMSGTYPE_ATTACH,
        'Content': `<appmsg appid='wx782c26e4c19acffb' sdkver=''><title>${name}</title><des></des><action></action><type>6</type><content></content><url></url><lowurl></lowurl><appattach><totallen>${size}</totallen><attachid>${mediaId}</attachid><fileext>${ext}</fileext></appattach><extinfo></extinfo></appmsg>`,
        'FromUserName': this.user.UserName,
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    return this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendappmsg,
      params: params,
      data: data
    }).then(res => {
      let data = res.data
      assert.equal(data.BaseResponse.Ret, 0, res)
    }).catch(err => {
      debug(err)
      throw new Error('发送文件失败')
    })
  }

  getMsgImg(msgId) {
    let params = {
      MsgID: msgId,
      skey: this[PROP].skey,
      type: 'big'
    }

    return this.request({
      method: 'GET',
      url: this.CONF.API_webwxgetmsgimg,
      params: params,
      responseType: 'arraybuffer'
    }).then(res => {
      return {
        data: res.data,
        type: res.headers['content-type']
      }
    }).catch(err => {
      debug(err)
      throw new Error('获取图片失败')
    })
  }

  getVoice(msgId) {
    let params = {
      MsgID: msgId,
      skey: this[PROP].skey
    }

    return this.request({
      method: 'GET',
      url: this.CONF.API_webwxgetvoice,
      params: params,
      responseType: 'arraybuffer'
    }).then(res => {
      return {
        data: res.data,
        type: res.headers['content-type']
      }
    }).catch(err => {
      debug(err)
      throw new Error('获取声音失败')
    })
  }

  getEmoticon(content) {
    return Promise.resolve().then(() => {
      return this.request({
        method: 'GET',
        url: content.match(/cdnurl ?= ?"(.*?)"/)[1],
        responseType: 'arraybuffer'
      })
    }).then(res => {
      return {
        data: res.data,
        type: res.headers['content-type'],
        url: res.config.url
      }
    }).catch(err => {
      debug(err)
      throw new Error('获取表情失败')
    })
  }

  getHeadImg(HeadImgUrl) {
    let url = this.CONF.origin + HeadImgUrl
    return this.request({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer'
    }).then(res => {
      let headImg = {
        data: res.data,
        type: res.headers['content-type']
      }
      member.HeadImg = headImg
      return headImg
    }).catch(err => {
      debug(err)
      throw new Error('获取头像失败')
    })
  }
}
