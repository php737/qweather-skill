'use strict';
// 和风天气 HTTP 客户端
//
// 关键点（2026-10-13 重构）：
// 1) 新版 /weather/v1/* 用 RFC7807 错误体 {"error":{status,title,detail,invalidParams}}，
//    旧版 v7 用 {"code":"400","message":"..."}。两种都要识别，否则 400/403/429 会被当成成功返回。
// 2) 必须看 HTTP status，不能只看 body。
// 3) 控制台类接口（/metrics/v1/stats、/finance/v1/summary）无权限时返回 200 + 空 body。
// 4) 原生 fetch 自带 gzip 解压与连接复用，比手撸 https+zlib 更稳；仍显式声明 Accept-Encoding。
// 5) 超时 + 429/5xx 指数退避重试，避免单次抖动直接失败。

const { loadConfig } = require('./config');
const { getJWT } = require('./jwt');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2; // 额外重试次数（总尝试 = 1 + retries）
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

class QWeatherError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'QWeatherError';
    Object.assign(this, extra); // status / code / invalidParams / cause
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildUrl(host, pathname, params) {
  const url = new URL(`https://${host}${pathname}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// 把两种错误格式统一成一条人类可读消息
function describeError(res, json, text) {
  const status = res.status;

  // 新版 RFC7807
  if (json && json.error && typeof json.error === 'object') {
    const e = json.error;
    const bits = [e.title || `HTTP ${e.status || status}`];
    if (e.detail && e.detail !== e.title) bits.push(e.detail);
    if (Array.isArray(e.invalidParams) && e.invalidParams.length) {
      bits.push(`参数: ${e.invalidParams.join(', ')}`);
    }
    const code = (e.type || '').split('#')[1] || null;
    return { message: bits.join(' · '), status: e.status || status, code, invalidParams: e.invalidParams };
  }

  // 旧版 v7
  if (json && json.code !== undefined && String(json.code) !== '200') {
    return {
      message: `${json.code}${json.message ? ` · ${json.message}` : ''}`,
      status: Number(json.code) || status,
      code: String(json.code),
    };
  }

  const snippet = (text || '').replace(/\s+/g, ' ').slice(0, 160);
  return { message: `HTTP ${status}${snippet ? ` · ${snippet}` : ''}`, status };
}

// 按参数给出准确约束（照 dev.qweather.com 文档核对过，避免「张冠李戴」的通用提示）
const PARAM_HINTS = {
  hours: '逐小时预报小时数，范围 1-240（默认 24）',
  days: '每日预报天数，范围 1-10（默认 7）；15/30 天仅旧版 /v7/weather/* 提供',
  date: '日期格式 yyyyMMdd，且只能选今天起 60 天内（含今天）',
  time: '时间格式 HHmm，24 时制（如 1830），仅太阳高度角接口使用',
  tz: '时区偏移，如 0800 / -0530，仅太阳高度角接口使用',
  alt: '海拔高度（米），如 43，仅太阳高度角接口使用',
  location: '可传城市名、LocationID，或「经度,纬度」（注意是 lon 在前）',
  latitude: '纬度 -90~90，最多两位小数',
  longitude: '经度 -180~180，最多两位小数',
  number: '返回候选数量，范围 1-20（默认 10）',
  adm: '上级行政区划名，用于过滤重名城市，如 adm=beijing',
  range: '国家/地区范围，ISO 3166 国家码，如 range=cn',
  type: '生活指数 ID，逗号分隔；中国 16 项，速查表见 SKILL.md',
  lang: '语言代码，如 zh（简中）/ en（英文）/ zh-hant（繁中）',
  localTime: '布尔值，只接受 true / false',
  stationId: '监测站 ID，形如 P53763',
  project: '项目 ID',
  credential: '凭据 ID',
};

function hintFor(info) {
  const s = info.status;
  if (s === 401) return 'JWT 认证失败：检查 QWEATHER_HOST / PROJECT_ID / CREDENTIAL_ID 与私钥是否匹配';
  if (s === 403) {
    if (info.code === 'deprecated') return '该 API 已弃用：改用新版 /weather/v1/*（旧 /v7/weather/* 将于 2027-06-01 停服）';
    return '权限/额度被拒：检查账号额度、欠费，或控制台未为该凭据授权此接口';
  }
  if (s === 404) return '路径不存在：确认 endpoint 与你的 API Host 匹配';
  if (s === 429) return '触发限流：降低并发或稍后再试';
  if (s >= 500) return '服务端异常：已自动重试仍失败，稍后再试';

  const bad = Array.isArray(info.invalidParams) ? info.invalidParams : [];
  if (bad.length) {
    const lines = bad.map((p) => {
      const known = PARAM_HINTS[p];
      return `  · ${p}：${known || '取值超出范围或格式不对'}`;
    });
    return `非法参数：\n${lines.join('\n')}`;
  }
  return '';
}

async function getJsonWithAuth(url, token, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = opts.retries !== undefined ? opts.retries : DEFAULT_RETRIES;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(250 * 2 ** (attempt - 1), 2000));

    let res, text;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Accept-Encoding': 'gzip, deflate',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      const timedOut = /timeout|abort/i.test(e.message || String(e));
      lastErr = new QWeatherError(
        timedOut ? `请求超时（${timeoutMs}ms）` : `网络请求失败: ${e.message}`,
        { cause: e }
      );
      continue; // 网络层抖动值得重试
    }

    // 控制台类接口：200 + 空 body
    if (res.status === 200 && (!text || !text.trim())) {
      if (opts.allowEmptyBody) return null;
      throw new QWeatherError('响应为空：通常表示该凭据未开通此接口的控制台权限', { status: 200 });
    }

    let json = null;
    if (text && text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new QWeatherError(`响应不是合法 JSON（HTTP ${res.status}）: ${text.slice(0, 120)}`, {
          status: res.status,
        });
      }
    }

    const ok =
      res.status >= 200 &&
      res.status < 300 &&
      !(json && json.error) &&
      !(json && json.code !== undefined && String(json.code) !== '200');

    if (ok) return json;

    const info = describeError(res, json, text);
    lastErr = new QWeatherError(info.message, {
      status: info.status,
      code: info.code,
      invalidParams: info.invalidParams,
    });
    lastErr.hint = hintFor(info);

    if (RETRYABLE_STATUS.has(res.status) && attempt < retries) continue;
    break;
  }

  // 提示放在 err.hint 上，由 CLI 决定怎么渲染（不要拼进 message，否则会重复打印）
  throw lastErr || new QWeatherError('请求失败');
}

// 便捷方法：自动取 JWT
async function qweatherGet(url, opts = {}) {
  const token = opts.token || (await getJWT(loadConfig()).getToken());
  return getJsonWithAuth(url, token, opts);
}

module.exports = { getJsonWithAuth, qweatherGet, buildUrl, QWeatherError, DEFAULT_TIMEOUT_MS };