/**
 * 下单与支付流程
 *
 * 设计原则：
 *   1. **Agent 到「交出支付链接」为止** —— 钱只能在麦当劳 APP / h5 支付页里付，
 *      Agent 不代付、不保存支付凭证。
 *   2. **下单前必过确认门** —— 重算价格 + 重验库存 + 展示固定格式确认单 +
 *      要求显式确认词。这是唯一花钱的调用，模糊确认等于没确认。
 *   3. **幂等** —— 同一组合只创建一次订单；用户重复说「付完了」只触发查询。
 *   4. **支付结果只信接口** —— 用户口述不作为凭证，必须 query-order 验。
 */

import qrcode from 'qrcode-terminal';
import type { McdClient } from './mcp-client.js';
import { McdError } from './errors.js';
import type { ChannelParams, OrderDetail, OrderItemInput, OrderResult, PriceResult } from './types.js';
import { ORDER_STATUS_LABEL } from './types.js';

/* ------------------------------------------------------------------ */
/* 1. 确认单                                                            */
/* ------------------------------------------------------------------ */

export interface ConfirmLine {
  name: string;
  quantity: number;
  /** 单价，单位「元」 */
  unitPrice: number;
  /** 套餐子项（已选规格）；单品为 undefined */
  subItems?: string[];
}

export interface ConfirmSheet {
  storeName: string;
  storeCode: string;
  /** 如「到店自取 · 堂食」 */
  channelLabel: string;
  /** 预约时间，非预约为 undefined */
  reservationDate?: string;
  lines: ConfirmLine[];
  /** 合计，单位「元」 */
  total: number;
  originalTotal?: number;
  /** 过敏原核查结论（由调用方传入） */
  allergenNote?: string;
  /** 价格来源与时效提示 */
  priceNote?: string;
}

