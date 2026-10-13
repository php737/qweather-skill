'use strict';
// 人类可读输出（--pretty）
//
// 2026-10-13 重构要点：
// 1) 只消费 normalize.js 产出的归一实体，不关心底层是 v1 还是 v7。
// 2) 时间一律按字符串切片展示，不用 new Date() 再转本地时区——
//    API 已按 localTime 返回带偏移量的时间，再过一次本地时区会二次偏移。
// 3) 天气 emoji 走 condition code，--lang en 也能出对表情。

const { weatherEmoji, MOON_PHASE_EMOJI, uvStrength } = require('./normalize');

const DASH = '—';

// ---------- 时间工具（字符串切片，避免二次时区转换） ----------

// '2026-10-13T10:00+08:00' → '10-13 10:00'
function fmtDateTime(iso, { withYear = false } = {}) {
  if (!iso) return '?';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return String(iso);
  const [, y, mo, d, h, mi] = m;
  return withYear ? `${y}-${mo}-${d} ${h}:${mi}` : `${mo}-${d} ${h}:${mi}`;
}

// 只取时刻 '10:00'
function fmtTime(iso) {
  if (!iso) return '?';
  const m = String(iso).match(/[T ](\d{2}:\d{2})/);
  return m ? m[1] : '?';
}

// 真正的「当前本地时间」——和 API 返回的时间不同，这里要按运行机器的时区渲染
// （generated_at 是 UTC ISO 字符串，直接切片会显示 UTC 而非本地时间）
function fmtLocalDateTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function weekdayOf(iso) {
  if (!iso) return null;
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? null : WEEKDAYS[d.getDay()];
}

function n2(v, suffix = '') {
  if (v === null || v === undefined || v === '' || Number.isNaN(v)) return DASH;
  return `${v}${suffix}`;
}

// ---------- 各区块 ----------

function formatNow(now) {
  if (!now) return '';
  const lines = [];
  const emoji = weatherEmoji(now.code, now.text);
  lines.push(`🌡️  ${emoji} ${now.text || DASH} ${n2(now.temp, '°C')}  体感 ${n2(now.feelsLike, '°C')}`);

  const bits = [];
  if (now.windDir) bits.push(`${now.windDir} ${n2(now.windScale, '级')}`);
  else if (now.windScale !== null) bits.push(`${n2(now.windScale, '级')}`);
  if (now.gust !== null) bits.push(`阵风 ${now.gust}m/s`);
  if (now.humidity !== null) bits.push(`湿度 ${now.humidity}%`);
  if (now.visibilityKm !== null) bits.push(`能见度 ${now.visibilityKm}km`);
  if (now.pressure !== null) bits.push(`气压 ${now.pressure}hPa`);
  if (now.dew !== null) bits.push(`露点 ${now.dew}°C`);
  if (now.cloud !== null) bits.push(`云量 ${now.cloud}%`);
  if (now.uvIndex !== null) bits.push(`UV ${now.uvIndex} ${uvStrength(now.uvIndex) || ''}`.trim());
  if (bits.length) lines.push(`💨 ${bits.join('  ')}`);

  if (now.precip && now.precip.amount) {
    lines.push(`🌧️ 降水量 ${now.precip.amount}mm${now.precip.intensity ? `（强度 ${now.precip.intensity}mm/h）` : ''}`);
  }
  return lines.filter(Boolean).join('\n');
}

function formatAir(air) {
  if (!air || air.aqi === null || air.aqi === undefined) return '';
  const primary = air.primary || DASH;
  let s = `🫁 AQI ${air.aqi} · ${air.category || DASH}  首要污染物: ${primary}`;
  if (air.advice) s += `\n   💊 ${air.advice}`;
  return s;
}

function formatMinutely(m) {
  if (!m) return '';
  const lines = [`🌧️ ${m.summary || DASH}`];
  const wet = (m.points || []).filter((p) => p.precip > 0);
  if (wet.length) {
    for (const p of wet.slice(0, 5)) {
      lines.push(`   · ${fmtDateTime(p.time)}  ${p.type || 'rain'}  ${p.precip}mm`);
    }
  }
  return lines.join('\n');
}

function formatWarning(w) {
  if (!w) return '';
  const alerts = w.alerts || [];
  if (!alerts.length) return '✅ 当前无生效预警';
  const lines = [`⚠️  生效预警 (${alerts.length} 条):`];
  for (const a of alerts) {
    const tag = [a.event || '?', a.severity || '?', a.color || ''].filter(Boolean).join('|');
    const head = a.headline ? a.headline.slice(0, 60) : '';
    lines.push(`   · [${tag}] ${head}`);
    lines.push(`     ${a.sender || '?'} | ${fmtDateTime(a.effective, { withYear: true })} → ${fmtDateTime(a.expire, { withYear: true })}`);
    if (a.instruction) {
      const ins = a.instruction.slice(0, 90);
      lines.push(`     指南: ${ins}${a.instruction.length > 90 ? '...' : ''}`);
    }
  }
  return lines.join('\n');
}

