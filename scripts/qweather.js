#!/usr/bin/env node
'use strict';
// qweather - 和风天气统一 CLI
//
// 2026-10-13 重构要点：
//   * 天气默认走新版经纬度 API /weather/v1/{current,daily,hourly}
//     （旧 /v7/weather/* 已排 2027-06-01 停服；15d/30d 仍只有 v7 提供，故保留兼容）
//   * 错误处理：http.js 统一识别 RFC7807 + v7 两种错误体
//   * 新增天文（日出日落/月相，火烧云直接可用）、控制台用量、geo top/poi
//   * 所有子命令支持 --pretty / --normalize
//
// 子命令：
//   weather <now|hourly|daily|7d|15d|24h|30d>  天气
//   air <current|hourly|daily|station>          空气质量 v1
//   minutely                                   分钟级降水
//   warning                                    灾害预警
//   indices <1d|3d>                            生活指数
//   astro <sun|moon|both>                       日出日落 / 月升月落月相
//   geo <lookup|top|poi>                       GeoAPI
//   usage                                      控制台请求量统计
//   combined                                   一体化并发（推荐日常入口）

const { loadConfig } = require('./lib/config');
const { qweatherGet, buildUrl } = require('./lib/http');
const geo = require('./lib/geo');
const N = require('./lib/normalize');
const fmt = require('./lib/format');

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let neg = false;
      if (key.startsWith('no-')) { neg = true; key = key.slice(3); }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
      if (neg) args[key] = false; // --no-warning → args.warning === false
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------- 通用辅助 ----------

