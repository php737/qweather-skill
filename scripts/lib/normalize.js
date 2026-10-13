'use strict';
// 字段归一化：把和风两代 API 压成同一套实体，供 --normalize / --pretty 共用。
//
//   v1（新，经纬度）  /weather/v1/{current,daily,hourly}   —— 2027-06-01 前仍是可选，但 v7 城市接口已排停服
//   v7（旧，LocationID） /v7/weather/{now,3d,7d,15d,24h,30d}
//
// 单位差异（最容易踩坑的地方）：
//   v1 humidity      = 0-1     → 归一化成 0-100
//   v1 cloudCover    = 0-1     → 归一化成 0-100
//   v1 visibility    = 米      → 归一化成 km
//   v1 precipitation = {amount, intensity, type, probability}
//   v7 humidity      = 0-100   / vis = km / pop = 0-100

// ---------------- 基础工具 ----------------

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = v && typeof v === 'object' && 'value' in v ? v.value : v;
  const f = Number(x);
  return Number.isFinite(f) ? f : null;
};

// 0-1 → 0-100
const pct01 = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n * 100);
};
// 米 → km（保留一位小数，15000m → 15.0）
const toKm = (v) => {
  const n = num(v);
  return n === null ? null : Math.round((n / 1000) * 10) / 10;
};
const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

const COMPASS8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const COMPASS8_FULL = ['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风'];

// 风向角 → 中文方位（度 → 8 方位）
function compassCn(deg) {
  const d = num(deg);
  if (d === null) return null;
  const idx = Math.round((((d % 360) + 360) % 360) / 45) % 8;
  return { short: COMPASS8[idx], full: COMPASS8_FULL[idx] };
}

// v7 的 windDir 本身已是中文（"西北风"/"东北偏东风"），v1 需要由 degree 换算
function windText(deg, fallback) {
  if (fallback) return fallback;
  const c = compassCn(deg);
  return c ? c.full : null;
}

const MOON_PHASE_ZH = {
  new: '新月',
  'waxing-crescent': '蛾眉月',
  'first-quarter': '上弦月',
  'waxing-gibbous': '盈凸月',
  full: '满月',
  'waning-gibbous': '亏凸月',
  'last-quarter': '下弦月',
  'waning-crescent': '残月',
};
const MOON_PHASE_EMOJI = {
  新月: '🌑',
  蛾眉月: '🌒',
  上弦月: '🌓',
  盈凸月: '🌔',
  满月: '🌕',
  亏凸月: '🌖',
  下弦月: '🌗',
  残月: '🌘',
};

function moonPhaseName(raw) {
  if (!raw) return null;
  if (MOON_PHASE_ZH[raw]) return MOON_PHASE_ZH[raw];
  return raw; // v7 已返回中文
}

// UV 强度分级
function uvStrength(uv) {
  const n = num(uv);
  if (n === null) return null;
  if (n < 3) return '弱';
  if (n < 6) return '中等';
  if (n < 8) return '强';
  if (n < 11) return '很强';
  return '极强';
}

const isoDate = (iso) => (iso ? String(iso).slice(0, 10) : null); // YYYY-MM-DD

// ---------------- 天气现象 code → emoji ----------------
// 用 code 而非文案判断，--lang en 时 emoji 依然正确（文案匹配会全部落空）

