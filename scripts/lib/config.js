'use strict';
// 读取 ~/.openclaw/openclaw.json 中的 qweather 配置（进程内缓存，避免每次请求重读磁盘）
// 支持环境变量覆盖，便于测试与临时切换 API Host
const fs = require('fs');
const os = require('os');
const path = require('path');

let _cache = null;

function loadConfig(opts = {}) {
  if (_cache && !opts.reload) return _cache;

  const configPath =
    process.env.QWEATHER_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`读取配置文件失败: ${configPath} (${e.message})`);
  }

  const env = (config.skills && config.skills.entries && config.skills.entries.qweather && config.skills.entries.qweather.env) || {};
  const host = process.env.QWEATHER_HOST || env.QWEATHER_HOST;
  if (!host) throw new Error('未配置 QWEATHER_HOST（skills.entries.qweather.env）');

  // 注意：这里只读取，绝不打印任何密钥字段
  _cache = {
    host,
    projectId: process.env.QWEATHER_PROJECT_ID || env.QWEATHER_PROJECT_ID,
    credentialId: process.env.QWEATHER_CREDENTIAL_ID || env.QWEATHER_CREDENTIAL_ID,
    privateKeyPath:
      process.env.QWEATHER_PRIVATE_KEY_PATH || env.QWEATHER_PRIVATE_KEY_PATH,
    privateKey: process.env.QWEATHER_PRIVATE_KEY || env.QWEATHER_PRIVATE_KEY,
  };
  return _cache;
}

function resetConfig() {
  _cache = null;
}

module.exports = { loadConfig, resetConfig };