function numArg(args, name, dflt) {
  if (args[name] === undefined) return dflt;
  const v = Number(args[name]);
  if (!Number.isFinite(v)) throw new Error(`--${name} 需要数字，收到: ${args[name]}`);
  return v;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// 非致命警告收集（模糊城市命中等），统一在退出前打到 stderr
const warnings = [];
function pushWarning(msg) {
  if (!warnings.includes(msg)) warnings.push(msg);
}

// 统一解析位置：支持 --city / --lat --lon / 二者混合
async function resolveLocation(args, { needId = false } = {}) {
  const { host } = loadConfig();
  const lang = args.lang || 'zh';

  let info = null;
  if (args.city) info = await geo.lookup(args.city, { lang });

  if (args.lat !== undefined && args.lon !== undefined) {
    const lat = Number(args.lat);
    const lon = Number(args.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('--lat/--lon 必须是数字');
    if (lat < -90 || lat > 90) throw new Error(`纬度超出范围: ${lat}`);
    if (lon < -180 || lon > 180) throw new Error(`经度超出范围: ${lon}`);
    return {
      lat: lat.toFixed(2),
      lon: lon.toFixed(2),
      info,
      id: info ? info.id : null,
    };
  }

  if (!info) throw new Error('请传 --city <名称>，或同时传 --lat <纬度> --lon <经度>');

  // 模糊命中护栏：和风 GeoAPI 会把不认识的名称匹配到毫不相干的城市
  // （实测 "不存在的城市xyz" → 安城市/日本）。
  // 但正常查询也会走到这里（如 西双版纳 → 景洪），所以默认只警告、不中断：
  // 真正可靠的防线是 pretty/JSON 里始终输出实际命中的地点名，调用方能自己核对。
  // 需要严格模式时用 --strict-city 直接报错。
  if (info.match === 'fuzzy') {
    const msg = `城市名 "${args.city}" 未精确匹配，实际命中「${info.name}」（${info.adm1 || '?'}）`;
    if (args['strict-city']) throw new Error(`${msg}；--strict-city 已启用，确认无误可加 --force。`);
    pushWarning(`${msg}，数据可能不是你要的地点`);
  }

  if (needId && !info.id) {
    const { id } = await geo.resolveLocationId(args.city, { lang });
    info = { ...info, id };
  }
  return { lat: info.lat, lon: info.lon, info, id: info.id };
}

// 15d/30d 只有旧 v7 提供；其余一律走新版 v1
function isLegacyOnly(type) {
  return type === '15d' || type === '30d';
}

function today8() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// 日出日落 / 月相（并发拉取）。实时与逐小时接口不带 astro，必须单独取。
// daily 接口本身就含 astro，不需要额外请求。
async function fetchAstro(host, loc, lang = 'zh', date = today8()) {
  const locationParam = loc.id || `${loc.lon},${loc.lat}`;
  const [sun, moon] = await Promise.all([
    qweatherGet(buildUrl(host, '/v7/astronomy/sun', { location: locationParam, date })),
    qweatherGet(buildUrl(host, '/v7/astronomy/moon', { location: locationParam, date, lang })),
  ]);
  return N.normalizeAstro(sun, moon);
}

// ---------- 天气 ----------

async function cmdWeather(args) {
  const type = args._[1] || 'now';
  const valid = ['now', 'hourly', 'daily', '3d', '7d', '10d', '15d', '24h', '30d'];
  if (!valid.includes(type)) throw new Error(`weather 子命令必须是 ${valid.join('|')}，收到: ${type}`);

  const { host } = loadConfig();
  const lang = args.lang || 'zh';
  const loc = await resolveLocation(args, { needId: isLegacyOnly(type) });
  const localTime = args['local-time'] !== undefined ? args['local-time'] !== 'false' : true;

  // 旧版：仅 15d/30d
  if (isLegacyOnly(type)) {
    if (!loc.id) throw new Error(`${type} 需要 --city（LocationID）`);
    const url = buildUrl(host, `/v7/weather/${type}`, { location: loc.id, lang, warn: 'deprecated' });
    return { api: 'v7', type, raw: await qweatherGet(url), location: loc };
  }

  const qs = { lang, localTime };
  let path, apiType;
  if (type === 'now') {
    path = `/weather/v1/current/${loc.lat}/${loc.lon}`;
    apiType = 'now';
  } else if (type === 'hourly' || type === '24h') {
    path = `/weather/v1/hourly/${loc.lat}/${loc.lon}`;
    qs.hours = clamp(numArg(args, 'hours', type === '24h' ? 24 : 24), 1, 240);
    apiType = 'hourly';
  } else {
    path = `/weather/v1/daily/${loc.lat}/${loc.lon}`;
    const d = numArg(args, 'days', { '3d': 3, '7d': 7, '10d': 10 }[type] || 7);
    if (d < 1 || d > 10) throw new Error(`--days 必须在 1-10 之间（新版 daily 上限 10 天）`);
    qs.days = d;
    apiType = 'daily';
  }

  const raw = await qweatherGet(buildUrl(host, path, qs));
  const res = { api: 'v1', type: apiType, raw, location: loc };

  // daily 的 astro 就在响应里（零额外请求）；实时/逐小时要单独取
  if (apiType === 'daily') {
    const d0 = (raw.days && raw.days[0]) || null;
    res.astro = d0 && d0.astro ? N.normalizeAstro({ sunrise: d0.astro.sunrise, sunset: d0.astro.sunset }, null) : null;
  } else if (apiType === 'now' && ('astro' in args ? args.astro !== false : true)) {
    res.astro = await fetchAstro(host, loc, lang);
  }
  return res;
}

function normalizeWeather(res) {
  if (!res || !res.raw) return null;
  if (res.api === 'v7') {
    if (res.type === 'now') return { now: N.normalizeNow(res.raw.now, 'v7') };
    if (res.raw.daily) return { daily: res.raw.daily.map((d) => N.normalizeDay(d, 'v7')) };
    if (res.raw.hourly) return { hourly: res.raw.hourly.map((h) => N.normalizeHour(h, 'v7')) };
    return null;
  }
  if (res.type === 'now') return { now: N.normalizeNow(res.raw, 'v1') };
  if (res.raw.hours) return { hourly: res.raw.hours.map((h) => N.normalizeHour(h, 'v1')) };
  if (res.raw.days) return { daily: res.raw.days.map((d) => N.normalizeDay(d, 'v1')) };
  return null;
}

// ---------- 空气质量 ----------

async function cmdAir(args) {
  const type = args._[1] || 'current';
  const valid = ['current', 'hourly', 'daily', 'station'];
  if (!valid.includes(type)) throw new Error(`air 子命令必须是 ${valid.join('|')}，收到: ${type}`);

  const { host } = loadConfig();
  const lang = args.lang || 'zh';

  if (type === 'station') {
    const sid = args['station-id'] || args.station;
    if (!sid) throw new Error('air station 必须传 --station-id');
    const url = buildUrl(host, `/airquality/v1/station/${sid}`, { lang });
    return { api: 'v1', type, raw: await qweatherGet(url) };
  }

  const loc = await resolveLocation(args);
  const qs = { lang };
  if (args['local-time'] !== undefined) qs.localTime = args['local-time'] !== 'false';
  const url = buildUrl(host, `/airquality/v1/${type}/${loc.lat}/${loc.lon}`, qs);
  return { api: 'v1', type, raw: await qweatherGet(url), location: loc };
}

// ---------- 分钟降水 ----------

async function cmdMinutely(args) {
  const { host } = loadConfig();
  const lang = args.lang || 'zh';
  const loc = await resolveLocation(args);
  const url = buildUrl(host, '/v7/minutely/5m', { location: `${loc.lon},${loc.lat}`, lang });
  return { api: 'v7', type: 'minutely', raw: await qweatherGet(url), location: loc };
}

// ---------- 预警 ----------

async function cmdWarning(args) {
  const { host } = loadConfig();
  const lang = args.lang || 'zh';
  const loc = await resolveLocation(args);
  const qs = { lang };
  // 默认本地时区：预警 API 默认 UTC，直接展示会造成认知负担
  qs.localTime = args['local-time'] !== undefined ? args['local-time'] !== 'false' : true;
  const url = buildUrl(host, `/weatheralert/v1/current/${loc.lat}/${loc.lon}`, qs);
  return { api: 'v1', type: 'warning', raw: await qweatherGet(url), location: loc };
}

// ---------- 生活指数 ----------

async function cmdIndices(args) {
  const days = args._[1] || '1d';
  if (!['1d', '3d'].includes(days)) throw new Error(`indices 子命令必须是 1d 或 3d，收到: ${days}`);
  if (!args.type) throw new Error('请传 --type <id,id,...>（指数 ID 速查表见 SKILL.md）');

  const { host } = loadConfig();
  const lang = args.lang || 'zh';
  const loc = await resolveLocation(args);
  const url = buildUrl(host, `/v7/indices/${days}`, {
    type: args.type,
    location: `${loc.lon},${loc.lat}`,
    lang,
  });
  return { api: 'v7', type: 'indices', raw: await qweatherGet(url), location: loc };
}

// ---------- 天文（日出日落 / 月相） ----------

async function cmdAstro(args) {
  const which = args._[1] || 'both';
  if (!['sun', 'moon', 'both'].includes(which)) throw new Error(`astro 子命令必须是 sun|moon|both，收到: ${which}`);

  const { host } = loadConfig();
  const lang = args.lang || 'zh';
  const loc = await resolveLocation(args);
  const date = (args.date && String(args.date).replace(/-/g, '')) || today8();
  const locationParam = loc.id || `${loc.lon},${loc.lat}`;

  const out = { location: loc, date };
  const jobs = [];
  if (which === 'sun' || which === 'both') {
    jobs.push(
      qweatherGet(buildUrl(host, '/v7/astronomy/sun', { location: locationParam, date })).then((raw) => { out.sun = raw; })
    );
  }
  if (which === 'moon' || which === 'both') {
    jobs.push(
      qweatherGet(buildUrl(host, '/v7/astronomy/moon', { location: locationParam, date, lang })).then((raw) => { out.moon = raw; })
    );
  }
  await Promise.all(jobs);
  out.astro = N.normalizeAstro(out.sun, out.moon);
  return out;
}

// ---------- GeoAPI ----------

async function cmdGeo(args) {
  const action = args._[1] || 'lookup';
  if (action === 'lookup') {
    if (!args.city) throw new Error('请传 --city');
    if (args.list) {
      const { lang = 'zh', number = 10 } = args;
      return { action, candidates: await geo.lookupAll(args.city, { lang, number: Number(number) }) };
    }
    return { action, location: await geo.lookup(args.city, { lang: args.lang || 'zh', refresh: !!args.refresh }) };
  }
  if (action === 'top') {
    const where = args.city || args.lat || '101010100';
    return { action, topCityList: await geo.topCities({ location: where, lang: args.lang || 'zh' }) };
  }
  if (action === 'poi') {
    if (!args.keyword && !args.city) throw new Error('geo poi 需要 --city <关键词>');
    const { host } = loadConfig();
    const url = buildUrl(host, '/geo/v2/poi/lookup', {
      keyword: args.keyword || args.city,
      location: args.lat || args.location,
      lang: args.lang || 'zh',
    });
    return { action, raw: await qweatherGet(url) };
  }
  throw new Error(`geo 子命令只支持 lookup|top|poi，收到: ${action}`);
}

// ---------- 控制台用量 ----------

async function cmdUsage(args) {
  const { host } = loadConfig();
  const { projectId, credentialId } = loadConfig();
  const qs = {};
  if (args.project) qs.project = args.project || projectId;
  if (args.credential) qs.credential = args.credential || credentialId;
  // 控制台类接口无权限时返回 200 + 空 body
  const raw = await qweatherGet(buildUrl(host, '/metrics/v1/stats', qs), { allowEmptyBody: true });
  if (!raw) return { note: '该凭据未开通「请求量统计」权限（控制台 → 项目管理 → 凭据 → 控制台权限）' };
  return {
    asOf: raw.asOf,
    success: (raw.success || []).map((s) => ({ api: s.api, total: (s.hours || []).reduce((a, b) => a + b, 0) })),
  };
}

// ---------- combined：一体化并发 ----------

async function cmdCombined(args) {
  const type = args.type || 'now';
  const airType = args['air-type'] || 'current';
  const lang = args.lang || 'zh';
  const localTime = args['local-time'] !== undefined ? args['local-time'] !== 'false' : true;

  const wantMinutely = !('minutely' in args) || args.minutely !== false;
  const wantWarning = !('warning' in args) || args.warning !== false;
  const wantHourly = !('hourly' in args) || args.hourly !== false;
  // 日出日落默认带出（--no-astro 可关）；daily 本就自带，零额外开销
  const wantAstro = 'astro' in args ? args.astro !== false : true;
  const wantIndices = args.indices !== undefined && args.indices !== false;
  const hourlyHours = clamp(numArg(args, 'hours', 6), 1, 24);
  const dailyDays = clamp(numArg(args, 'days', 7), 1, 10);

  const { host } = loadConfig();
  const t0 = Date.now();

  // 位置：天气现在走经纬度，不再强依赖 LocationID
  const loc = await resolveLocation(args, { needId: isLegacyOnly(type) });

  const jobs = [];

  // 1) 天气
  const wqs = { lang, localTime };
  let weatherKind;
  if (isLegacyOnly(type)) {
    if (!loc.id) throw new Error(`${type} 需要 --city`);
    wqs.location = loc.id;
    weatherKind = 'legacy';
  } else if (type === 'now') {
    weatherKind = 'now';
  } else if (type === 'hourly' || type === '24h') {
    wqs.hours = 24;
    weatherKind = 'hourly';
  } else {
    wqs.days = { '3d': 3, '7d': 7, '10d': 10 }[type] || dailyDays;
    weatherKind = 'daily';
  }

  let weatherPath;
  if (weatherKind === 'legacy') weatherPath = `/v7/weather/${type}`;
  else if (weatherKind === 'now') weatherPath = `/weather/v1/current/${loc.lat}/${loc.lon}`;
  else if (weatherKind === 'hourly') weatherPath = `/weather/v1/hourly/${loc.lat}/${loc.lon}`;
  else weatherPath = `/weather/v1/daily/${loc.lat}/${loc.lon}`;

  const out = { weather: null, air: null, minutely: null, warning: null, hourly: null, astro: null, indices: null };
  jobs.push(qweatherGet(buildUrl(host, weatherPath, wqs)).then((raw) => { out.weather = { kind: weatherKind, api: weatherKind === 'legacy' ? 'v7' : 'v1', raw }; }));

  // 2) 空气质量
  const aqs = { lang };
  if (airType === 'hourly' || airType === 'daily') aqs.localTime = localTime;
  if (airType === 'station') {
    const sid = args['station-id'];
    if (!sid) throw new Error('--air-type station 必须传 --station-id');
    jobs.push(qweatherGet(buildUrl(host, `/airquality/v1/station/${sid}`, aqs)).then((raw) => { out.air = raw; }));
  } else {
    jobs.push(qweatherGet(buildUrl(host, `/airquality/v1/${airType}/${loc.lat}/${loc.lon}`, aqs)).then((raw) => { out.air = raw; }));
  }

  // 3) 分钟降水
  if (wantMinutely) {
    jobs.push(qweatherGet(buildUrl(host, '/v7/minutely/5m', { location: `${loc.lon},${loc.lat}`, lang }))
      .then((raw) => { out.minutely = raw; }));
  }

  // 4) 24h 逐小时（pretty 趋势）
  if (wantHourly) {
    const hqs = { lang, localTime, hours: 24 };
    const useId = !!loc.id;
    const hpath = `/weather/v1/hourly/${loc.lat}/${loc.lon}`;
    jobs.push(qweatherGet(buildUrl(host, hpath, hqs)).then((raw) => { out.hourly = raw; }));
  }

  // 5) 灾害预警
  if (wantWarning) {
    const wqs = { lang, localTime };
    jobs.push(qweatherGet(buildUrl(host, `/weatheralert/v1/current/${loc.lat}/${loc.lon}`, wqs))
      .then((raw) => { out.warning = raw; }));
  }

  // 6) 天文（日出日落 / 月相）
  if (wantAstro && weatherKind !== 'daily') {
    jobs.push(fetchAstro(host, loc, lang).then((astro) => { out.astro = astro; }));
  }

  // 7) 生活指数（可选，需 --indices）
  if (wantIndices) {
    const types = args.indices === true ? '2,3,5,14' : String(args.indices);
    jobs.push(qweatherGet(buildUrl(host, '/v7/indices/1d', { type: types, location: `${loc.lon},${loc.lat}`, lang }))
      .then((raw) => { out.indices = raw; }));
  }

  // 单路失败不该拖垮整体：记录错误继续
  const settled = await Promise.all(jobs.map((p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }))));
  const errors = {};
  for (const s of settled) if (!s.ok) errors[s.e.message.split(' · ')[0]] = s.e.message;

  // 归一
  const n = {};
  if (out.weather) {
    if (out.weather.api === 'v7') {
      if (out.weather.raw.now) n.now = N.normalizeNow(out.weather.raw.now, 'v7');
      else if (out.weather.raw.daily) n.daily = out.weather.raw.daily.map((d) => N.normalizeDay(d, 'v7'));
    } else {
      if (out.weather.kind === 'now') n.now = N.normalizeNow(out.weather.raw, 'v1');
      else if (out.weather.raw.days) n.daily = out.weather.raw.days.map((d) => N.normalizeDay(d, 'v1'));
    }
  }
  if (out.air) n.air = N.normalizeAir(out.air);
  if (out.minutely) n.minutely = N.normalizeMinutely(out.minutely);
  if (out.warning) n.warning = N.normalizeWarning(out.warning);
  if (out.hourly && out.hourly.hours) n.hourly = out.hourly.hours.map((h) => N.normalizeHour(h, 'v1'));
  if (out.astro) n.astro = out.astro;
  // daily 响应自带 astro，不额外发请求：直接从归一后的首日取
  if (!n.astro && Array.isArray(n.daily) && n.daily.length) {
    const d0 = n.daily[0];
    if (d0.sunrise || d0.sunset) {
      n.astro = { sunrise: d0.sunrise, sunset: d0.sunset, moonrise: d0.moonrise, moonset: d0.moonset, moonPhase: d0.moonPhase };
    }
  }
  const metadata = {
    city: args.city || null,
    location: loc.info || { lat: loc.lat, lon: loc.lon },
    weather_type: type,
    air_type: airType,
    include_minutely: wantMinutely,
    include_warning: wantWarning,
    include_hourly: wantHourly,
    include_astro: wantAstro,
    include_indices: wantIndices,
    hourly_hours: wantHourly ? hourlyHours : 0,
    daily_days: weatherKind === 'daily' ? wqs.days : 0,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
  };
  if (Object.keys(errors).length) metadata.warnings = errors;

  return { metadata, raw: out, n };
}

