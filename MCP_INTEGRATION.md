# MCP 集成说明

## 1. 使用的 MCP Server

| 项目 | 值 |
|:---|:---|
| Server 名称 | `mcd-mcp`（麦当劳中国官方 MCP） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| MCP 版本 | 2025-06-18 及之前 |
| 鉴权 | 请求头 `Authorization: Bearer ${MCD_MCP_TOKEN}` |
| Token 申请 | https://open.mcd.cn/mcp → 登录 → 控制台 → 激活 |
| 限流 | 每个 Token 每分钟 600 次（超限 `429`） |
| 配置示例 | [`mcp-config.example.json`](./mcp-config.example.json)（仅含环境变量占位符，不含真实凭证） |

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": { "Authorization": "Bearer ${MCD_MCP_TOKEN}" }
    }
  }
}
```

---

## 2. 实际调用的 Tool

### 2.1 已集成（四大能力的主干链路）

| Tool | 用途 | 关键入参 | 关键出参 |
|:---|:---|:---|:---|
| `query-nearby-stores` | 查询可点餐门店 | `beType`(1/5)、`searchType`(1/2)、`city`、`keyword` | `storeCode`、`storeName`、`distance`、`businessStatus`、`businessStartTime/EndTime`、`reservation`、`reservationTimeOptions`、`beCode`(DT) |
| `query-meals` | 查询门店在售菜单 | `storeCode`、`orderType`、`beType`、`beCode?`、`reservationDate?` | `data.categories[].name/meals[].code/tags`、`data.meals{code:{name,image,currentPrice,originalPrice,canWithOrder}}`、`data.frequent` |
| `query-meal-detail` | 查询套餐组成与特调 | `storeCode`、`orderType`、`beType`、`code` | `rounds[].id/name/quantity`、`choices[].code/name/isDefault/diffPrice/supportModify/modification.items[].values[]`（`selectedKey`/`unselectedKey`） |
| `calculate-price` | 算价（含优惠） | `storeCode`、`orderType`、`beType`、`items[]`（`productCode`/`quantity`/`roundList`/`modification`/`couponId`） | `price`（**分**）、`discount`、`productList[]`、`takeWayList[].code` |
| `create-order` | 创建订单 | 算价参数 + `takeWayCode`(orderType=1) / `addressId`(orderType=2) | 订单详情 + 支付链接 |
| `list-nutrition-foods` | 餐品营养成分 | 无 | 紧凑表格文本：`[N]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}` |
| `query-store-coupons` | 门店可用券 | `storeCode`、`orderType`、`beType` | 当前门店/订单类型可用券 |
| `delivery-query-addresses` | 外送：查询配送地址 | 无 | `data.addresses[]{addressId, contactName, phone, fullAddress}`，`phone` 服务端已脱敏 |
| `delivery-query-stores` | 外送：按地址查可配送门店 | `beType`(2/6)、`addressId` | `storeCode`、`beCode`、`storeName`、营业时间、`reservationTimeOptions`；**无** `address`/`distance` 字段 |
| `now-time-info` | 服务器当前时间 | 无 | `formatted`、`date`、`timestamp`、`dayOfWeek` |
| `query-order` | 订单状态 | `orderId` | 订单详情、支付/配送状态 |

> `create-order` 会产生真实交易，本项目**未做实际调用**，改为对 `validateOrderInput()`
> 做 22 项参数校验单测（到店缺 `takeWayCode`、外送缺 `addressId`、团餐缺 `gmServiceCode`、
> 特调缺 `key`、`remark` 超长等），在发起请求前拦掉参数错误。

### 2.2 create-order 的输出结构（来自 outputSchema）

`create-order` 与 `query-order` 共用同一套 `data` 结构，字段已通过 `tools/list` 的
`outputSchema` 确认，可直接依赖：

| 字段 | 说明 |
|:---|:---|
| `data.orderId` | 订单 id |
| `data.payId` | 支付 id |
| `data.payH5Url` | **支付 h5 链接** —— 可编码为二维码供扫码支付 |
| `data.orderDetail.orderStatus` | `1` 待支付 / `2` 配餐中-已支付 / `4` 配送中 / `6` 已完成 / `7` 已取消 / `8` 已评价 / `10` 配餐中-餐厅确认中 |
| `data.orderDetail.expirePayTime` | 支付截止时间，超时订单自动取消 |
| `data.orderDetail.pickupCode` | 取餐码 |
| `data.orderDetail.lockerCode` / `lockerQrCode` | 取餐柜密码 / 取餐柜二维码（**非支付码**） |
| `data.orderDetail.realTotalAmount` | 实付金额，**单位「元」** |
| `data.orderDetail.totalDiscountAmount` | 总优惠金额 |
| `data.orderDetail.couponList[].{couponName,discountAmount}` | 实际使用的券与优惠额 |
| `data.orderDetail.deliveryInfo` | 外送配送信息（收件人 / 骑士 / 预计送达） |

> ⚠️ 单位不一致：`calculate-price.price` 是**分**，`orderDetail` 里全是**元**字符串。

### 2.3 工具清单规模

`tools/list` 实际返回 **35 个工具**（本项目代码内记录的是其中 21 个）。除本 Skill 用到的
10 个外，其余按域分组：

| 域 | 工具 |
|:---|:---|
| 订单管理 | `cancel-order`（`orderId` + `cancelReasonCode`）、`order-list` |
| 优惠券 | `query-store-coupons`、`available-coupons`、`auto-bind-coupons`、`query-my-coupons`、`query-survey-coupon` |
| 账户 | `query-my-account` |
| 外送 | `delivery-create-address` |
| 团餐 / 活动 | `query-meal-assistance`、`query-promotions`、`campaign-calendar`、`party-*`（5 个） |
| 积分商城 | `mall-*`（4 个）、`draw-lottery`、`query-lottery-info`、`query-my-prizes` |

**本版本未启用**的部分（优惠券、积分、派对、团餐）：`query-promotions`、
`available-coupons`、`auto-bind-coupons`、`query-my-coupons`、`query-my-account`、
`campaign-calendar`、`mall-*`、`party-*`、`draw-lottery`、`query-lottery-info`、
`query-my-prizes`、`query-survey-coupon`、`delivery-create-address`、`query-meal-assistance`。

### 2.4 真实下单的验证边界

外送（`beType=2/6`）的**查询链路已实跑验证**。`create-order`：

- 参数校验：**22 项单测**覆盖（到店/外送/团餐三种场景 + 特调 key + `roundList` 结构）。
- 下单流程：**17 项单测**覆盖（确认单、价格复核、幂等、dry-run、二维码、支付状态映射）。
- **真实下单未执行** —— 会产生真实订单与扣款。CLI 的 `order` 命令默认 dry-run，
  只有 `--yes --confirm` 双闸同过才发送请求，便于在有真实需求时自测。

---

## 3. 调用流程

### 3.1 单人点餐

```
用户意图 → 确认就餐方式(beType)
  → query-nearby-stores  ──► storeCode (+beCode，仅 DT)
  → query-meals          ──► 菜单 + 价格 + 分类
  → query-meal-detail    ──► rounds/choices/特调（套餐时）
  → calculate-price      ──► price(分) + takeWayList
  → create-order         ──► 支付链接
  → query-order          ──► 支付结果轮询
