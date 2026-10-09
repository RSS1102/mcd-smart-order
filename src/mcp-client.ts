/**
 * 麦当劳 MCP 客户端（Streamable HTTP / JSON-RPC 2.0）
 *
 * 约定来自 open.mcd.cn/mcp/guide.md：
 *  - 接入地址 https://mcp.mcd.cn
 *  - 传输协议 Streamable HTTP，请求头 Authorization: Bearer <TOKEN>
 *  - 仅支持 MCP Version <= 2025-06-18
 *  - 限流 600 次/分钟（429）
 *
 * 设计要点：
 *  1. 工具返回体是「文本信封」：content[].text 里既有可读说明，也内嵌一段原始 JSON。
 *     这里统一把内嵌 JSON 解出来，失败再回落到纯文本。
 *  2. 所有业务失败统一抛 McdError，便于上层按 kind 分支处理（售罄/参数缺失/限流…）。
 */

import type {
  ChannelParams,
  CreateOrderInput,
  DeliveryAddress,
  McpEnvelope,
  MealDetail,
  Menu,
  Nutrition,
  OrderItemInput,
  PriceResult,
  Store,
} from './types.js';
import { McdError } from './errors.js';
import { parseNutritionTable } from './nutrition.js';

export interface McdClientOptions {
  /** MCP Server 地址，默认 https://mcp.mcd.cn */
  endpoint?: string;
  /** MCP Token；生产环境请从环境变量 MCD_MCP_TOKEN 注入，切勿硬编码 */
  token?: string;
  /** 请求超时毫秒 */
  timeoutMs?: number;
  /** 注入自定义 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

interface RpcOk {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

export class McdClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private seq = 0;

  constructor(opts: McdClientOptions = {}) {
    this.endpoint = opts.endpoint ?? process.env['MCD_MCP_ENDPOINT'] ?? 'https://mcp.mcd.cn';
    this.token = opts.token ?? process.env['MCD_MCP_TOKEN'] ?? '';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.token) {
      throw new McdError('TOKEN_INVALID', '缺少 MCP Token：请设置环境变量 MCD_MCP_TOKEN 或显式传入 token。');
    }
  }

  /** 通用工具调用 */
  async callRaw<T>(tool: string, args: Json = {}): Promise<T> {
    this.seq += 1;
    const body = { jsonrpc: '2.0', id: this.seq, method: 'tools/call', params: { name: tool, arguments: args } };
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new McdError('NETWORK', `请求 ${tool} 失败：${(e as Error).message}`);
    }

    if (res.status === 401) throw new McdError('TOKEN_INVALID');
    if (res.status === 429) throw new McdError('RATE_LIMITED');
    if (!res.ok) throw new McdError('UNKNOWN', `HTTP ${res.status} 调用 ${tool} 失败`);

    const text = await res.text();
    const rpc = parseSseOrJson<RpcOk>(text);
    if (!rpc) throw new McdError('UNKNOWN', `无法解析 ${tool} 的响应`);
    if (rpc.error) throw new McdError('UNKNOWN', `${tool}: ${rpc.error.message}`);

    const contentText = (rpc.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    const env = extractEnvelope<T>(contentText);
    if (env && env.success === false) {
      throw McdError.fromEnvelope(env as { success?: boolean; code?: number; message?: string; traceId?: string; data?: T });
    }
    if (env && env.data !== undefined) return env.data;
    // 少数工具返回纯文本（如 list-nutrition-foods 的紧凑表格）
    return contentText as unknown as T;
  }

  /* ---------------- 门店 ---------------- */

  /** beType=1 到店自取 / beType=5 得来速 */
  async queryNearbyStores(params: {
    beType: 1 | 5;
    searchType?: 1 | 2;
    city?: string;
    keyword?: string;
  }): Promise<Store[]> {
    const args: Json = { beType: params.beType, searchType: params.searchType ?? 1 };
    if (params.searchType === 2) {
      if (!params.city || !params.keyword) {
        throw new McdError('PARAM_MISSING', 'searchType=2 时 city 与 keyword 必填。');
      }
      args['city'] = params.city;
      args['keyword'] = params.keyword;
    }
    return this.callRaw<Store[]>('query-nearby-stores', args);
  }

  /* ---------------- 外送地址 / 门店 ---------------- */