// ---------- 输出 ----------

function usage() {
  console.log(`qweather - 和风天气统一 CLI

天气
  qweather weather now      --city <名称> | --lat <lat> --lon <lon>   实时（新版 v1 经纬度）
  qweather weather hourly   --city <名称> [--hours 24]                逐小时 1-240
  qweather weather daily    --city <名称> [--days 7]                  每日 1-10（自带日出日落）
  qweather weather 7d|15d|30d --city <名称>                           15d/30d 仅旧版 v7 提供

空气质量
  qweather air current|hourly|daily --city <名称> | --lat <lat> --lon <lon>
  qweather air station --station-id <id>

其他
  qweather minutely  --city <名称>                未来 2 小时逐 5 分钟降水
  qweather warning   --city <名称>                灾害预警
  qweather indices 1d|3d --type <id,id,...> --city <名称>   生活指数
  qweather astro sun|moon|both --city <名称> [--date YYYYMMDD]   日出日落 / 月相
  qweather geo lookup --city <名称> [--list]      城市搜索
  qweather geo top    [--city 101010100]          热门城市
  qweather usage                                  控制台请求量统计

一体化（推荐日常入口，默认并发拉取）
  qweather combined --city <名称> [--type now|7d|...] [--air-type current|hourly|daily]
                     [--no-minutely] [--no-warning] [--no-hourly]
                     [--no-astro]                  # 日出日落/月相默认带出，关掉用这个
                     [--indices 2,3,5] [--hours N] [--days N]
                     [--pretty] [--normalize]

通用参数
  --lang zh|en     --local-time true|false     --pretty（人类可读）  --normalize（归一结构）

示例
  qweather combined --city 武汉 --pretty
  qweather combined --city 武汉 --type 7d --days 7 --astro --pretty
  qweather astro both --city 武汉 --pretty
`);
}