```

### 3.2 到店取餐

```
query-nearby-stores
  → pickStore()            选店（storeCode / 关键词 / 最近）
  → checkBusinessHours()   营业时间校验（含 24h 店识别）
  → checkReservationSlot() 预约时段校验（解析 reservationOptionText，支持跨零点）
  → calculate-price        取 takeWayList
  → planPickup()           产出 channelArgs（beType=1 时剔除 beCode）
  → create-order
```

### 3.3 预算＋偏好点餐编译器

```
自然语言
  → extractConstraints()   解析预算/热量/过敏原/忌口/口味/槽位/件数
  → query-meals + list-nutrition-foods       （并行，真实数据）
  → compileQuery()         编译为 QueryPlan：channel / priceRange / slots / excludeCodes / mcpCalls
  → applyHardFilters()     过敏原、忌口、素食、价格异常 → 硬排除
  → 组合搜索               ① 套餐作为独立完整解 ② 单品按槽位凑单（预算/热量上界剪枝）
  → checkCombo()           逐条硬约束校验
  → 有解 → Top-K
     无解 → 松弛阶梯（过敏原永不放宽）→ 最接近替代方案 + 放宽说明 + 保留说明
  → calculate-price → create-order
```

### 3.4 能量营养搭配助手

```
目标 kcal + 配比预设
  → list-nutrition-foods ──► parseNutritionTable() （解析紧凑表格）
  → macroGrams()           kcal × 比 ÷ 4（蛋白/碳水）、÷ 9（脂肪）
  → matchNutrition()       菜单名 ↔ 营养表名 归一化模糊匹配（exact / contains / none）
  → planNutrition()        DFS + 热量上下界剪枝，按「配比偏差 → 热量贴近度」排序
  → 输出搭配 + 营养估算 + 高钠/近似匹配提示
  → 用户确认 → query-meals 取 code → calculate-price → create-order
