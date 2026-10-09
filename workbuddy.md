# workbuddy.md —— 使用 WorkBuddy 开发本 Skill 的对话上下文

> 本文件用于核验「WorkBuddy 专项奖励」的联动活动条件，
> 记录本项目的需求来源、开发过程与关键决策。

---

## 一、需求来源

- **活动仓库**：https://github.com/M-China/mcd-developer-innovation-challenge
  - 「开发 Skill」章节要求：README.md、CONTEST_DECLARATION.md（内容不可改动）、
    MCP_INTEGRATION.md、源代码、workbuddy.md（WorkBuddy 专项奖）
  - 「使用 WorkBuddy 开发 Skill」章节：官方合作伙伴，推荐用 WorkBuddy 开发
- **MCP 文档**：https://open.mcd.cn/mcp 与 https://open.mcd.cn/mcp/guide.md
  - 接入地址 `https://mcp.mcd.cn`，Streamable HTTP，`Authorization: Bearer <TOKEN>`
  - MCP Version 仅支持 2025-06-18 及之前；限流 600 次/分钟（429）
  - 错误码：401 Token 无效/过期、429 限流
  - 工具清单 21 个（list-nutrition-foods / query-meals / calculate-price / create-order …）

- **用户原始需求**：基于 mcd-mcp 开发完整可用的 MCD Skill，实现
  1. 单人点餐（选品、规格、数量、下单确认）
  2. 到店取餐（门店查询、取餐时间、自提流程校验）
  3. 预算＋偏好点餐编译器（预算/口味/忌口/过敏原/热量 → 可执行查询条件 → 套餐组合；无解给最接近替代方案并说明原因）
  4. 能量营养搭配助手（目标热量 + 蛋白/碳水/脂肪比 → 搭配建议与营养估算）
  并要求严格遵循接口字段与调用方式，妥善处理售罄、超预算、门店不支持、参数缺失等异常。

---

## 二、开发过程（WorkBuddy 会话摘要）

### 1. 规范与文档获取
- 抓取活动仓库 README，提取「开发 Skill」的必需文件清单与报名要求
- `open.mcd.cn/mcp/doc` 是 SPA 页面，直接抓取无正文 →
  从 JS chunk 中发现隐藏入口 **`/mcp/guide.md`**，成功拿到官方接入指南原文
- 在 WorkBuddy 中已连接 `mcd-mcp` 连接器，通过工具定义拿到 21 个 Tool 的完整 schema

### 2. 真实数据结构探测（关键一步）
为避免使用臆造字段，直接调用真实接口抓取样本并分析结构：

| 探测 | 发现 |
|:---|:---|
| `query-nearby-stores` | 返回 `storeCode / storeName / distance / businessStatus / businessStartTime / reservationTimeOptions / beCode(DT)` |
| `query-meals` | `data.categories[]` **没有 code 只有 name**（且含换行）；`data.meals` 是 code→餐品映射，`currentPrice` 是**字符串「元」**；`data.frequent` 是常点 |
| `query-meal-detail` | `rounds[]`（主食/小食/饮料三轮）→ `choices[]`（`code`/`isDefault`/`diffPrice`/`supportModify`/`modification.items[].values[]` 含 `selectedKey`/`unselectedKey`） |
| `calculate-price` | 金额单位是**分**；`takeWayList` 实测为 `eat-in`(堂食) / `locker-out`(外带·店外取餐柜) |
| `list-nutrition-foods` | `data` **不是 JSON 数组**，是紧凑表格文本 `[160]{...}` + 逐行 CSV，共 160 条 |
| 错误用例 | 缺 `storeCode` → `400`；不存在的 `productCode` → `60006 商品已售罄或不可售`；`beType=1` 传 `beCode` 会被拦截 |

这些发现全部固化进 `src/types.ts` 与 `MCP_INTEGRATION.md` 的「从真实返回中提炼的关键约定」。

### 3. 架构决策

> **决策：把确定性的约束求解从大模型中剥离出来，做成纯函数 + 单元测试。**

