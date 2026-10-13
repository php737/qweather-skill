# QWeather 和风天气查询 Skill 🦐

和风天气统一 CLI —— 把散在七八个接口里的天气能力收成一个命令。Node.js 实现，零运行时依赖（只用内置 `fetch` + `jose` 做 JWT 签名）。

> ⚠️ **非官方项目。** 与和风天气 / QWeather 及其运营方无任何关联，仅调用其公开 REST API。
> 使用前请自行阅读[服务条款](https://dev.qweather.com/docs/terms/)。

## ✨ 特性

| | |
|---|---|
| 🌤️ **天气** | 新版经纬度 API `/weather/v1/*`（1km 精度），字段含云量/阵风/降水强度/气压/露点/UV |
| 🫁 **空气质量** | v1 实时 / 24h 逐时 / 3 天 / 监测站 |
| 🌧️ **分钟级降水** | 未来 2 小时逐 5 分钟 |
| ⚠️ **灾害预警** | 实时预警信号 + 防御指南 |
| 🧭 **生活指数** | 中国 16 项（洗车/穿衣/紫外线/感冒…） |
| 🌅 **天文** | 日出日落、月升月落、月相 |
| 📍 **GeoAPI** | 城市搜索（含候选列表）、热门城市、POI |
| 📊 **控制台用量** | 近 24h 请求量统计 |

技术上值得说的几点：

- **一体化并发**：`combined` 一次并发拉全，单个数据源失败不拖累其他（失败的进 `metadata.warnings`）
- **跨版本字段归一**：`--normalize` 把 v1 / v7 的单位差异全部抹平
- **双格式错误识别**：同时识别新版 RFC7807 与旧版 v7 错误体，并检查 HTTP status —— 否则 400/403/429 会被当成成功数据返回
- **429/5xx 指数退避重试** + 请求超时保护
- **GeoAPI 模糊匹配告警**：见下方「城市名模糊匹配」

## 📦 安装

需要 **Node.js >= 18**（用到内置 `fetch`）。

```bash
git clone https://github.com/php737/qweather-skill.git
cd qweather-skill
npm install
```

## 🔑 配置

### 1. 申请凭据

在[和风天气控制台](https://dev.qweather.com/)创建项目，订阅 API，进入 **设置 → API 密钥**，获取：

- **API Host**（如 `xxxxxx.re.qweather.com`）
- **项目 ID**（Project ID）
- **凭据 ID**（Credential ID）
- **Ed25519 私钥**（下载 `.key` 文件妥善保存）

### 2. 配置凭据

**方式 A — 环境变量**（推荐，适合脚本/CI）：

```bash
export QWEATHER_HOST="xxxxxx.re.qweather.com"
export QWEATHER_PROJECT_ID="你的项目ID"
export QWEATHER_CREDENTIAL_ID="你的凭据ID"
export QWEATHER_PRIVATE_KEY_PATH="/path/to/ed25519.key"
```

**方式 B — 配置文件**：

`~/.openclaw/openclaw.json` → `skills.entries.qweather.env`：

```jsonc
{
  "skills": {
    "entries": {
      "qweather": {
        "env": {
          "QWEATHER_HOST": "xxxxxx.re.qweather.com",
          "QWEATHER_PROJECT_ID": "...",
          "QWEATHER_CREDENTIAL_ID": "...",
          "QWEATHER_PRIVATE_KEY_PATH": "/path/to/ed25519.key"
        }
      }
    }
  }
}
```

环境变量优先级高于配置文件。也可以直接传 `QWEATHER_PRIVATE_KEY` 传私钥内容本身（适合容器环境）。

> 🔒 **凭据不会进仓库。** 配置只从环境变量或上述配置文件读取，代码里没有任何硬编码密钥。`scripts/geo_cache.json` 是城市查询缓存（含城市名），已 gitignore。

### 3. 验证

```bash
node scripts/qweather.js weather now --city 长沙 --pretty
```

> 💡 `usage`（控制台用量）需要账号所有者在控制台为该凭据单独开通权限，否则返回空 body 并提示。

## 🚀 快速开始

```bash
QW=scripts/qweather.js

node $QW combined --city 长沙 --pretty              # 天气+空气+分钟降水+逐小时+预警（一条命令全拉）
node $QW weather 7d --city 长沙 --pretty             # 7 天预报
node $QW weather now --city 长沙 --pretty            # 实时天气
node $QW air current --city 长沙 --pretty            # 空气质量
node $QW astro both --city 长沙 --pretty             # 日出日落 / 月相
node $QW indices 1d --city 长沙 --type 2,3,5 --pretty # 洗车/穿衣/紫外线
node $QW geo lookup --city 长沙 --list                # 城市候选（重名时先查这个）
node $QW usage                                       # 近 24h 请求量
```

---

## 📺 输出样例

以下全部是**真实运行输出**（未做美化改动）。

### `combined` —— 一条命令拉全

```bash
node $QW combined --city 长沙 --pretty --hours 3
```

```
📍 长沙 · 湖南省 · 2026-10-13 15:23

🌡️  ☀️ 晴 28.1°C  体感 25.5°C
💨 西北风 4级  阵风 13.4m/s  湿度 53%  能见度 15km  气压 1018.4hPa  露点 17.4°C  云量 3%  UV 2 弱
🫁 AQI 102 · 轻度污染  首要污染物: PM 2.5

🌧️ 未来两小时无降水

🌅 天文:
   日出 06:27   日落 18:01
   月出 08:46   月落 19:22   🌒 蛾眉月 (4%)

🕐 未来 3 小时:
| 时间 | 天气 | 温度 | 风 | 💧降水 | 湿度 |
|------|------|------|----|--------|------|
| 10-13 16:00 | ☀️ 晴 | 27°C | 北风 3级 | 0 | 50% |
| 10-13 17:00 | ☀️ 晴 | 26.4°C | 北风 2级 | 0 | 52% |
| 10-13 18:00 | 🌤️ 少云 | 25.7°C | 北风 2级 | 0 | 53% |

⚠️  生效预警 (1 条):
   · [霾|moderate|yellow] 长沙市气象局发布霾黄色预警信号
     长沙市气象台 | 2026-10-13 08:08 → 2026-10-14 08:08
     指南: 1. 空气质量明显降低，人员需适当防护。
2. 一般人群适量减少户外活动，儿童、老人及易感人群应减少外出。

⏱️ 查询耗时 386ms
```

### `weather 7d` —— 多天预报

```bash
node $QW weather 7d --city 长沙 --pretty
```

```
📍 长沙 · 湖南省
📅 未来 7 天:
| 日期 | 天气 | 气温 | 风 | 💧降水 | 湿度 | ☀️UV | 🌙月相 |
|------|------|------|----|--------|------|----|----|
| 10-13 周二 | 🌤️ 少云→ 少云 | 28.2° / 21.6° | 北风 3级 | 0% | 62% | **6** 强 | 🌒 蛾眉月 |
| 10-14 周三 | 🌦️ 小雨→ 小雨 | 25.6° / 19.6° | 西南风 1级 | 18% | 64% | **4** 中等 | 🌒 蛾眉月 |
| 10-15 周四 | 🌧️ 强雷阵雨→ 强雷阵雨 | 26.3° / 20.5° | 东风 2级 | **100%** | 69% | **3** 中等 | 🌒 蛾眉月 |
| 10-16 周五 | 🌦️ 小雨→ 少云 | 28.7° / 20.4° | 西南风 0级 | **77%** | 77% | **4** 中等 | 🌒 蛾眉月 |
| 10-17 周六 | 🌤️ 少云→ 少云 | 32.1° / 23.6° | 南风 3级 | 37% | 64% | **8** 很强 | 🌒 蛾眉月 |
| 10-18 周日 | 🌥️ 多云→ 晴间多云 | 25.6° / 18.9° | 西北风 3级 | 57% | 77% | **2** 弱 | 🌒 蛾眉月 |
| 10-19 周一 | 🌥️ 多云→ 晴间多云 | 24.1° / 16.6° | 北风 2级 | 3% | 77% | **4** 中等 | 🌓 上弦月 |

🌅 天文:
   日出 06:27   日落 18:01
```

### `air current` —— 空气质量

```bash
node $QW air current --city 长沙 --pretty
```

```
🫁 AQI 102 · 轻度污染  首要污染物: PM 2.5
```

### `astro both` —— 天文

```bash
node $QW astro both --city 长沙 --pretty
```

```
🌅 天文:
   日出 06:27   日落 18:01
   月出 08:46   月落 19:22   🌒 蛾眉月 (4%)
```

### `indices` —— 生活指数

```bash
node $QW indices 1d --city 长沙 --type 2,3,5 --pretty
```

```
🧭 生活指数:
   · 洗车指数 3 较不宜 — 较不宜洗车，明天可能有雨，擦拭一新的汽车可能无法保持太长时间。
   · 穿衣指数 6 热 — 天气热，建议着短裙、短裤、短薄外套、T恤等夏季服装。
   · 紫外线指数 3 中等 — 属中等强度紫外线辐射天气，外出时建议涂擦SPF高于15、PA+的防晒护肤品，戴帽子、太阳镜。
```

### `geo lookup --list` —— 重名城市查候选

```bash
node $QW geo lookup --city 长沙 --list
```

```json
{
  "action": "lookup",
  "candidates": [
    {
      "id": "101250101",
      "name": "长沙",
      "adm1": "湖南省",
      "adm2": "长沙",
      "lat": "28.23",
      "lon": "112.94",
      "fxLink": "https://www.qweather.com/weather/changsha-101250101.html"
    }
  ]
}
```

---

## 🔀 三种输出模式

| 模式 | 说明 |
|------|------|
| 默认 | 原始 JSON 透传（含各接口原字段） |
| `--pretty` | 人类可读（emoji + 表格），所有子命令均支持 |
| `--normalize` | 跨版本统一结构 + 单位换算，给下游程序消费 |

### `--normalize` 样例

```bash
node $QW weather now --city 长沙 --normalize
```

```json
{
  "now": {
    "source": "v1",
    "time": null,
    "text": "晴",
    "code": "100",
    "temp": 28.1,
    "feelsLike": 25.5,
    "humidity": 53,
    "cloud": 3,
    "pressure": 1018.4,
    "visibilityKm": 15,
    "dew": 17.4,
    "uvIndex": 2,
    "windDeg": 316,
    "windDir": "西北风",
    "windScale": 4,
    "windSpeed": 7.7,
    "gust": 13.4,
    "precip": {
      "amount": 0,
      "intensity": 0,
      "type": "none",
      "pop": null
    }
  }
}
```

### ⚠️ 为什么推荐 `--normalize`

直接读原始 JSON 时有个坑：**新版 v1 和旧版 v7 的单位不一样**。

| 字段 | v1（新版） | v7（旧版） |
|---|---|---|
| `humidity` / `cloudCover` | **0-1** | **0-100** |
| `visibility` | **米** | **公里** |

`--normalize` 已全部换算成 **0-100 百分比 / 公里**，`windScale` 也统一成蒲福风级。字段名和单位跨 API 版本稳定，写下游代码时不会因为接口升级而炸。

---

## ⚠️ 城市名模糊匹配

和风 GeoAPI 对**无法识别的名称会静默模糊匹配到毫不相干的城市**。CLI 会在 stderr 打告警，pretty 首行始终显示**实际命中的地点**：

```bash
node $QW weather now --city 不存在的城市xyz --pretty
```

```
📍 安城市 · 爱知县
🌡️  ☀️ 晴 26.3°C  体感 26.8°C
💨 南风 2级  阵风 7.4m/s  湿度 60%  能见度 23.9km  气压 1013.8hPa  露点 17.8°C  云量 3%  UV 0 弱
```

（`不存在的城市xyz` → 日本爱知县的「安城市」）

需要硬失败时加 `--strict-city`：

```
❌ 城市名 "不存在的城市xyz" 未精确匹配，实际命中「安城市」（爱知县）；--strict-city 已启用，确认无误可加 --force。
```

**重名城市**（朝阳、鼓楼等）建议先 `geo lookup --list` 看候选，再用 `--lat/--lon` 精确定位。

---

## 📖 命令参考

| 命令 | 说明 |
|------|------|
| `combined` | **默认推荐**。并发拉全：天气 + 空气 + 分钟降水 + 逐小时 + 预警 |
| `weather now` | 实时天气 |
| `weather hourly` | 逐小时预报（`--hours N`，1-24） |
| `weather daily` / `weather 7d` | 逐日预报（自带 astro，零额外开销） |
| `weather 15d` / `weather 30d` | 长预报（仍走旧版 v7） |
| `astro sun` / `astro moon` / `astro both` | 日出日落 / 月相（`--date` 可查未来 60 天内任意一天） |
| `air current` / `air hourly` / `air daily` / `air station` | 空气质量 |
| `minutely` | 未来 2 小时逐 5 分钟降水 |
| `warning` | 灾害预警 |
| `indices 1d` / `indices 3d` | 生活指数（`--type` 见下） |
| `geo lookup` / `geo top` / `geo poi` | GeoAPI |
| `usage` | 控制台近 24h 请求量 |

### 常用参数

`--city <名称>` / `--lat --lon` · `--type <now|3d|7d|10d|15d|30d>` · `--air-type` · `--hours N` · `--days N` · `--indices <id,id>` · `--no-hourly` · `--no-minutely` · `--no-warning` · `--no-astro` · `--strict-city` · `--force` · `--lang zh|en` · `--local-time true|false` · `--pretty` · `--normalize`

**生活指数 ID**（中国 16 项）：

| ID | 名称 | ID | 名称 | ID | 名称 | ID | 名称 |
|---|------|---|------|---|------|---|------|
| 1 | 运动 | 5 | 紫外线 | 9 | 感冒 | 13 | 化妆 |
| 2 | ⭐洗车 | 6 | 旅游 | 10 | 空气扩散 | 14 | ⭐晾晒 |
| 3 | ⭐穿衣 | 7 | 过敏 | 11 | 空调开启 | 15 | 交通 |
| 4 | 钓鱼 | 8 | 舒适度 | 12 | 太阳镜 | | |

常用组合：`--type 2,3,5`（洗车+穿衣+紫外线）、`--type 3,9,11`（穿什么+别着凉+开不开空调）

---

## 📁 目录结构

```
qweather-skill/
├── scripts/
│   ├── qweather.js        # CLI 入口（子命令分发）
│   ├── geo_cache.json     # 城市缓存（30 天 TTL，gitignored）
│   └── lib/
│       ├── config.js      # 配置读取（进程内缓存 + 环境变量覆盖）
│       ├── jwt.js         # Ed25519 JWT（24h 有效，进程内缓存复用）
│       ├── http.js        # fetch + 超时 + 退避重试 + 双格式错误归一
│       ├── geo.js         # GeoAPI + TTL 缓存 + 模糊匹配判定
│       ├── normalize.js   # 跨版本字段归一（含单位换算）
│       └── format.js      # --pretty 排版
├── .github/workflows/     # CI（npm ci + npm test，Node 18/20/22）
├── package.json
├── SKILL.md               # Agent 侧详细说明
└── README.md
```

## 📅 版本现状

旧版 `/v7/weather/*`（城市预报）官方排 **2027-06-01 停服**，本项目已默认切到新版 `/weather/v1/*`。

仅 `15d` / `30d` 因新版上限 10 天仍走旧版 v7。

已停服接口（历史记录）：

| 接口 | 停服日期 |
|------|----------|
| `/v7/air/now`、`/v7/air/5d` | 2026-06-01 |
| `/v7/solar-radiation/*` | 2026-09-01 |
| `/v7/warning/now` | 2026-10-01 |

## 📄 License

[ISC](LICENSE)

对外版本线从 `1.0.0` 起算。内部曾迭代到 3.x，作为公开仓库的首个 release 重新从 1 开始。
