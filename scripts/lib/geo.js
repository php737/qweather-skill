'use strict';
// GeoAPI 封装：城市搜索 + 缓存
//
// 2026-10-13 重构要点：
// 1) 缓存条目带 TTL（默认 30 天）。和风官方明确禁止无限期缓存 GeoAPI 数据。
// 2) 精确同名优先：查 "朝阳区" 不应命中 "北京"。原实现无条件取 location[0]。
// 3) 原子写入（临时文件 + rename），避免并发进程写坏 JSON。
// 4) 保留 CITY_ID_MAP 冷启动，但标为 deprecated —— 新版天气接口走经纬度，不再依赖 LocationID。

const fs = require('fs');
const path = require('path');
const { qweatherGet, buildUrl } = require('./http');
const { loadConfig } = require('./config');

const CACHE_FILE = path.join(__dirname, '..', 'geo_cache.json');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return { __v: 2, entries: {} };
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw && raw.__v === 2 && raw.entries) return raw;
    // 旧版扁平格式 { "北京": {...} }：缺少 fetchedAt/record 包装，永远命不中，
    // 直接丢弃并落盘，避免死条目无限堆积。
    if (raw && typeof raw === 'object') return { __v: 2, entries: {} };
  } catch {}
  return { __v: 2, entries: {} };
}

function saveCache(cache) {
  // 原子写：先写 tmp 再 rename，避免半截文件
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function cacheGet(cache, key) {
  const hit = cache.entries[key];
  if (!hit || !hit.record || !hit.fetchedAt) return null;
  if (Date.now() - hit.fetchedAt > CACHE_TTL_MS) return null;
  return hit.record;
}

function cachePut(cache, key, record) {
  cache.entries[key] = { fetchedAt: Date.now(), record };
  saveCache(cache);
}

function cachePrune(cache) {
  const now = Date.now();
  let dirty = false;
  for (const [k, v] of Object.entries(cache.entries)) {
    // 既清超期的，也清旧格式/损坏的条目
    if (!v || !v.record || !v.fetchedAt || now - v.fetchedAt > CACHE_TTL_MS) {
      delete cache.entries[k];
      dirty = true;
    }
  }
  if (dirty) saveCache(cache);
}

// deprecated: 仅用于 v7 兼容（新版 /weather/v1/* 直接吃经纬度）
// 冷启动内置表，避免已知城市首次查询的 GeoAPI 往返
const CITY_ID_MAP = {
  北京: '101010100', 上海: '101020100', 天津: '101030100', 重庆: '101040100',
  广州: '101280101', 深圳: '101280601', 成都: '101270101', 杭州: '101210101',
  武汉: '101200101', 南京: '101190101', 西安: '101110101', 苏州: '101190401',
  长沙: '101250101', 株洲: '101250301', 湘潭: '101250201', 衡阳: '101250401',
  邵阳: '101250901', 岳阳: '101251001', 常德: '101250601', 张家界: '101251101',
  益阳: '101251201', 郴州: '101250501', 永州: '101251401', 怀化: '101251301',
  娄底: '101250801', 湘西: '101251501',
  青岛: '101120201', 宁波: '101210401', 厦门: '101230201', 大连: '101070201',
  郑州: '101180101', 济南: '101120101', 合肥: '101220101', 福州: '101230101',
  昆明: '101290101', 贵阳: '101260101', 南宁: '101300101', 海口: '101310101',
  兰州: '101160101', 西宁: '101150101', 银川: '101170101', 乌鲁木齐: '101130101',
  拉萨: '101140101', 石家庄: '101090101', 太原: '101100101', 沈阳: '101070101',
  长春: '101060101', 哈尔滨: '101050101', 南昌: '101240101', 呼和浩特: '101080101',
  珠海: '101280701', 东莞: '101281601', 佛山: '101280800', 韶关: '101280201',
};

function toRecord(loc) {
  return {
    id: loc.id,
    name: loc.name,
    adm1: loc.adm1,
    adm2: loc.adm2,
    lat: parseFloat(loc.lat).toFixed(2),
    lon: parseFloat(loc.lon).toFixed(2),
    fxLink: loc.fxLink,
  };
}

// 最长公共子串长度
function lcsSubstring(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j <= a.length; j++) {
      const sub = a.slice(i, j);
      if (b.includes(sub)) { best = Math.max(best, sub.length); }
    }
  }
  return best;
}

// 和风 GeoAPI 对无法识别的名称会「模糊匹配」到毫不相干的城市
// （实测 "不存在的城市xyz" → 安城市/爱知县/日本），静默返回错误地点比报错更危险。
//
// 判定用「最长公共子串 / 较长一方长度」的比值，而不是「是否存在公共子串」：
// 中文的 城市/新区 等常用词几乎任意地名都能命中，纯子串判断会把乱输入判成 partial 而漏放。
function classifyMatch(query, hitName) {
  if (!query || !hitName) return 'unknown';
  const q = query.toLowerCase();
  const h = hitName.toLowerCase();
  if (q === h) return 'exact';
  if (q.includes(h) || h.includes(q)) return 'partial';
  const ratio = lcsSubstring(q, h) / Math.max(q.length, h.length);
  return ratio >= 0.34 ? 'partial' : 'fuzzy';
}

// 城市搜索（带缓存 + 精确同名优先）
async function lookup(city, opts = {}) {
  const { lang = 'zh', number = 0, refresh = false } = opts;
  const cache = loadCache();
  if (!refresh) {
    const hit = cacheGet(cache, `${lang}:${city}`);
    if (hit) {
      // 缓存里的记录可能是旧版本写入的（没有 match 字段），读出时补算一次，
      // 否则模糊命中的护栏会被缓存绕过。
      return { ...hit, match: classifyMatch(city, hit.name) };
    }
  }

  const { host } = loadConfig();
  const qs = { location: city, lang };
  if (number > 1) qs.number = number;
  const url = buildUrl(host, '/geo/v2/city/lookup', qs);
  const data = await qweatherGet(url);

  const list = data.location || [];
  if (list.length === 0) throw new Error(`未找到城市: ${city}`);

  // 精确同名优先，退化到第一条
  const best = list.find((l) => l.name === city) || list[0];
  const record = toRecord(best);
  record.match = classifyMatch(city, best.name);
  // 模糊命中时只缓存警告标记，不缓存地点本身，避免错误地点被固化
  if (record.match !== 'fuzzy') cachePut(cache, `${lang}:${city}`, record);
  return record;
}

// 列出全部候选（--list 时用），不进缓存
async function lookupAll(city, opts = {}) {
  const { lang = 'zh', number = 10 } = opts;
  const { host } = loadConfig();
  const url = buildUrl(host, '/geo/v2/city/lookup', { location: city, lang, number });
  const data = await qweatherGet(url);
  return (data.location || []).map(toRecord);
}

async function topCities(opts = {}) {
  const { location, lang = 'zh' } = opts;
  const { host } = loadConfig();
  const url = buildUrl(host, '/geo/v2/city/top', { location, lang });
  const data = await qweatherGet(url);
  return data.topCityList || [];
}

// 查 LocationID（v7 兼容）
async function resolveLocationId(city, opts = {}) {
  if (CITY_ID_MAP[city]) return { id: CITY_ID_MAP[city], source: 'builtin' };
  const info = await lookup(city, opts);
  return { id: info.id, source: 'geoapi', info };
}

module.exports = {
  lookup, lookupAll, topCities, resolveLocationId, CITY_ID_MAP, classifyMatch,
  loadCache, saveCache, cachePrune, CACHE_FILE,
};