  /** 外送场景：查询用户已创建的配送地址列表（只读，可安全调用） */
  async deliveryQueryAddresses(): Promise<DeliveryAddress[]> {
    const data = await this.callRaw<{ addresses: DeliveryAddress[] }>('delivery-query-addresses', {});
    return data?.addresses ?? [];
  }

  /**
   * 外送场景：按地址查询可配送门店。
   * beType 只允许 2（麦乐送）/ 6（企业团餐）。
   * 注意：外送门店返回体**没有** address / distance 字段。
   */
  async deliveryQueryStores(params: { beType: 2 | 6; addressId: string }): Promise<Store[]> {
    if (!params.addressId) throw new McdError('PARAM_MISSING', 'delivery-query-stores 的 addressId 必填。');
    if (params.beType !== 2 && params.beType !== 6) {
      throw new McdError('PARAM_MISSING', 'delivery-query-stores 的 beType 只能为 2（麦乐送）或 6（企业团餐）。');
    }
    return this.callRaw<Store[]>('delivery-query-stores', { beType: params.beType, addressId: params.addressId });
  }

  /* ---------------- 菜单 ---------------- */

  async queryMeals(p: ChannelParams): Promise<Menu> {
    assertChannel(p);
    return this.callRaw<Menu>('query-meals', channelArgs(p));
  }

  async queryMealDetail(p: ChannelParams & { code: string }): Promise<MealDetail> {
    assertChannel(p);
    if (!p.code) throw new McdError('PARAM_MISSING', 'query-meal-detail 的 code 必填。');
    return this.callRaw<MealDetail>('query-meal-detail', { ...channelArgs(p), code: p.code });
  }

  /* ---------------- 价格 / 订单 ---------------- */

  async calculatePrice(p: ChannelParams & { items: OrderItemInput[]; needTableware?: boolean }): Promise<PriceResult> {
    assertChannel(p);
    if (!p.items?.length) throw new McdError('PARAM_MISSING', 'calculate-price 的 items 不能为空。');
    for (const it of p.items) {
      if (!it.productCode) throw new McdError('PARAM_MISSING', 'items[].productCode 必填。');
      if (!Number.isInteger(it.quantity) || it.quantity < 1) {
        throw new McdError('PARAM_MISSING', 'items[].quantity 必填且需 >= 1。');
      }
    }
    return this.callRaw<PriceResult>('calculate-price', { ...channelArgs(p), items: p.items });
  }

  /**
   * 创建订单 —— 会产生真实交易，务必先经用户确认。
   * 调用前先跑一遍 validateOrderInput，把参数错误拦在本地，避免产生失败订单。
   */
  async createOrder(input: CreateOrderInput): Promise<unknown> {
    validateOrderInput(input);
    return this.callRaw<unknown>('create-order', input as unknown as Json);
  }

  async queryOrder(orderId: string): Promise<unknown> {
    if (!orderId) throw new McdError('PARAM_MISSING', 'query-order 的 orderId 必填。');
    return this.callRaw<unknown>('query-order', { orderId });
  }

  /* ---------------- 营养 ---------------- */

  /** list-nutrition-foods 返回紧凑文本表格，这里解析成结构化数组 */
  async listNutritionFoods(): Promise<Nutrition[]> {
    const raw = await this.callRaw<string>('list-nutrition-foods', {});
    const table = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return parseNutritionTable(table);
  }

  /* ---------------- 时间 ---------------- */

