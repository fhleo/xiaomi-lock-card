# xiaomi-lock-card

鹿客智能锁只读监控卡片 —— 纯事件驱动、零依赖、深色科技风。

## 特性

- **纯只读**：不发送任何服务调用，全部数据来自传感器/模板日志
- **零依赖**：单文件 Custom Element + Shadow DOM，无需 HACS
- **事件驱动**：无「待机/扫描中」等虚构状态，只对日志推送做一次性反馈
- **日历筛选**：自建月历弹窗，点选起止日期，支持自动交换
- **历史缓存**：History API + TTL + in-flight 去重

## 安装

1. 将 `src/xiaomi-lock-card.js` 复制到 HA 的 `www/card/` 目录
2. 在 Lovelace 中添加资源：`url: /local/card/xiaomi-lock-card.js`，类型 `js`
3. 在仪表盘中添加卡片，类型 `custom:xiaomi-lock-card`

> 路径需与实际部署一致：本项目当前部署在 `www/card/`，对应资源 URL 为 `/local/card/xiaomi-lock-card.js`。
> 若你放在 `www/` 根目录，则 URL 为 `/local/xiaomi-lock-card.js`。

## 配置

```yaml
type: custom:xiaomi-lock-card
log: sensor.lu_ke_suo_ri_zhi               # 必填
title: 鹿客智能锁 V5 Max                    # 可选，默认读 friendly_name
locked: binary_sensor.lu_ke_suo_zhuang_tai
arm: binary_sensor.lu_ke_suo_bu_fang
child: binary_sensor.lu_ke_suo_tong_suo
battery:
  primary: sensor.loock_cn_1062320566_fcl201_battery_level_p_10_1
  secondary: sensor.loock_cn_1062320566_fcl201_battery_level_p_4_1003
  low: 20
records:
  days: 2
  limit: 5
  refresh: 60
  events: all
  include_internal: false
show_records: true
theme: auto                               # dark（默认）| light | auto
tap_action: more-info
```

### 关键配置说明

| 项 | 说明 |
|---|---|
| `records.include_internal` | `false`（默认）= 今日开锁只统计**外部**开锁；`true` = 内外部都计入 |
| `theme` | `dark` 深色科技风（默认）/ `light` 浅色 / `auto` **跟随 Home Assistant 的深浅主题配置**（读 `hass.themes.darkMode`，与操作系统无关，卡片永远和仪表盘一致） |
| `show_records` | `false` 时隐藏下方记录区，卡片只保留头部 + 状态行 + 统计条 |

## 实体说明

| 角色 | entity_id | 说明 |
|---|---|---|
| 日志（核心） | `sensor.lu_ke_suo_ri_zhi` | state = `时间:日志内容` |
| 锁状态 | `binary_sensor.lu_ke_suo_zhuang_tai` | on=已开锁 / off=已上锁 |
| 布防 | `binary_sensor.lu_ke_suo_bu_fang` | on=布防中 |
| 童锁 | `binary_sensor.lu_ke_suo_tong_suo` | on=已开启 |
| 大电池 | `sensor..._battery_level_p_10_1` | 14% |
| 小电池 | `sensor..._battery_level_p_4_1003` | 79% |

## 日志分类规则

- `锁动作` 非空 → 开关锁事件
- `锁动作` 为空 且 `日志内容 != 门铃响了` → 异常事件
- `日志内容 == 门铃响了` → 门铃事件
- `操作位置 == 外部开锁` → 外部开锁（状态行口径）

## 文件结构

```
xiaomi-lock-card/
├── README.md                    # 本文件
├── CHANGELOG.md                 # 版本变更记录
├── DESIGN.md                    # 设计方案 v6
├── .gitignore
├── mockup.html                  # 视觉稿 v6（浏览器打开看动效）
├── preview-editor.html          # 编辑器深/浅色预览
├── preview-themes.html          # 主题预览
├── battery-variants.html        # 电量条状态预览
├── syntax-check.html            # 语法 / 结构自检（浏览器打开）
├── src/
│   └── xiaomi-lock-card.js # 卡片实现（单文件，73 KB）
├── examples/
│   └── lovelace.yaml            # 配置示例
└── tools/
    └── serve.ps1                # 本地静态服务器（跑语法检查用）
```

> **命名说明**：仓库名、卡片类型、资源路径、自定义元素**统一为 `xiaomi-lock-card`**：
> - 卡片类型：`custom:xiaomi-lock-card`
> - 资源 URL：`/local/card/xiaomi-lock-card.js`
> - 自定义元素：`<xiaomi-lock-card>`（编辑器为 `<xiaomi-lock-card-editor>`）
>
> 若从旧名 `fingerprint-lock-card` 升级，需同步修改 Lovelace 资源 URL 与卡片 `type`。