const CODE_EMOJI = {
  100: '☀️', 150: '🌙', 101: '🌥️', 102: '🌤️', 103: '⛅', 104: '☁️',
  200: '🌙', 201: '🌙', 202: '🌙', 203: '☁️', 204: '☁️',
  205: '🌦️', 206: '🌦️', 207: '🌧️', 208: '🌧️', 209: '🌦️', 210: '⛈️',
  211: '🌧️', 212: '🌨️', 213: '❄️', 214: '❄️', 215: '❄️',
  216: '🌨️', 217: '🌨️', 218: '🌨️', 219: '🌨️',
  300: '⛈️', 301: '⛈️', 302: '🌧️', 303: '🌧️', 304: '⛈️',
  305: '🌦️', 306: '🌧️', 307: '🌧️', 308: '⛈️', 309: '⛈️', 310: '🌧️',
  311: '⛈️', 312: '⛈️', 313: '⛈️', 314: '⛈️', 315: '⛈️', 316: '⛈️', 317: '⛈️',
  399: '⛈️',
  400: '🌨️', 401: '❄️', 402: '❄️', 403: '❄️', 404: '❄️', 405: '🌨️',
  406: '🌨️', 407: '🌨️', 408: '🌨️', 409: '🌨️',
  499: '🧊',
  500: '🌫️', 501: '🌫️', 502: '🌫️', 503: '🌫️',
  504: '🌪️', 505: '🌪️', 506: '🌪️', 507: '🌪️', 508: '🌪️', 509: '🌪️',
  510: '🌪️', 511: '🌪️', 512: '🌪️', 513: '🌪️', 514: '🌪️', 515: '🌪️',
  599: '🌪️',
  600: '🌧️', 601: '🌧️', 602: '🌧️', 610: '🌧️', 611: '🌧️', 612: '🌧️', 613: '🌧️',
  620: '🌧️', 621: '🌧️', 622: '🌨️', 623: '🌨️', 624: '🌨️', 625: '🌨️', 626: '🌨️',
  630: '❄️', 631: '❄️', 632: '❄️', 633: '❄️', 635: '🌨️', 636: '❄️', 637: '❄️',
  650: '❄️', 651: '❄️', 652: '❄️', 653: '❄️', 654: '❄️', 655: '❄️',
  656: '❄️', 657: '❄️', 658: '❄️', 659: '❄️', 660: '❄️', 661: '❄️',
  662: '❄️', 663: '❄️', 670: '❄️', 671: '❄️', 672: '❄️', 673: '❄️', 674: '❄️', 675: '❄️', 676: '❄️',
  700: '🌨️', 701: '❄️', 702: '❄️', 703: '❄️', 704: '❄️', 705: '🌨️', 706: '🌨️', 707: '🌨️', 708: '🌨️', 709: '🌨️',
  710: '🌧️', 711: '🌧️', 712: '🌧️', 713: '🌧️', 714: '🌧️', 715: '🌧️', 716: '🌧️',
  730: '🌨️', 731: '❄️', 732: '❄️', 733: '❄️', 734: '❄️', 735: '🌨️', 736: '❄️', 737: '❄️',
  740: '🌫️', 741: '🌫️', 742: '🌪️', 743: '🌪️', 744: '🌪️', 745: '🌪️', 746: '🌪️', 747: '🌪️',
  750: '🌫️', 751: '🌫️', 752: '🌫️', 753: '🌫️', 754: '🌫️', 755: '🌫️', 756: '🌫️',
  800: '☀️', 801: '🌙', 802: '🌤️', 803: '🌙', 804: '🌙', 805: '🌤️', 806: '☁️', 807: '🌙',
  810: '🌪️', 811: '🌪️', 812: '🌪️', 813: '🌪️', 814: '🌪️',
  820: '🌫️', 821: '🌫️',
  900: '🌀', 901: '🌀', 902: '🌀', 903: '🌀', 904: '🌀', 905: '🌀', 906: '🌀',
  907: '🌀', 908: '🌀', 909: '🌀', 910: '🌀', 911: '🌀', 912: '🌀', 913: '🌀',
  920: '🌀', 921: '🌀', 922: '🌀', 923: '🌀', 924: '🌀', 925: '🌀', 926: '🌀', 927: '🌀',
  928: '🌀', 929: '🌀', 930: '🌀', 931: '🌀', 932: '🌀', 940: '🌀', 941: '🌀', 942: '🌀', 943: '🌀', 944: '🌀',
  950: '🌀', 951: '🌀', 952: '🌀', 953: '🌀', 954: '🌀', 955: '🌀', 956: '🌀', 957: '🌀',
  958: '🌀', 959: '🌀', 960: '🌀', 961: '🌀', 962: '🌀', 963: '🌀', 964: '🌀', 965: '🌀',
};

function weatherEmoji(code, text) {
  const c = code === null || code === undefined ? null : String(code);
  if (c && CODE_EMOJI[c]) return CODE_EMOJI[c];
  // code 缺失时回退到中文文案匹配（仅 zh 有效）
  const t = String(text || '');
  if (!t) return '🌡️';
  if (t.includes('雷')) return '⛈️';
  if (t.includes('雪') && t.includes('雨')) return '🌨️';
  if (t.includes('雪')) return '❄️';
  if (t.includes('雨')) return '🌧️';
  if (t.includes('雾') || t.includes('霾') || t.includes('沙') || t.includes('尘')) return '🌫️';
  if (t.includes('阴')) return '☁️';
  if (t.includes('云')) return '🌥️';
  if (t.includes('晴')) return '☀️';
  return '🌡️';
}

// ---------------- 实体归一 ----------------