// 逐小时表格
function formatHourly(hourly, hours) {
  if (!Array.isArray(hourly) || !hourly.length) return '';
  const n = Math.max(1, Math.min(24, hours || 6));
  const rows = hourly.slice(0, n);
  const lines = [`🕐 未来 ${n} 小时:`, '| 时间 | 天气 | 温度 | 风 | 💧降水 | 湿度 |', '|------|------|------|----|--------|------|'];
  for (const h of rows) {
    const time = fmtDateTime(h.time);
    const text = `${weatherEmoji(h.code, h.text)} ${h.text || DASH}`;
    const wind = h.windDir ? `${h.windDir} ${n2(h.windScale, '级')}` : n2(h.windScale, '级');
    let popCell = DASH;
    if (h.precip && h.precip.pop !== null && h.precip.pop !== undefined) {
      const shown = h.precip.pop >= 10 ? `${h.precip.pop}%` : '0';
      popCell = h.precip.pop >= 60 ? `**${shown}**` : shown;
    }
    lines.push(`| ${time} | ${text} | ${n2(h.temp, '°C')} | ${wind} | ${popCell} | ${n2(h.humidity, '%')} |`);
  }
  return lines.join('\n');
}

// 逐日表格
function formatDaily(daily, days) {
  if (!Array.isArray(daily) || !daily.length) return '';
  const rows = days ? daily.slice(0, Math.max(1, days)) : daily;
  const lines = [`📅 未来 ${rows.length} 天:`, '| 日期 | 天气 | 气温 | 风 | 💧降水 | 湿度 | ☀️UV | 🌙月相 |', '|------|------|------|----|--------|------|----|----|'];
  for (const d of rows) {
    const wd = weekdayOf(d.date) || '';
    const day = `${weatherEmoji(d.codeDay, d.textDay)} ${d.textDay || DASH}`;
    const night = d.textNight ? `→ ${d.textNight}` : '';
    const wind = d.windDir ? `${d.windDir} ${n2(d.windScale, '级')}` : n2(d.windScale, '级');
    const popCell = d.pop === null || d.pop === undefined ? DASH : d.pop >= 60 ? `**${d.pop}%**` : `${d.pop}%`;
    const uv = d.uvIndex === null || d.uvIndex === undefined ? DASH : `**${d.uvIndex}** ${uvStrength(d.uvIndex) || ''}`.trim();
    const moon = d.moonPhase ? `${MOON_PHASE_EMOJI[d.moonPhase] || ''} ${d.moonPhase}`.trim() : DASH;
    lines.push(`| ${d.date ? d.date.slice(5) : '?'} ${wd} | ${day}${night} | ${n2(d.tempMax, '°')} / ${n2(d.tempMin, '°')} | ${wind} | ${popCell} | ${n2(d.humidity, '%')} | ${uv} | ${moon} |`);
  }
  return lines.join('\n');
}

// 天文（日出日落 / 月相）—— 火烧云预测直接吃这段
function formatAstro(astro) {
  if (!astro || !Object.keys(astro).length) return '';
  const lines = ['🌅 天文:'];
  const t = [];
  if (astro.sunrise) t.push(`日出 ${fmtTime(astro.sunrise)}`);
  if (astro.sunset) t.push(`日落 ${fmtTime(astro.sunset)}`);
  if (t.length) lines.push(`   ${t.join('   ')}`);
  const m = [];
  if (astro.moonrise) m.push(`月出 ${fmtTime(astro.moonrise)}`);
  if (astro.moonset) m.push(`月落 ${fmtTime(astro.moonset)}`);
  if (astro.moonPhase) m.push(`${MOON_PHASE_EMOJI[astro.moonPhase] || ''} ${astro.moonPhase}${astro.moonIllumination != null ? ` (${astro.moonIllumination}%)` : ''}`);
  if (m.length) lines.push(`   ${m.join('   ')}`);
  return lines.length > 1 ? lines.join('\n') : '';
}

// 生活指数
function formatIndices(raw) {
  if (!raw || !raw.daily || !raw.daily.length) return '';
  const lines = ['🧭 生活指数:'];
  for (const d of raw.daily) {
    lines.push(`   · ${d.name || '?'} ${n2(d.level)} ${d.category || ''} ${d.text ? '— ' + String(d.text).replace(/\s+/g, ' ').slice(0, 60) : ''}`.trimEnd());
  }
  return lines.join('\n');
}

// ---------- 组合输出 ----------

function formatCombined(d) {
  const md = d.metadata || {};
  const n = d.n || {};
  const loc = md.location || {};

  // adm1（省级）比 adm2（地级）更不容易和城市名重叠
  const adm = loc.adm1 && loc.adm1 !== loc.name ? ` · ${loc.adm1}` : '';
  const place = `${loc.name || md.city || '?'}${adm}`;
  // API 给了观测时间就用它；否则用本机当前时间（而非 UTC 的 generated_at）
  const obsTime = (n.now && n.now.time) || fmtLocalDateTime();

  const lines = [`📍 ${place} · ${obsTime}`, ''];

  if (n.now) lines.push(formatNow(n.now));
  if (n.air) {
    const a = formatAir(n.air);
    if (a) lines.push(a);
  }
  if (n.minutely) {
    lines.push('');
    lines.push(formatMinutely(n.minutely));
  }
  if (n.astro) {
    const a = formatAstro(n.astro);
    if (a) {
      lines.push('');
      lines.push(a);
    }
  }
  if (n.hourly) {
    lines.push('');
    lines.push(formatHourly(n.hourly, md.hourly_hours));
  }
  if (n.warning) {
    lines.push('');
    lines.push(formatWarning(n.warning));
  }

  lines.push('');
  lines.push(`⏱️ 查询耗时 ${md.elapsed_ms}ms`);
  return lines.filter((x) => x !== undefined).join('\n');
}

module.exports = {
  formatCombined, formatNow, formatAir, formatMinutely, formatWarning,
  formatHourly, formatDaily, formatAstro, formatIndices,
  fmtDateTime, fmtTime, fmtLocalDateTime, weekdayOf,
};