```

---

## 4. 从真实返回中提炼的关键约定

这些约定**不是文档字面转述**，而是通过实际调用 `tools/call` 验证后固化到代码里的：

| # | 约定 | 证据 / 处理 |
|:---:|:---|:---|
| 1 | `query-meals.currentPrice` 是**字符串「元」**（如 `"33.5"`），而 `calculate-price` 的金额是**整数「分」** | `buildMealViews()` 用 `parseFloat`；`renderCombo` 展示时显式 `/100` |
| 2 | `data.categories[]` **没有 code 字段**，只有 `name`（且含换行，如 `"鸡肉汉堡\n/卷"`） | `cleanCategoryName()` 去换行；分类用名称匹配槽位 |
| 3 | 售罄 = **菜单 `data.meals` 中不存在该 code**；`calculate-price` 传错码返回 `code=60006` `商品已售罄或不可售` | 菜单缺失视为不可售；`McdError.kind='SOLD_OUT'` |
| 4 | 到店自取(`beType=1`) 传 `beCode` 会出问题 | `assertChannel()` 主动拦截并抛错 |
| 5 | `orderType=1` 时 `takeWayCode` 必传，来自 `calculate-price.data.takeWayList[].code`（实测为 `eat-in` / `locker-out`） | `planPickup()` 从 `takeWayList` 选取并写入 `channelArgs` |
| 6 | `list-nutrition-foods` 的 `data` **不是 JSON 数组**，是紧凑表格字符串 | `parseNutritionTable()` 按表头列顺序解析 |
| 7 | 营养表单位：kJ / kcal / g / g / g / mg / mg | 类型注释与换算均按此 |
| 8 | 特调 `values[]` 中，**未选中但 `unselectedKey` 非空的项也必须回传** | SKILL.md 明确写出该规则 |
| 9 | 套餐（`rounds`）的 `choices[].diffPrice` 形如 `"+ ¥2"` / `"- ¥1"` | 展示时直接透传，计算以 `calculate-price` 为准 |
| 10 | 缺 `storeCode` 返回 `code=400` `storeCode门店编码不能为空` | `PARAM_MISSING` 分类 |

---

## 5. 业务价值

| 维度 | 说明 |
|:---|:---|
| **降低决策成本** | 把「预算 + 忌口 + 过敏原 + 热量」这类多约束问题，从用户自己在几十个餐品里凑，变成一次对话给出 Top-K 可执行组合 |
| **安全兜底** | 过敏原约束永不参与松弛；无解时明确告知「放宽了什么、保留了什么」，而不是偷偷推荐含过敏原的餐品 |
| **减少下单失败** | `beCode`/`takeWayCode`/`reservationDate` 的易错规则前置校验，把 400/60006 类错误在调用前拦掉 |
| **营养可视化** | 把官方营养表（160 项）与实时菜单打通，输出热量、三大营养素、钠，并给出高钠预警 |
| **可复用** | 编译器是纯函数 + 真实快照测试，可脱离大模型独立回归；同一套约束模型可平滑扩展到外送/团餐 |
