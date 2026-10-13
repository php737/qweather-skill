---
name: qweather
description: "和风天气查询：实时天气、7/15/30天预报、逐小时、空气质量AQI、PM2.5、分钟级降水、灾害预警、生活指数、日出日落与月相。触发词:任意城市名+天气/气温/空气质量（不限于特定城市）。示例：查天气、北京天气、上海空气质量、广州明天气温、PM2.5、下雨、降温、紫外线、日落时间、月相。--city 支持任意中英文地名。"
metadata:
  {
    "openclaw":
      {
        "emoji": "☔",
      },
  }
---

# QWeather Skill 🦐

和风天气统一 CLI。覆盖 GeoAPI / 天气预报 / 空气质量 / 分钟降水 / 灾害预警 / 生活指数 / 天文 / 控制台用量 八大类。

## 配置

`openclaw.json` → `skills.entries.qweather.env`：

| 参数 | 说明 | 必需 |
|------|------|------|
| `QWEATHER_HOST` | 和风天气 API 域名（控制台分配） | ✅ |
| `QWEATHER_PROJECT_ID` | JWT 项目 ID | ✅ |
| `QWEATHER_CREDENTIAL_ID` | JWT 凭据 ID | ✅ |
| `QWEATHER_PRIVATE_KEY_PATH` | Ed25519 私钥文件路径 | ✅ |
| `QWEATHER_PRIVATE_KEY` | 或直接传私钥内容 | 二选一 |

同名环境变量可覆盖配置（便于临时切换）。`usage` 子命令（控制台用量）需要账号所有者在控制台为该凭据单独开通权限。

## 官方文档索引（定期核对用）

**最后核对：2026-10-13**。接口会变，改本 skill 前先按下面流程核对。

**🔴 弃用清单（最该定期看的）**：<https://dev.qweather.com/docs/deprecated/>
本页会列出所有已排停服的接口和日期 —— 见到这里的表格就该回来改代码。

