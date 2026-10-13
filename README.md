# QWeather 和风天气查询 Skill 🦐

和风天气统一 CLI（Node.js，无运行时依赖，仅用内置 `fetch` + `jose` 做 JWT 签名）。

> ⚠️ **非官方项目。** 与和风天气 / QWeather 及其运营方无任何关联。仅调用其公开 REST API。
> 使用前请自行阅读[服务条款](https://dev.qweather.com/docs/terms/)。

## 特性

- **新版经纬度天气 API**（`/weather/v1/*`），字段含云量/阵风/降水强度/气压/露点/UV/日出日落/月相
- **空气质量** v1：实时 / 24h / 3 天 / 监测站
- **天文**：日出日落、月升月落、月相（火烧云判断直接可用）
- **分钟级降水**、**灾害预警**、**生活指数**
- **GeoAPI**：城市搜索（含候选列表）、热门城市、POI
- **控制台用量**：近 24h 请求量统计
- **一体化并发**：`combined` 一次拉全，单源失败不拖累其他
- **错误处理**：同时识别新版 RFC7807 与旧版 v7 错误体，检查 HTTP status，429/5xx 指数退避重试，请求超时保护

## 快速开始

```bash
QW=~/.openclaw/skills/qweather/scripts/qweather.js

node $QW combined --city 长沙 --pretty              # 天气+空气+分钟降水+逐小时+预警
node $QW weather 7d --city 长沙 --pretty             # 7 天预报
node $QW astro both --city 长沙 --pretty             # 日出日落 / 月相
node $QW air current --city 长沙 --pretty            # 空气质量
node $QW indices 1d --city 长沙 --type 2,3,5 --pretty # 洗车/穿衣/紫外线
node $QW geo lookup --city 长沙 --list                # 城市候选
node $QW usage                                       # 请求量
```

## 输出模式

| 模式 | 说明 |
|------|------|
| 默认 | 原始 JSON 透传 |
| `--pretty` | 人类可读（所有子命令均支持） |
| `--normalize` | 跨版本统一结构 + 单位换算，给下游程序消费 |

> ⚠️ 直接读原始 JSON 时注意版本差异：v1 的 `humidity`/`cloudCover` 是 **0-1**、`visibility` 是**米**；v7 是 **0-100** 和**公里**。`--normalize` 已全部换算成 0-100 百分比 / 公里。

## 目录结构

```
qweather/
├── scripts/
│   ├── qweather.js        # CLI 入口
│   ├── geo_cache.json     # 城市缓存（30 天 TTL）
│   └── lib/
│       ├── config.js      # 配置读取（进程内缓存 + 环境变量覆盖）
│       ├── jwt.js         # Ed25519 JWT
│       ├── http.js        # fetch + 超时 + 重试 + 错误归一
│       ├── geo.js         # GeoAPI + 缓存 + 模糊匹配判定
│       ├── normalize.js   # 跨版本字段归一（含单位换算）
│       └── format.js      # --pretty 排版
├── SKILL.md               # 使用说明（详细）
└── README.md
```

## 配置

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

同名环境变量可覆盖。`usage`（控制台用量）需账号所有者在控制台为凭据单独开通权限，否则返回空 body 并提示。

## 版本现状

旧版 `/v7/weather/*`（城市预报）官方排 **2027-06-01** 停服，本 skill 已默认切到新版 `/weather/v1/*`。
仅 `15d`/`30d` 因新版上限 10 天仍走旧版。详见 SKILL.md 弃用清单。

## 城市名模糊匹配注意

和风 GeoAPI 对无法识别的名称会静默匹配到不相干的城市（`不存在的城市xyz` → 安城市/日本）。
CLI 会在 stderr 打 `⚠️` 警告，pretty 首行始终显示实际命中的地点。硬失败用 `--strict-city`。