理由：
- 预算/过敏原/热量这类**硬约束组合搜索**靠大模型口算既慢又不可靠，且不可回归
- 「编译为可执行的查询条件」本身就要求一个可验证的中间表示（`QueryPlan`）
- 过敏原「永不放宽」这条安全红线，只有写在代码里才能被测试锁死

| 模块 | 职责 | 是否依赖大模型 |
|:---|:---|:---|
| `constraints.ts` | 过敏原/忌口/口味知识库、槽位提取、硬过滤 | 否（纯规则） |
| `compiler.ts` | 查询计划 → 组合搜索 → 松弛阶梯 | 否（纯算法） |
| `nutrition.ts` | 营养表解析、模糊匹配、配比求解 | 否（纯算法） |
| `pickup.ts` | 营业/预约时段校验、自提流程 | 否（纯规则） |
| `SKILL.md` | 对话编排、话术、异常引导 | 是（Agent 侧） |

### 4. 实现与修正记录

| 问题 | 修正 |
|:---|:---|
| `normalizeName` 未从 `constraints` 导出导致运行期 `TypeError` | 改为从 `nutrition.js` 直接导入 |
| 套餐（三件套）被当成主食参与凑单，产出「三件套 + 饮料」 | `MealView.isCombo`：套餐**不进槽位池**，作为独立完整解评估并加分 |
| 目标热量过小时 `planNutrition` 返回空数组 | 候选池因热量过滤为空时回落到全部候选，保证给出最接近方案 |
| 预算极小时剪枝把候选全剪没，导致无替代方案 | 剪枝后若结果为空，**关闭剪枝重跑** |
| `takeWayHint` 只匹配 `title`/`code`，「取餐柜」匹配不到 | 补上 `subtitle` 匹配（实测 subtitle 为「店外取餐柜」） |
| 单元测试用「鸡蛋」过敏原在下午茶菜单命中 0 条 | 改用「海鲜」（命中 8 条）/「牛奶」（21 条） |

### 5. 验证

- `npm run typecheck` 通过（strict + `noUncheckedIndexedAccess`）
- `npm run test`：**57 项全部通过**，基于真实门店与菜单快照（116 个餐品、160 条营养）
- 直连真实 MCP 跑通 CLI 四条命令：
  - `compile` → 搜索 2107 个组合、剪枝 459 次，输出 3 个满足约束的组合
  - `nutrition` → 650 kcal / highProtein，达成率 88~91%
  - `pickup` → 预约 18:00 命中「夜市」时段，`takeWayCode=eat-in`
  - 无解场景 → 正确输出违规项、放宽项与「仍然严格保留：过敏原「牛奶」」

---

## 三、交付物清单

| 文件 | 状态 |
|:---|:---|
| `README.md` | ✅ 必需（文件名不可改动） |
| `CONTEST_DECLARATION.md` | ✅ 必需（原文，未改动） |
| `MCP_INTEGRATION.md` | ✅ 必需（文件名不可改动） |
| `mcp-config.example.json` | ✅ 脱敏配置，仅含 `${MCD_MCP_TOKEN}` |
| `SKILL.md` | ✅ Skill 描述与配置（frontmatter + 工作流） |
| 源代码 `src/` | ✅ 8 个模块，TypeScript strict |
| `tests/` | ✅ 57 项单元测试 |
| `examples/` | ✅ 4 组示例对话（含真实返回） |
| `fixtures/` | ✅ 真实数据快照 |
| `workbuddy.md` | ✅ 本文件（WorkBuddy 专项奖） |

---

## 四、项目信息（报名用）

- **项目名称**：mcd-smart-order —— 麦当劳智能点餐 Skill
- **项目简介**：预算＋偏好点餐编译器 + 营养搭配助手，过敏原永不妥协的麦当劳 MCP Skill
- **技术栈**：TypeScript（strict）、Node.js 22、Vitest、麦当劳中国 MCP（Streamable HTTP）
- **开发工具**：WorkBuddy（连接器 mcd-mcp）

---

*本文件由 WorkBuddy 会话导出，用于活动核验。*
