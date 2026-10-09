/**
 * 异常分类与用户话术
 *
 * 错误码来源：
 *  - open.mcd.cn/mcp/guide.md「错误码」表：401 Token 无效/过期、429 限流(600次/分钟)
 *  - 实测返回：400 = "storeCode门店编码不能为空"
 *  - 实测返回：60006 = "商品已售罄或不可售，换一个商品或检查orderType/beType"
 */

export type McdErrorCode =
  | 'TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'PARAM_MISSING'
  | 'SOLD_OUT'
  | 'STORE_UNSUPPORTED'
  | 'NOT_IN_BUSINESS_HOURS'
  | 'RESERVATION_SLOT_INVALID'
  | 'NO_DELIVERY_STORE'
  | 'NETWORK'
  | 'UNKNOWN';

const CODE_BY_HTTP: Record<number, McdErrorCode> = {
  401: 'TOKEN_INVALID',
  429: 'RATE_LIMITED',
  400: 'PARAM_MISSING',
  60006: 'SOLD_OUT',
};

const ADVICE: Record<McdErrorCode, string> = {
  TOKEN_INVALID: 'MCP Token 无效或已过期，请到 https://open.mcd.cn/mcp 控制台重新激活并替换配置中的 Authorization。',
  RATE_LIMITED: '请求过于频繁（每个 Token 每分钟最多 600 次），请稍后重试。',
  PARAM_MISSING: '必填参数缺失，请检查 storeCode / orderType / beType 是否齐全。',
  SOLD_OUT: '该餐品当前门店已售罄或在该就餐方式下不可售，建议换一个餐品，或确认 orderType/beType 是否正确。',
  STORE_UNSUPPORTED: '该门店不支持当前就餐方式，请换一家门店或改用其它就餐方式。',
  NOT_IN_BUSINESS_HOURS: '所选时间不在门店营业时间内，请调整取餐时间。',
  RESERVATION_SLOT_INVALID: '所选时段不是该门店提供的预约时段，请从门店返回的 reservationTimeOptions 中重新选择。',
  NO_DELIVERY_STORE: '该地址暂无可配送门店，请更换地址或改为到店自取。',
  NETWORK: '网络异常，请稍后重试。',
  UNKNOWN: '调用失败，请稍后重试。',
};

export class McdError<T = unknown> extends Error {
  readonly kind: McdErrorCode;
  readonly httpCode: number;
  readonly traceId?: string;
  readonly payload?: T;

  constructor(kind: McdErrorCode, message?: string, opts: { httpCode?: number; traceId?: string; payload?: T } = {}) {
    super(message ?? ADVICE[kind]);
    this.name = 'McdError';
    this.kind = kind;
    this.httpCode = opts.httpCode ?? 0;
    this.traceId = opts.traceId;
    this.payload = opts.payload;
  }

  /** 面向用户的兜底话术 */
  advice(): string {
    return ADVICE[this.kind];
  }

  /** 给终端用户看的一句话（含 traceId 便于排查） */
  toUserMessage(): string {
    const base = this.message || this.advice();
    return this.traceId ? `${base}（traceId: ${this.traceId}）` : base;
  }

  static fromEnvelope<T>(
    env: { success?: boolean; code?: number; message?: string; traceId?: string; data?: T } | null | undefined,
    fallback = '调用失败',
  ): McdError<T> {
    const httpCode = env?.code ?? 0;
    const kind = CODE_BY_HTTP[httpCode] ?? 'UNKNOWN';
    return new McdError<T>(kind, env?.message || fallback, {
      httpCode,
      traceId: env?.traceId,
      payload: env?.data,
    });
  }
}

/** 判断一个餐品是否「售罄 / 不可售」——不在菜单里即视为不可售 */
export function isSoldOut(err: McdError): boolean {
  return err.kind === 'SOLD_OUT';
}