// 实时天气
function normalizeNow(raw, source) {
  if (!raw) return null;
  const v1 = source === 'v1' || raw.temperature !== undefined;
  if (v1) {
    const w = raw.wind || {};
    return {
      source: 'v1',
      time: null, // v1 current 不返回观测时间，用请求时刻兜底
      text: raw.condition ? raw.condition.text : null,
      code: raw.condition ? raw.condition.code : null,
      temp: round1(num(raw.temperature)),
      feelsLike: round1(num(raw.feelsLike)),
      humidity: pct01(raw.humidity),
      cloud: pct01(raw.cloudCover),
      pressure: round1(num(raw.pressure)),
      visibilityKm: toKm(raw.visibility),
      dew: round1(num(raw.dewPoint)),
      uvIndex: num(raw.uvIndex),
      windDeg: num(w.direction ? w.direction.degree : null),
      windDir: windText(w.direction ? w.direction.degree : null, null),
      windScale: num(w.scale),
      windSpeed: round1(num(w.speed)),
      gust: round1(num(raw.windGust)),
      precip: {
        amount: round1(num(raw.precipitation && raw.precipitation.amount)),
        intensity: round1(num(raw.precipitation && raw.precipitation.intensity)),
        type: (raw.precipitation && raw.precipitation.type) || null,
        pop: null,
      },
    };
  }
  return {
    source: 'v7',
    time: raw.obsTime || null,
    text: raw.text || null,
    code: raw.icon || null,
    temp: round1(num(raw.temp)),
    feelsLike: round1(num(raw.feelsLike)),
    humidity: num(raw.humidity),
    cloud: num(raw.cloud),
    pressure: num(raw.pressure),
    visibilityKm: num(raw.vis),
    dew: round1(num(raw.dew)),
    uvIndex: num(raw.uvIndex !== undefined ? raw.uvIndex : raw.uv),
    windDeg: num(raw.wind360Dir),
    windDir: raw.windDir || null,
    windScale: num(raw.windScale),
    windSpeed: null,
    gust: null,
    precip: { amount: round1(num(raw.precip)), intensity: null, type: null, pop: null },
  };
}

// 逐小时
function normalizeHour(raw, source) {
  if (!raw) return null;
  const v1 = source === 'v1' || raw.forecastTime !== undefined;
  if (v1) {
    const w = raw.wind || {};
    const p = raw.precipitation || {};
    return {
      source: 'v1',
      time: raw.forecastTime || null,
      text: raw.condition ? raw.condition.text : null,
      code: raw.condition ? raw.condition.code : null,
      temp: round1(num(raw.temperature)),
      feelsLike: round1(num(raw.feelsLike)),
      humidity: pct01(raw.humidity),
      cloud: pct01(raw.cloudCover),
      pressure: round1(num(raw.pressure)),
      visibilityKm: toKm(raw.visibility),
      dew: round1(num(raw.dewPoint)),
      uvIndex: num(raw.uvIndex),
      windDeg: num(w.direction ? w.direction.degree : null),
      windDir: windText(w.direction ? w.direction.degree : null, null),
      windScale: num(w.scale),
      windSpeed: round1(num(w.speed)),
      gust: round1(num(raw.windGust)),
      precip: {
        amount: round1(num(p.amount)),
        intensity: round1(num(p.intensity)),
        type: p.type || null,
        pop: p.probability === undefined ? null : Math.round(Number(p.probability) * 100),
      },
    };
  }
  return {
    source: 'v7',
    time: raw.fxTime || null,
    text: raw.text || null,
    code: raw.icon || null,
    temp: round1(num(raw.temp)),
    feelsLike: null,
    humidity: num(raw.humidity),
    cloud: num(raw.cloud),
    pressure: num(raw.pressure),
    visibilityKm: num(raw.vis),
    dew: round1(num(raw.dew)),
    uvIndex: num(raw.uvIndex),
    windDeg: num(raw.wind360Dir),
    windDir: raw.windDir || null,
    windScale: num(raw.windScale),
    windSpeed: null,
    gust: null,
    precip: {
      amount: round1(num(raw.precip)),
      intensity: null,
      type: null,
      pop: raw.pop === undefined || raw.pop === '' ? null : num(raw.pop),
    },
  };
}