/** 渲染确认单。格式固定，便于用户一眼核对。 */
export function renderConfirmSheet(s: ConfirmSheet): string {
  const out: string[] = [];
  out.push('📋 订单确认');
  out.push(`门店：${s.storeName}（${s.storeCode}）`);
  out.push(`方式：${s.channelLabel}`);
  if (s.reservationDate) out.push(`取餐时间：${s.reservationDate}`);
  out.push('─'.repeat(34));

  for (const l of s.lines) {
    const amount = (l.unitPrice * l.quantity).toFixed(2);
    out.push(`${l.name} ×${l.quantity}   ¥${amount}`);
    for (const sub of l.subItems ?? []) out.push(`  · ${sub}`);
  }

  out.push('─'.repeat(34));
  if (s.originalTotal && s.originalTotal > s.total) {
    out.push(`合计 ¥${s.total.toFixed(2)}（原价 ¥${s.originalTotal.toFixed(2)}）`);
  } else {
    out.push(`合计 ¥${s.total.toFixed(2)}`);
  }
  if (s.priceNote) out.push(`⚠️ ${s.priceNote}`);
  if (s.allergenNote) out.push(`🔴 ${s.allergenNote}`);
  out.push('');
  out.push('回复「确认下单」即创建订单；创建后需在麦当劳 APP 或支付页完成支付。');
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* 2. 确认门：价格与库存复核                                             */
/* ------------------------------------------------------------------ */

export interface PreflightResult {
  /** 是否通过 */
  ok: boolean;
  /** 最新算价（分） */
  priceFen?: number;
  /** 与基准价的差异（元），正数表示涨价 */
  priceDelta?: number;
  /** 售卖状态变化 */
  soldOut?: string[];
  /** 阻断原因 */
  blockers: string[];
  /** 非阻断提示 */
  warnings: string[];
}

/**
 * 下单前复核。
 *
 * 为什么必须做：菜单与算价都是快照。用户从看到方案到说「确认下单」可能隔几分钟，
 * 期间可能涨价、售罄、优惠券失效。直接拿旧参数下单会让用户实际支付金额与预期不符。
 */
export async function preflight(
  client: McdClient,
  channel: ChannelParams,
  items: OrderItemInput[],
  baselineFen: number,
): Promise<PreflightResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // ① 重验库存：菜单里不存在 = 售罄/不可售
  let soldOut: string[] = [];
  try {
    const menu = await client.queryMeals(channel);
    soldOut = items.filter((i) => !menu.meals[i.productCode]).map((i) => i.productCode);
    if (soldOut.length) {
      blockers.push(`以下餐品已售罄或下架：${soldOut.join('、')}`);
    }
  } catch (e) {
    warnings.push(`库存复核失败（${(e as Error).message}），将依赖下单接口返回校验。`);
  }

  // ② 重算价格
  let priceFen: number | undefined;
  let priceDelta: number | undefined;
  try {
    const price = (await client.calculatePrice({ ...channel, items })) as PriceResult;
    priceFen = price.price;
    priceDelta = (priceFen - baselineFen) / 100;
    if (priceDelta !== 0) {
      // 涨价属阻断，降价只提示
      if (priceDelta > 0) blockers.push(`价格已变动：上涨 ¥${priceDelta.toFixed(2)}，请重新确认。`);
      else warnings.push(`价格已变动：下降 ¥${Math.abs(priceDelta).toFixed(2)}，按新价结算。`);
    }
  } catch (e) {
    blockers.push(`重新算价失败：${(e as Error).message}`);
  }

  return {
    ok: blockers.length === 0,
    priceFen,
    priceDelta,
    soldOut,
    blockers,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 3. 幂等下单                                                          */
/* ------------------------------------------------------------------ */

/** 同一对话内已创建的订单，按「门店+组合指纹」去重 */
const createdOrders = new Map<string, OrderResult>();

/** 生成组合指纹，用于幂等判断 */
export function orderFingerprint(storeCode: string, items: OrderItemInput[]): string {
  const parts = items
    .map((i) => {
      const mods = (i.modification?.values ?? [])
        .map((v) => `${v.code}:${v.key}:${v.quantity}`)
        .sort()
        .join(',');
      const rounds = (i.roundList ?? [])
        .map((r) => `${r.round}[${(r.comboItemList ?? []).map((c) => `${c.code}x${c.quantity}`).sort().join('+')}]`)
        .sort()
        .join(',');
      return `${i.productCode}x${i.quantity}|${mods}|${rounds}`;
    })
    .sort();
  return `${storeCode}#${parts.join(';')}`;
}

export interface CreateOrderOptions {
  /** 只构造并打印参数，不真正下单。默认 true —— 安全优先 */
  dryRun?: boolean;
  /** 显式确认词校验结果，由调用方传入 */
  confirmed?: boolean;
}

export interface CreateOrderOutcome {
  /** 是否真的发出请求 */
  sent: boolean;
  /** dryRun 时回显的请求体 */
  requestPreview?: unknown;
  /** 下单成功返回 */
  result?: OrderResult;
  /** 幂等复用 */
  reused?: boolean;
}

/**
 * 创建订单（带幂等与 dry-run）。
 *
 * 默认 `dryRun=true`：不发送请求，只回显参数。要真下单必须显式传 `dryRun:false`
 * 且 `confirmed:true`，两道闸都过才发送。
 */
export async function createOrderGuarded(
  client: McdClient,
  storeCode: string,
  input: Parameters<McdClient['createOrder']>[0],
  opts: CreateOrderOptions = {},
): Promise<CreateOrderOutcome> {
  const dryRun = opts.dryRun ?? true;
  const fp = orderFingerprint(storeCode, input.items);

  // 幂等：同一组合已创建过 → 直接复用，绝不重复下单
  const existing = createdOrders.get(fp);
  if (existing) {
    return { sent: false, result: existing, reused: true };
  }

  if (dryRun) {
    return { sent: false, requestPreview: input };
  }

  if (!opts.confirmed) {
    throw new McdError(
      'PARAM_MISSING',
      '下单需要用户显式确认（回复「确认下单」）。「好」「嗯」「行」不属于确认。',
    );
  }

  const result = (await client.createOrder(input)) as OrderResult;
  createdOrders.set(fp, result);
  return { sent: true, result };
}

/** 仅供测试：清空幂等缓存 */
export function __resetOrderCache(): void {
  createdOrders.clear();
}

/* ------------------------------------------------------------------ */
/* 4. 支付链接与二维码                                                   */
/* ------------------------------------------------------------------ */

/**
 * 渲染终端二维码（可被手机相机直接扫描）。
 *
 * 固定用 `small: true` —— 纯块字符、无 ANSI 反色。
 * 默认模式下 qrcode-terminal 会输出 `\x1b[47m` 之类反色码，
 * 一旦输出被重定向到文件/日志或不被终端解析，就会显示成 `[0m` 乱码。
 */
export function renderQrToTerminal(url: string): string {
  let out = '';
  qrcode.generate(url, { small: true }, (qr: string) => {
    out = qr;
  });
  // 兜底清理：万一库版本变更带出 ANSI，也不要污染输出
  return out.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface PayInfo {
  orderId: string;
  payH5Url?: string;
  expirePayTime?: string;
  /** 实付金额，单位「元」 */
  amount?: string;
}

/** 从 create-order 返回中提取支付信息 */
export function extractPayInfo(result: OrderResult): PayInfo {
  return {
    orderId: result.orderId,
    payH5Url: result.payH5Url,
    expirePayTime: result.orderDetail?.expirePayTime,
    amount: result.orderDetail?.realTotalAmount ?? result.orderDetail?.totalAmount,
  };
}

/** 渲染支付指引（含二维码） */
export function renderPayGuide(p: PayInfo, opts: { qr?: boolean } = {}): string {
  const out: string[] = [];
  out.push('💳 订单已创建，请完成支付');
  out.push(`订单号：${p.orderId}`);
  if (p.amount) out.push(`应付金额：¥${p.amount}`);
  if (p.expirePayTime) out.push(`支付截止：${p.expirePayTime}（超时订单会自动取消）`);
  out.push('');

  if (!p.payH5Url) {
    out.push('⚠️ 本次返回未包含支付链接，请打开麦当劳 APP 在「订单」中完成支付。');
    return out.join('\n');
  }

  if (opts.qr) {
    out.push('请用手机扫描下方二维码，或直接打开链接：');
    out.push('');
    out.push(renderQrToTerminal(p.payH5Url));
    out.push('');
  } else {
    out.push('请在手机打开以下链接完成支付：');
  }
  out.push(p.payH5Url);
  out.push('');
  out.push('支付完成后回复「支付完成」，我会帮你核实订单状态。');
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* 5. 支付结果查询                                                       */
/* ------------------------------------------------------------------ */

/**
 * 归一化订单状态。
 *
 * ⚠️ `outputSchema` 声明 `orderStatus` 是 `"1" | "2" | ...` 数字字符串，
 * 但**真实返回是中文标签**（实测 `"待支付"`）。
 * 两种都要兼容，否则 `pending` 会被判成 false，用户说「付完了」时
 * Agent 会误以为订单处于未知状态。
 */
function normalizeStatus(raw: string): 'pending' | 'paid' | 'cancelled' | 'unknown' {
  const s = (raw ?? '').trim();
  if (s === '1' || s.includes('待支付') || s.includes('未支付')) return 'pending';
  if (s === '7' || s.includes('取消')) return 'cancelled';
  if (['2', '4', '6', '8', '10'].includes(s)) return 'paid';
  if (s.includes('配餐') || s.includes('制作') || s.includes('配送') || s.includes('完成') || s.includes('已支付')) {
    return 'paid';
  }
  return 'unknown';
}

export interface PayCheckResult {
  orderId: string;
  status: string;
  statusLabel: string;
  paid: boolean;
  cancelled: boolean;
  pending: boolean;
  /** 取餐码（已支付时给出） */
  pickupCode?: string;
  lockerCode?: string;
  message: string;
}

/**
 * 核实支付结果。
 *
 * **只信接口，不信口述** —— 用户说「支付完成」但实际没付，或付了没说，两种情况都会发生。
 * 注意：不要在代码里做自动 for 循环轮询，会打爆限流（600 次/分钟）。
 * 每次只查一次，由对话推进决定是否再查。
 */
export async function checkPayment(client: McdClient, orderId: string): Promise<PayCheckResult> {
  const raw = (await client.queryOrder(orderId)) as OrderResult;

  // ⚠️ 两个接口的返回结构不同：
  //   create-order → data.orderDetail.{orderStatus, pickupCode, ...}
  //   query-order  → data.{orderStatus, pickupCode, ...}（**没有 orderDetail 包裹**）
  // 实测 query-order 传 orderDetail 会拿到空，status 变「未知」。
  const detail: OrderDetail = (raw.orderDetail ?? (raw as unknown as OrderDetail)) ?? ({} as OrderDetail);

  // ⚠️ 以 `orderStatus`（中文标签）为准。同一响应里的 `status: "10"` 语义与
  // outputSchema 的「10=配餐中」矛盾（实际订单是待支付），数字字段不可靠。
  const status = detail.orderStatus ?? '';
  const kind = normalizeStatus(status);
  const paid = kind === 'paid';
  const cancelled = kind === 'cancelled';
  const pending = kind === 'pending';

  let message: string;
  if (paid) {
    message =
      `✅ 支付成功，订单已进入配餐流程。\n` +
      (detail?.pickupCode ? `取餐码：${detail.pickupCode}\n` : '') +
      (detail?.lockerCode ? `取餐柜密码：${detail.lockerCode}\n` : '') +
      (detail?.storeName ? `门店：${detail.storeName}\n` : '') +
      (detail?.storeAddress ? `地址：${detail.storeAddress}` : '');
  } else if (cancelled) {
    message = '⚠️ 该订单已取消（可能因超时未支付）。如需用餐请重新下单。';
  } else if (pending) {
    message = '⏳ 订单仍为「待支付」。请在支付页完成付款后再回复「支付完成」，我暂时不会重复创建订单。';
  } else {
    message = `订单状态：「${status || '未知'}」，请稍后再查或到 APP 内查看。`;
  }

  return {
    orderId,
    status,
    statusLabel: ORDER_STATUS_LABEL[status] ?? status,
    paid,
    cancelled,
    pending,
    pickupCode: detail?.pickupCode,
    lockerCode: detail?.lockerCode,
    message,
  };
}
