// 和风天气 JWT 认证（Ed25519 / EdDSA）
const fs = require('fs');
const { SignJWT, importPKCS8 } = require('jose');

class QWeatherJWT {
  constructor(config) {
    this.config = config;
    this.cache = null;
    this.cacheExp = 0;
  }

  async getPrivateKeyPem() {
    const { privateKey, privateKeyPath } = this.config;
    if (privateKey) return privateKey.trim();
    if (privateKeyPath && fs.existsSync(privateKeyPath)) {
      return fs.readFileSync(privateKeyPath, 'utf8').trim();
    }
    throw new Error('未配置私钥，请设置 QWEATHER_PRIVATE_KEY 或 QWEATHER_PRIVATE_KEY_PATH');
  }

  async generate() {
    const { projectId, credentialId } = this.config;
    if (!projectId || !credentialId) {
      throw new Error('缺少 JWT 配置：QWEATHER_PROJECT_ID 或 QWEATHER_CREDENTIAL_ID');
    }
    const pem = await this.getPrivateKeyPem();
    const key = await importPKCS8(pem, 'EdDSA');
    const iat = Math.floor(Date.now() / 1000) - 30; // 提前 30s 防时间误差
    return await new SignJWT({ sub: projectId, iat, exp: iat + 86400 })
      .setProtectedHeader({ alg: 'EdDSA', kid: credentialId })
      .sign(key);
  }

  async getToken() {
    const now = Math.floor(Date.now() / 1000);
    // 剩余 > 5 分钟复用
    if (this.cache && now < this.cacheExp - 300) return this.cache;
    const token = await this.generate();
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      this.cacheExp = payload.exp;
    } catch {
      this.cacheExp = now + 82800; // 解析失败兜底 23h
    }
    this.cache = token;
    return token;
  }
}

let _instance = null;

function getJWT(config) {
  if (!_instance) _instance = new QWeatherJWT(config);
  return _instance;
}

// 测试用：清空缓存
function _reset() {
  _instance = null;
}

module.exports = { QWeatherJWT, getJWT, _reset };