  async nowTimeInfo(): Promise<{ formatted: string; date: string; timestamp: number }> {
    return this.callRaw('now-time-info', {});
  }
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 到店自取禁止传 beCode；其余场景 beCode 必传 —— 这是最容易踩的坑 */
export function assertChannel(p: ChannelParams): void {
  if (!p.storeCode) throw new McdError('PARAM_MISSING', 'storeCode 门店编码不能为空。');
  const needBe = p.beType !== 1;
  if (needBe && !p.beCode) {
    throw new McdError('PARAM_MISSING', `beType=${p.beType} 场景 beCode 必传（来自 query-nearby-stores / delivery-query-stores）。`);
  }
  if (p.beType === 1 && p.beCode) {
    throw new McdError('PARAM_MISSING', '到店自取(beType=1) 场景不能传 beCode，否则服务端可能报错。');
  }
  if (p.reservationDate && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(p.reservationDate)) {
    throw new McdError('PARAM_MISSING', 'reservationDate 格式必须为 yyyy-MM-dd HH:mm。');
  }
}

/**
 * 下单参数本地校验（纯函数、不联网，因此可完整单测）。
 *
 * `create-order` 会产生真实交易，参数错误的代价远高于其它接口，
 * 所以在发起网络请求之前把能校验的都校验掉。
 */
export function validateOrderInput(input: CreateOrderInput): void {
  assertChannel(input);

  if (!input.items || input.items.length === 0) {
    throw new McdError('PARAM_MISSING', 'create-order 的 items 不能为空。');
  }

  for (const [i, it] of input.items.entries()) {
    if (!it.productCode) throw new McdError('PARAM_MISSING', `items[${i}].productCode 必填。`);
    if (!Number.isInteger(it.quantity) || it.quantity < 1) {
      throw new McdError('PARAM_MISSING', `items[${i}].quantity 必填且需 >= 1。`);
    }
    for (const v of it.modification?.values ?? []) {
      if (!v.code) throw new McdError('PARAM_MISSING', `items[${i}] 特调项缺少 code。`);
      if (!v.key) {
        throw new McdError(
          'PARAM_MISSING',
          `items[${i}] 特调项「${v.code}」缺少 key：选中项用 selectedKey，未选中项若 unselectedKey 非空也必须传。`,
        );
      }
      if (!Number.isInteger(v.quantity) || v.quantity < 0) {
        throw new McdError('PARAM_MISSING', `items[${i}] 特调项「${v.code}」的 quantity 不能为负。`);
      }
    }
    for (const r of it.roundList ?? []) {
      if (!r.round) throw new McdError('PARAM_MISSING', `items[${i}].roundList[].round 必填。`);
      if (!r.comboItemList?.length) {
        throw new McdError('PARAM_MISSING', `items[${i}] round ${r.round} 的 comboItemList 不能为空。`);
      }
      for (const ci of r.comboItemList) {
        if (!ci.code) throw new McdError('PARAM_MISSING', `items[${i}] round ${r.round} 的 comboItemList[].code 必填。`);
      }
    }
  }

  if (input.orderType === 1 && !input.takeWayCode) {
    throw new McdError('PARAM_MISSING', 'orderType=1 时 takeWayCode 必传，取值来自 calculate-price 的 takeWayList[].code。');
  }
  if (input.orderType === 1 && input.addressId) {
    throw new McdError('PARAM_MISSING', 'orderType=1（到店）场景不应传 addressId。');
  }
  if (input.orderType === 2 && !input.addressId) {
    throw new McdError('PARAM_MISSING', 'orderType=2 时 addressId 必传，取值来自 delivery-query-addresses。');
  }
  if (input.orderType === 2 && input.takeWayCode) {
    throw new McdError('PARAM_MISSING', 'orderType=2（外送）场景不应传 takeWayCode。');
  }
  if (input.beType === 6 && !input.gmServiceCode) {
    throw new McdError('PARAM_MISSING', '企业团餐(beType=6) 时 gmServiceCode 必传，取自 query-meal-assistance。');
  }
  if (input.remark && input.remark.length > 50) {
    throw new McdError('PARAM_MISSING', 'remark 最多 50 字。');
  }
}

export function channelArgs(p: ChannelParams): Json {
  const args: Json = { storeCode: p.storeCode, orderType: p.orderType, beType: p.beType };
  if (p.beType !== 1 && p.beCode) args['beCode'] = p.beCode;
  if (p.reservationDate) args['reservationDate'] = p.reservationDate;
  return args;
}

/** SSE 与纯 JSON 两种响应体统一解析 */
function parseSseOrJson<T>(text: string): T | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      /* fallthrough */
    }
  }
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    try {
      return JSON.parse(l.slice(5).trim()) as T;
    } catch {
      /* continue */
    }
  }
  return null;
}

/**
 * 从工具返回的说明文本里抠出原始 JSON 信封。
 * 文本形如：
 *   # API Response Information
 *   ...
 *   ## Original Response
 *
 *   {"success":true,"code":200,...,"data":{...}}
 */
export function extractEnvelope<T>(text: string): McpEnvelope<T> | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as McpEnvelope<T>;
    } catch {
      /* fallthrough */
    }
  }
  const idx = trimmed.indexOf('{"success"');
  if (idx < 0) return null;
  const frag = trimmed.slice(idx);
  // 用 raw_decode 思路：逐段尝试，找到第一个可完整解析的 JSON
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < frag.length; i++) {
    const ch = frag[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(frag.slice(0, i + 1)) as McpEnvelope<T>;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