const COMMANDS = {
  weather: cmdWeather, air: cmdAir, minutely: cmdMinutely, warning: cmdWarning,
  indices: cmdIndices, astro: cmdAstro, geo: cmdGeo, usage: cmdUsage, combined: cmdCombined,
};

async function render(cmd, result, args) {
  // --normalize：只打归一后的结构（给下游程序消费）
  if (args.normalize) {
    if (result && result.n) {
      console.log(JSON.stringify({ metadata: result.metadata, ...result.n }, null, 2));
    } else if (cmd === 'weather') {
      console.log(JSON.stringify(normalizeWeather(result), null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (!args.pretty) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // --pretty
  if (cmd === 'combined') {
    console.log(fmt.formatCombined(result));
    return;
  }
  if (cmd === 'weather') {
    const n = normalizeWeather(result);
    const loc = (result && result.location && result.location.info) || null;
    const head = loc ? `📍 ${loc.name}${loc.adm1 && loc.adm1 !== loc.name ? ' · ' + loc.adm1 : ''}\n` : '';
    let body = '';
    if (n.now) body = fmt.formatNow(n.now);
    else if (n.daily) body = fmt.formatDaily(n.daily, numArg(args, 'days', undefined));
    else if (n.hourly) body = fmt.formatHourly(n.hourly, numArg(args, 'hours', 12));
    const astro = result && result.astro ? fmt.formatAstro(result.astro) : '';
    console.log((head + [body, astro].filter(Boolean).join('\n\n')).trim());
    return;
  }
  if (cmd === 'astro') {
    console.log(fmt.formatAstro(result.astro) || '无天文数据');
    return;
  }
  if (cmd === 'indices') {
    console.log(fmt.formatIndices(result.raw));
    return;
  }
  if (cmd === 'air') {
    console.log(fmt.formatAir(N.normalizeAir(result.raw)));
    return;
  }
  if (cmd === 'warning') {
    console.log(fmt.formatWarning(N.normalizeWarning(result.raw)));
    return;
  }
  if (cmd === 'minutely') {
    console.log(fmt.formatMinutely(N.normalizeMinutely(result.raw)));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`未知子命令: ${cmd}\n`);
    usage();
    process.exit(1);
  }

  try {
    const result = await fn(args);
    if (result && result.metadata) {
      for (const w of warnings) {
        if (!result.metadata.warnings) result.metadata.warnings = {};
        result.metadata.warnings.city_match = w;
      }
    }
    await render(cmd, result, args);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    // 提示可能是多行（参数清单），只在首行加 ↳，后续行保留自带的缩进
    if (err.hint) {
      const [first, ...rest] = String(err.hint).split('\n');
      console.error(`  ↳ ${first}`);
      for (const line of rest) console.error(line);
    }
    for (const w of warnings) console.error(`⚠️  ${w}`);
    if (/JWT|认证|credential/i.test(err.message)) {
      console.error('\n排查建议:');
      console.error('  1. 检查 QWEATHER_HOST / QWEATHER_PROJECT_ID / QWEATHER_CREDENTIAL_ID');
      console.error('  2. 确认公钥已上传到和风天气控制台');
      console.error('  3. 私钥文件路径正确且可读');
    }
    process.exit(1);
  }

  for (const w of warnings) console.error(`⚠️  ${w}`);
}

main();