// 逐日
function normalizeDay(raw, source) {
  if (!raw) return null;
  const v1 = source === 'v1' || raw.daytime !== undefined;
  if (v1) {
    const day = raw.daytime || {};
    const night = raw.nighttime || {};
    const astro = raw.astro || {};
    return {
      source: 'v1',
      date: isoDate(raw.forecastStartTime),
      textDay: day.condition ? day.condition.text : null,
      codeDay: day.condition ? day.condition.code : null,
      textNight: night.condition ? night.condition.text : null,
      codeNight: night.condition ? night.condition.code : null,
      tempMax: round1(num(raw.temperatureMax)),
      tempMin: round1(num(raw.temperatureMin)),
      tempAvg: round1(num(raw.temperatureAvg)),
      uvIndex: num(raw.uvIndexMax),
      humidity: pct01(day.humidity),
      cloud: pct01(day.cloudCover),
      windDeg: num(day.wind && day.wind.direction ? day.wind.direction.degree : null),
      windDir: windText(day.wind && day.wind.direction ? day.wind.direction.degree : null, null),
      windScale: num(day.wind ? day.wind.scale : null),
      gust: round1(num(day.windGustMax)),
      pop:
        day.precipitation && day.precipitation.probability !== undefined
          ? Math.round(Number(day.precipitation.probability) * 100)
          : null,
      precipMm: round1(num(day.precipitation && day.precipitation.amount)),
      precipType: (day.precipitation && day.precipitation.type) || null,
      sunrise: astro.sunrise || null,
      sunset: astro.sunset || null,
      moonrise: astro.moonrise || null,
      moonset: astro.moonset || null,
      moonPhase: moonPhaseName(astro.moonPhase),
    };
  }
  return {
    source: 'v7',
    date: raw.fxDate || null,
    textDay: raw.textDay || null,
    codeDay: raw.iconDay || null,
    textNight: raw.textNight || null,
    codeNight: raw.iconNight || null,
    tempMax: round1(num(raw.tempMax)),
    tempMin: round1(num(raw.tempMin)),
    tempAvg: null,
    uvIndex: num(raw.uvIndex),
    humidity: num(raw.humidity),
    cloud: num(raw.cloud),
    windDeg: num(raw.wind360DirDay),
    windDir: raw.windDirDay || null,
    windScale: num(raw.windScaleDay),
    gust: null,
    pop: raw.pop === undefined || raw.pop === '' ? null : num(raw.pop),
    precipMm: round1(num(raw.precip)),
    precipType: null,
    sunrise: raw.sunrise || null,
    sunset: raw.sunset || null,
    moonrise: null,
    moonset: null,
    moonPhase: moonPhaseName(raw.moonPhase),
  };
}

// 空气质量（两代字段基本一致，只做防御性取值）
function normalizeAir(raw) {
  if (!raw) return null;
  const idx = (raw.indexes && raw.indexes[0]) || null;
  if (!idx) return { source: raw, aqi: null, category: null, primary: null, level: null, color: null, health: null, pollutants: [] };
  return {
    source: raw,
    aqi: idx.aqiDisplay !== undefined ? idx.aqiDisplay : idx.aqi,
    category: idx.category || null,
    primary: idx.primaryPollutant ? (typeof idx.primaryPollutant === 'string' ? idx.primaryPollutant : idx.primaryPollutant.name) : null,
    level: idx.level || null,
    color: idx.color || null,
    health: idx.health || null,
    pollutants: (idx.pollutants || []).map((p) => ({
      name: p.name,
      value: p.concentration ? p.concentration.value : null,
      unit: p.concentration ? p.concentration.unit : null,
    })),
  };
}

// 灾害预警
function normalizeWarning(raw) {
  if (!raw) return { source: raw, alerts: [] };
  return {
    source: raw,
    alerts: (raw.alerts || []).map((a) => ({
      event: a.eventType ? a.eventType.name : null,
      severity: a.severity || null,
      color: a.color ? a.color.code : null,
      headline: a.headline || null,
      sender: a.senderName || null,
      effective: a.effectiveTime || null,
      expire: a.expireTime || null,
      description: a.description || null,
      instruction: a.instruction || null,
    })),
  };
}

// 分钟级降水
function normalizeMinutely(raw) {
  if (!raw) return { source: raw, summary: null, points: [] };
  return {
    source: raw,
    summary: raw.summary || null,
    points: (raw.minutely || []).map((p) => ({ time: p.fxTime, type: p.type || null, precip: num(p.precip) })),
  };
}

// 天文（日出日落 / 月升月落月相）
function normalizeAstro(sun, moon) {
  const out = {};
  if (sun) {
    out.sunrise = sun.sunrise || null;
    out.sunset = sun.sunset || null;
  }
  if (moon) {
    out.moonrise = moon.moonrise || null;
    out.moonset = moon.moonset || null;
    const p0 = (moon.moonPhase || [])[0];
    out.moonPhase = p0 ? moonPhaseName(p0.name || null) : null;
    out.moonIllumination = p0 ? num(p0.illumination) : null;
  }
  return out;
}

module.exports = {
  num, pct01, toKm, round1, compassCn, windText,
  moonPhaseName, MOON_PHASE_EMOJI, uvStrength, weatherEmoji, isoDate,
  normalizeNow, normalizeHour, normalizeDay, normalizeAir, normalizeWarning,
  normalizeMinutely, normalizeAstro,
};