| 分类 | 文档入口 |
|------|----------|
| 总目录 | <https://dev.qweather.com/docs/api/> |
| **GeoAPI** | [city-lookup](https://dev.qweather.com/docs/api/geoapi/city-lookup/) · [top-city](https://dev.qweather.com/docs/api/geoapi/top-city/) · [poi-lookup](https://dev.qweather.com/docs/api/geoapi/poi-lookup/) · poi-range |
| **天气预报** | [经纬度实时](https://dev.qweather.com/docs/api/weather/weather-current/) · [经纬度逐日](https://dev.qweather.com/docs/api/weather/weather-daily-forecast/) · [经纬度逐时](https://dev.qweather.com/docs/api/weather/weather-hourly-forecast/) |
| | 旧版城市接口：now-webapi-v7 / daily-forecast-webapi-v7 / hourly-forecast-webapi-v7 |
| | 参考：天气现象 weather-conditions · 风向风级 wind-guide |
| **空气质量** | [实时](https://dev.qweather.com/docs/api/air-quality/air-current/) · [逐时](https://dev.qweather.com/docs/api/air-quality/air-hourly-forecast/) · [逐日](https://dev.qweather.com/docs/api/air-quality/air-daily-forecast/) · aqi-list · pollutant-list · china-aqi · health-effect-advice |
| **天文** | [日出日落](https://dev.qweather.com/docs/api/astronomy/sunrise-sunset/) · [月升月落月相](https://dev.qweather.com/docs/api/astronomy/moon-and-moon-phase/) · [太阳高度角](https://dev.qweather.com/docs/api/astronomy/solar-elevation-angle/) |
| **分钟降水** | [分钟级降水](https://dev.qweather.com/docs/api/minutely/minutely-precipitation/) |
| **预警** | [实时预警](https://dev.qweather.com/docs/api/warning/weather-alert/) · alert-events · alert-coverage · alert-changes |
| **天气指数** | [指数预报](https://dev.qweather.com/docs/api/indices/indices-forecast/) · [指数类型](https://dev.qweather.com/docs/api/indices/indices-type/) |
| **控制台** | [财务汇总](https://dev.qweather.com/docs/api/console/finance/) · [请求量统计](https://dev.qweather.com/docs/api/console/stats/) |
| **错误码** | [resource/error-code](https://dev.qweather.com/docs/resource/error-code/) |
| **缓存实践** | [best-practices/cache](https://dev.qweather.com/docs/best-practices/cache/) · gzip |
| 未启用（收费） | [台风](https://dev.qweather.com/docs/api/tropical-cyclone/) · [海洋](https://dev.qweather.com/docs/api/ocean/) · [太阳辐射](https://dev.qweather.com/docs/api/solar-radiation/) · 时光机 |

### ⚠️ 抓取方式（按难度递增的四层）

| 层 | 场景 | 工具 |
|----|------|------|
| 1 | 静态 HTML、无 JS | **`web_fetch`**（默认首选，不受拦截） |
| 2 | 需要带 UA 的普通页 / 批量抓取省 context | `curl -A "<浏览器UA>"` 存盘 + grep |
| 3 | SPA / 需 JS 渲染 | `scrapling` 的 `DynamicFetcher.fetch()` |
| 4 | Cloudflare / 高反爬 | `scrapling` 的 `StealthyFetcher.fetch()`（`solve_cloudflare=True`） |

> **dev.qweather.com 属于第 1 层** —— 服务端渲染，readability 能直接抽出正文，不需要 scrapling。
> 但如果哪天文档站改成前端渲染（web_fetch 只拿到空壳），直接跳第 3 层。
> scrapling 选型细节见 `~/.openclaw/skills/scrapling/SKILL.md`（含两套浏览器内核的清理坑）。

**第 1 层用法**：

```jsonc
// web_fetch 是 deferred 工具，不能直接当普通工具调（会报 tool not found），必须走 tool_call
{ "id": "openclaw:core:web_fetch",
  "args": { "url": "https://dev.qweather.com/docs/deprecated/", "extractMode": "text" } }
```

⚠️ 两个坑：
1. `web_fetch` 是 **deferred 工具**，必须走 `tool_call` 包装。
2. 经 `tool_call` 转发时，**数值型参数会被降级成 string**（如 `maxChars: 3000` → schema 校验失败）。
   实测踩过：传 `maxChars` 直接报 `must be integer`。**省略所有数值型可选参数走默认值即可。**

> 教训：工具报错 ≠ 工具不可用。`web_fetch` 一度报 `tool not found`，实为调用姿势错误，
> 当时直接改用 curl 绕开并当成事实写进文档 —— 下次遇到工具报错，先查 `tool_search` 确认调用方式再下结论。

**第 2 层（curl）注意**：`dev.qweather.com` 对**不带 User-Agent 的 curl 直接返 403 Forbidden**
（1415 字节拦截页，不是文档内容），必须带浏览器 UA：

```bash
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
curl -sL -A "$UA" https://dev.qweather.com/docs/deprecated/ -o deprecated.html
```

### 定期核对流程

1. 打开 <https://dev.qweather.com/docs/deprecated/> —— 有没有新条目进表
2. 对一遍上面的分类表 —— 有没有新增分类（本 skill 未启用：poi-range、太阳高度角、时光机）
3. 有变化则更新本页的「最后核对」日期 + 本 skill 的 SKILL.md

## ⚠️ 版本现状（2026-10 重构，重要）

和风正在淘汰旧版 WebAPI v7，官方弃用清单（<https://dev.qweather.com/docs/deprecated/>）当前列出：

| 接口 | 停服日期 |
|------|----------|
| `/v7/air/now`、`/v7/air/5d` | 2026-06-01（已停） |
| `/v7/solar-radiation/*` | 2026-09-01（已停） |
| `/v7/warning/now` | 2026-10-01（已停） |
| `/v7/grid-weather/*` | 2027-06-01 |
| **`/v7/weather/*`（城市预报）** | **2027-06-01** |

**本 skill 的天气查询已默认切到新版经纬度 API** `/weather/v1/{current,daily,hourly}`，字段更全（云量、阵风、降水强度/概率/类型、气压、能见度、露点、UV、日出日落、月相）。仅 `15d`/`30d` 因新版上限 10 天、仍走旧版 v7。

⚠️ 新版上限：`hourly` 最多 240 小时，`daily` 最多 10 天。传超范围值会被 CLI 截断（并由服务端返回 400 时明确报错）。

## 用法

单一入口 `scripts/qweather.js`。

```bash
QW=~/.openclaw/skills/qweather/scripts/qweather.js
```

### ⭐ combined —— 日常默认入口

一次并发拉全：**天气 + 空气质量 + 分钟降水 + 24h 逐小时 + 灾害预警**。

```bash
node $QW combined --city 武汉 --pretty                    # 最常用
node $QW combined --city 武汉 --type 7d --pretty           # 7 天预报
node $QW combined --city 武汉 --indices 2,3,5 --pretty     # 带上洗车/穿衣/紫外线指数
node $QW combined --city 武汉 --no-hourly --no-minutely     # 按需裁掉
node $QW combined --city 武汉 --no-astro                    # 不要日出日落/月亮段
node $QW combined --lat 39.92 --lon 116.41 --pretty        # 直接给坐标
```

**参数**：`--city <名称>` / `--lat --lon`、`--type <now|3d|7d|10d|15d|30d>`、`--air-type <current|hourly|daily>`、`--hours N`（pretty 表格行数 1-24）、`--days N`、`--indices <id,id>`、`--no-minutely`、`--no-warning`、`--no-hourly`、**`--no-astro`**、`--lang zh|en`、`--local-time true|false`、`--pretty`、`--normalize`、`--strict-city`。

**日出日落 / 月相默认带出**，不用加参数：

- 查实时或逐小时 → 自动并发拉 `/v7/astronomy/sun` + `/v7/astronomy/moon`，多 2 个请求
- 查每日预报（`--type 7d` 等）→ 响应本身就带 `astro`，**零额外开销**
- 不想要时 `--no-astro`

单个数据源失败不会拖垮整体：失败的会进 `metadata.warnings`，其余照常输出。

### 天气

```bash
node $QW weather now    --city 武汉 --pretty                # 默认带日出日落/月相
node $QW weather hourly --city 武汉 --hours 24 --pretty
node $QW weather daily  --city 武汉 --days 10 --pretty     # 自带 astro，零额外开销
node $QW weather now    --city 武汉 --no-astro --pretty    # 不要天文段
node $QW weather 7d     --city 武汉 --pretty
node $QW weather 15d    --city 武汉 --pretty     # 旧版 v7
node $QW weather 30d    --city 武汉 --pretty     # 旧版 v7
```

### 天文（日出日落 / 月相）

```bash
node $QW astro both --city 武汉 --pretty
node $QW astro sun  --city 武汉 --date 20261020 --pretty   # 未来 60 天内任意一天
node $QW astro moon --city 武汉 --pretty
```

### 空气质量（需经纬度，`--city` 会自动解析）

```bash
node $QW air current --city 武汉 --pretty
node $QW air hourly  --city 武汉 --local-time true
node $QW air daily   --city 武汉
node $QW air station --station-id P53763
```

### 分钟降水 / 预警 / 生活指数

```bash
node $QW minutely --city 武汉 --pretty       # 未来 2 小时，每 5 分钟
node $QW warning  --city 武汉 --pretty       # 灾害预警（默认本地时区）
node $QW indices 1d --city 武汉 --type 2,3,5 --pretty
node $QW indices 3d --city 武汉 --type 5,9
```

**生活指数 ID 速查**（中国 16 项，海外仅 1/2/5/4）：

| ID | 名称 | ID | 名称 | ID | 名称 |
|----|------|----|------|----|------|
| 1 | 运动 | 6 | 旅游 | 11 | 空调开启 |
| 2 | ⭐洗车 | 7 | 过敏 | 12 | 太阳镜 |
| 3 | ⭐穿衣 | 8 | 舒适度 | 13 | 化妆 |
| 4 | 钓鱼 | 9 | ⭐感冒 | 14 | ⭐晾晒 |
| 5 | ⭐紫外线 | 10 | 空气扩散 | 15 | 交通 |

常用组合：`--type 2,3,5`（洗车+穿衣+紫外线）、`--type 3,9,11`（穿什么+别着凉+开不开空调）、`--type 2,14`（周末家务）。

### GeoAPI / 用量

```bash
node $QW geo lookup --city 武汉县            # 单个
node $QW geo lookup --city 武汉 --list       # 全部候选（查重名用）
node $QW geo lookup --city 武汉 --refresh    # 绕过缓存
node $QW geo top --city 101010100
node $QW usage                              # 近 24h 请求量（需控制台授权）
```

## 输出模式

| 模式 | 说明 |
|------|------|
| 默认 | 原始 JSON 透传（含各接口原字段） |
| `--pretty` | 人类可读（emoji + 表格），所有子命令均支持 |
| `--normalize` | 归一后的统一结构，字段已做单位换算，给下游程序消费 |

`--normalize` 输出的字段**已统一单位**，跨 API 版本稳定：
`humidity`/`cloud` 为 0-100 百分比，`visibilityKm` 为公里，`precip.pop` 为 0-100 百分比，`windScale` 为蒲福风级，温度/气压为摄氏度/hPa。

> 不带 flag 直接读 JSON 时要注意：v1 接口的 `humidity`/`cloudCover` 是 **0-1**、`visibility` 是**米**；v7 是 0-100 和**公里**。用 `--normalize` 可完全避开这个坑。

## 回复用户的输出规范

### 7 天/多天预报

H1 标题（城市 + 未来 N 天），然后 7 列表格：日期 / 天气 / 气温 / 风 / 湿度 / UV / 月相。
后面可跟「⚠️ 重点关注」和「📌 适合做什么」两段。

- 温度写 `xx° / xx°`，**不要**写 `xx-xxx°C`
- UV 数字 + 强度（`9 强`），**加粗**最高那次
- 风：`{方位} {等级}级`，方位用汉字（西北/北/东南），等级用数字范围（`1-3`）
- 月相 emoji：🌑新月 / 🌒蛾眉月 / 🌓上弦月 / 🌔盈凸月 / 🌕满月 / 🌖亏凸月 / 🌗下弦月 / 🌘残月

### 实时天气

H1 标题下用大字突出「天气 + 温度 + 体感」，关键指标放紧凑小表：

| 💨 风 | 💧 湿度 | 🌡️ 气压 | 👁️ 能见度 | ☁️ 云量 | ☀️ UV |
|----|----|----|----|----|----|
| {方位} {等级}级 | {湿度}% | {气压}hPa | {能见度}km | {云量}% | **{UV} {强度}** |

再跟空气质量、分钟降水、预警（无预警则整段省略）、今日速读（2-3 条针对性提醒）。

### 字段要点

- **地点**：用 `adm1`（省级）避免「武汉县 · 武汉」这种重叠；直辖市 `adm1 == name` 时不重复
- **时间**：已按 `localTime` 返回本地时间，**直接展示即可**，不要再做时区换算
- **AQI**：取 `indexes[0]`；`primaryPollutant` 为空时统一写 `—`
- **预警**：`headline` 截断 60 字、`instruction` 截断 90 字；无预警整段省略
- **UV 强度**：1-2 弱 / 3-5 中等 / 6-7 强 / 8-10 很强 / 11+ 极强

## ⚠️ 城市名模糊匹配陷阱

和风 GeoAPI 对**无法识别的名称会静默模糊匹配到毫不相干的城市**：

```
--city 不存在的城市xyz  →  实际命中「安城市」（爱知县，日本）
```

因此：

- 每次输出**必须包含实际命中的地点名**（pretty 首行 `📍 ...`，JSON 在 `location.name`），便于核对
- 模糊命中时 CLI 会在 stderr 打 `⚠️ 城市名 ... 未精确匹配`
- 需要硬失败时加 `--strict-city`
- 重名城市（如「朝阳」「鼓楼」）先 `geo lookup --list` 看候选，再用 `--lat/--lon` 精确指定

## 实现要点

- **单进程单文件入口**：`qweather.js`，子命令分发
- **lib 模块**：
  - `config.js` 读配置（进程内缓存，支持环境变量覆盖）
  - `jwt.js` Ed25519 JWT（24h 有效，进程内缓存复用）
  - `http.js` 原生 fetch + 超时 + 429/5xx 指数退避重试 + **双代错误格式识别**
  - `geo.js` GeoAPI + TTL 缓存（30 天，原子写）+ 模糊匹配判定
  - `normalize.js` 跨版本字段归一（含单位换算、condition code → emoji）
  - `format.js` `--pretty` 排版
- **错误处理**：同时识别新版 RFC7807（`{error:{status,detail,invalidParams}}`）与旧版（`{code,message}`），并检查 HTTP status —— 否则 400/403/429 会被当成成功数据返回
- **城市缓存**：`scripts/geo_cache.json`，30 天 TTL（官方明确禁止无限期缓存 GeoAPI 数据）

## 对应 API

| CLI 子命令 | 接口路径 |
|------------|----------|
| `weather now` | `/weather/v1/current/{lat}/{lon}` |
| `weather hourly/24h` | `/weather/v1/hourly/{lat}/{lon}` |
| `weather daily/7d` | `/weather/v1/daily/{lat}/{lon}` |
| `weather 15d/30d` | `/v7/weather/{15d\|30d}`（旧版，2027-06-01 停服） |
| `air current/hourly/daily` | `/airquality/v1/{type}/{lat}/{lon}` |
| `air station` | `/airquality/v1/station/{id}` |
| `minutely` | `/v7/minutely/5m` |
| `warning` | `/weatheralert/v1/current/{lat}/{lon}` |
| `indices` | `/v7/indices/{1d\|3d}` |
| `astro sun` | `/v7/astronomy/sun` |
| `astro moon` | `/v7/astronomy/moon` |
| `geo lookup` | `/geo/v2/city/lookup` |
| `geo top` | `/geo/v2/city/top` |
| `geo poi` | `/geo/v2/poi/lookup` |
| `usage` | `/metrics/v1/stats` |

未启用（收费）：台风、海洋、太阳辐射、时光机。