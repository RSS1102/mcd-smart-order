/**
 * 到店取餐：门店查询、取餐时间设置、自提流程校验
 *
 * 关键约定（来自 mcd-mcp 工具说明 + 实测）：
 *  - beType=1 到店自取：query-nearby-stores 返回的门店没有 beCode，后续所有工具都【不能】传 beCode
 *  - beType=5 得来速  ：必须传 beCode
 *  - orderType=1 时 create-order 的 takeWayCode 必传，取值来自 calculate-price.data.takeWayList[].code
 *  - reservationDate 预约场景必传，格式 yyyy-MM-dd HH:mm，且必须落在门店 reservationTimeOptions 内
 */

import type { ReservationTimeOption, Store, TakeWay } from './types.js';
import { McdError } from './errors.js';

/* ------------------------------------------------------------------ */
/* 时间工具                                                            */
/* ------------------------------------------------------------------ */

export interface TimeRange {
  /** HH:mm */
  start: string;
  end: string;
}

export interface ReservationSlot {
  name: string;
  ranges: TimeRange[];
}

export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return Number.NaN;
  return Number.parseInt(m[1]!, 10) * 60 + Number.parseInt(m[2]!, 10);
}

export function isValidDateTime(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s);
}

/** 解析 "下午茶(14:44至16:45)，夜市(17:14至21:45)" / "宵夜(00:00至04:45,22:14至23:59)" */
export function parseReservationText(text: string): ReservationSlot[] {
  const out: ReservationSlot[] = [];
  for (const chunk of text.split('，')) {
    const m = /^(.+?)\((.+)\)$/.exec(chunk.trim());
    if (!m) continue;
    const name = m[1]!.trim();
    const ranges: TimeRange[] = [];
    for (const seg of m[2]!.split(',')) {
      const r = /(\d{1,2}:\d{2})\s*至\s*(\d{1,2}:\d{2})/.exec(seg);
      if (r) ranges.push({ start: r[1]!, end: r[2]! });
    }
    if (ranges.length) out.push({ name, ranges });
  }
  return out;
}

function inRange(min: number, r: TimeRange): boolean {
  const s = toMinutes(r.start);
  const e = toMinutes(r.end);
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  // 跨零点（如 22:14 至 04:45）
  if (e <= s) return min >= s || min <= e;
  return min >= s && min <= e;
}

/* ------------------------------------------------------------------ */
/* 门店选择                                                            */
/* ------------------------------------------------------------------ */

/** 距离取值：外送门店没有 distance 字段，排序时视为无穷远 */
function distOf(s: Store): number {
  return s.distance ?? Number.MAX_SAFE_INTEGER;
}

export interface StorePickResult {
  store: Store;
  /** 是否需要用户进一步确认（多个候选） */
  ambiguous: Store[];
  reason: string;
}

/** 从门店列表中挑选：优先精确 storeCode，其次名称/地址关键词，最后距离最近 */
export function pickStore(stores: Store[], hint?: { storeCode?: string; keyword?: string }): StorePickResult {
  if (stores.length === 0) {
    throw new McdError('STORE_UNSUPPORTED', '附近没有可点餐的门店，请更换城市/位置关键词后重试。');
  }
  if (hint?.storeCode) {
    const hit = stores.find((s) => s.storeCode === hint.storeCode);
    if (hit) return { store: hit, ambiguous: [], reason: `按门店编号 ${hit.storeCode} 精确匹配` };
    throw new McdError(
      'STORE_UNSUPPORTED',
      `门店编号 ${hint.storeCode} 不在当前可点餐列表中，请从列表里重新选择。`,
    );
  }
  if (hint?.keyword) {
    const kw = hint.keyword.trim();
    const hits = stores.filter((s) => s.storeName.includes(kw) || (s.address ?? '').includes(kw));
    if (hits.length === 1) return { store: hits[0]!, ambiguous: [], reason: `按关键词「${kw}」唯一匹配` };
    if (hits.length > 1) {
      const sorted = [...hits].sort((a, b) => distOf(a) - distOf(b));
      return { store: sorted[0]!, ambiguous: sorted, reason: `关键词「${kw}」命中 ${hits.length} 家，默认取最近的` };
    }
  }
  const sorted = [...stores].sort((a, b) => distOf(a) - distOf(b));
  const first = sorted[0]!;
  const distText = first.distance === undefined ? '' : `（${first.distance} m）`;
  return { store: first, ambiguous: sorted, reason: `未指定门店，默认取最近的${distText}` };
}

/* ------------------------------------------------------------------ */
/* 营业时间校验                                                        */
/* ------------------------------------------------------------------ */

export interface BusinessCheck {
  ok: boolean;
  message: string;
  /** 门店营业时段 */
  window: TimeRange;
  is24h: boolean;
}

export function checkBusinessHours(store: Store, time: string): BusinessCheck {
  const window: TimeRange = { start: store.businessStartTime || '00:00', end: store.businessEndTime || '23:59' };
  const is24h = window.start === '00:00' && (window.end === '23:59' || window.end === '23:59');
  const hhmm = time.includes(' ') ? time.split(' ')[1]! : time;
  const min = toMinutes(hhmm);
  if (Number.isNaN(min)) {
    return { ok: false, message: `取餐时间「${time}」格式不正确，应为 yyyy-MM-dd HH:mm 或 HH:mm。`, window, is24h };
  }
  if (is24h) return { ok: true, message: '该门店 24 小时营业，任意时间可取餐。', window, is24h };
  if (inRange(min, window)) {
    return { ok: true, message: `取餐时间 ${hhmm} 在营业时间 ${window.start}-${window.end} 内。`, window, is24h };
  }
  return {
    ok: false,
    message: `取餐时间 ${hhmm} 不在门店营业时间 ${window.start}-${window.end} 内，请调整取餐时间。`,
    window,
    is24h,
  };
}

/* ------------------------------------------------------------------ */
/* 预约时段校验                                                        */
/* ------------------------------------------------------------------ */

export interface ReservationCheck {
  ok: boolean;
  message: string;
  /** 命中的时段名 */
  slotName?: string;
  /** 该日期全部可用时段 */
  available: ReservationSlot[];
}

export function checkReservationSlot(store: Store, reservationDate: string): ReservationCheck {
  if (!isValidDateTime(reservationDate)) {
    return { ok: false, message: `reservationDate 必须为 yyyy-MM-dd HH:mm 格式，当前为「${reservationDate}」。`, available: [] };
  }
  const [date, hhmm] = reservationDate.split(' ') as [string, string];
  const options: ReservationTimeOption[] = store.reservationTimeOptions ?? [];
  const dayOpt = options.find((o) => o.date === date);
  if (!dayOpt) {
    return {
      ok: false,
      message: `门店未开放 ${date} 的预约，可选日期：${options.map((o) => o.date + (o.today ? '(今天)' : '')).join('、') || '无'}`,
      available: [],
    };
  }
  const slots = parseReservationText(dayOpt.reservationOptionText);
  const min = toMinutes(hhmm);
  for (const s of slots) {
    if (s.ranges.some((r) => inRange(min, r))) {
      return { ok: true, message: `${hhmm} 落在「${s.name}」时段内，可预约。`, slotName: s.name, available: slots };
    }
  }
  return {
    ok: false,
    message: `${hhmm} 不在 ${date} 的可用预约时段内。可选：${dayOpt.reservationOptionText}`,
    available: slots,
  };
}

/* ------------------------------------------------------------------ */
/* 自提流程校验                                                        */
/* ------------------------------------------------------------------ */

export interface PickupPlan {
  storeCode: string;
  storeName: string;
  beType: 1 | 5;
  orderType: 1;
  /** beType=1 时必须为 undefined */
  beCode?: string;
  /** 预约取餐时间，未预约则 undefined */
  reservationDate?: string;
  /** 自提方式（堂食/外带取餐柜），来自 calculate-price.takeWayList */
  takeWay?: TakeWay;
  checks: Array<{ name: string; ok: boolean; message: string }>;
  /** 可直接用于 create-order 的通道参数 */
  channelArgs: Record<string, unknown>;
}

export interface PickupInput {
  store: Store;
  beType: 1 | 5;
  /** 用户期望的取餐时间，yyyy-MM-dd HH:mm；不传 = 立即取餐 */
  reservationDate?: string;
  /** 是否预约 */
  reserve: boolean;
  /** calculate-price 返回的 takeWayList */
  takeWayList?: TakeWay[];
  /** 用户偏好的自提方式关键词，如「堂食」「取餐柜」「外带」 */
  takeWayHint?: string;
  /**
   * 注入「当前时间」（HH:mm 或 yyyy-MM-dd HH:mm），仅用于测试与确定性重放。
   * 不传则取真实当前时间 —— 注意这会让营业时间校验结果随时间变化。
   */
  now?: string;
}

export function planPickup(input: PickupInput): PickupPlan {
  const { store, beType } = input;
  const checks: PickupPlan['checks'] = [];

  // 1) beCode 规则
  if (beType === 5 && !store.beCode) {
    throw new McdError('STORE_UNSUPPORTED', `门店「${store.storeName}」未提供得来速 beCode，请改选到店自取(beType=1)或换一家支持车道取餐的门店。`);
  }
  checks.push({
    name: 'beCode 规则',
    ok: beType === 1 ? true : Boolean(store.beCode),
    message: beType === 1 ? '到店自取(beType=1)：后续调用禁止传 beCode。' : `得来速(beType=5)：后续调用必须传 beCode=${store.beCode}。`,
  });

  // 2) 营业状态
  checks.push({
    name: '门店营业状态',
    ok: store.businessStatus,
    message: store.businessStatus ? '门店营业中。' : '门店当前未营业，请更换门店。',
  });

  // 3) 预约 / 时间
  let reservationDate: string | undefined;
  if (input.reserve) {
    if (!input.reservationDate) {
      throw new McdError('PARAM_MISSING', '预约取餐必须提供取餐时间（yyyy-MM-dd HH:mm）。');
    }
    const r = checkReservationSlot(store, input.reservationDate);
    checks.push({ name: '预约时段', ok: r.ok, message: r.message + (r.slotName ? `（时段：${r.slotName}）` : '') });
    if (!r.ok) throw new McdError('RESERVATION_SLOT_INVALID', r.message);
    reservationDate = input.reservationDate;
  } else {
    const now = input.reservationDate ?? input.now ?? nowHm();
    const b = checkBusinessHours(store, now);
    checks.push({ name: '营业时间', ok: b.ok, message: b.message });
    if (!b.ok) throw new McdError('NOT_IN_BUSINESS_HOURS', b.message);
  }

  // 4) 自提方式
  let takeWay: TakeWay | undefined;
  if (input.takeWayList && input.takeWayList.length > 0) {
    if (input.takeWayHint) {
      const hint = input.takeWayHint!;
      takeWay = input.takeWayList.find((t) => t.title.includes(hint) || t.subtitle.includes(hint) || t.code.includes(hint));
    }
    takeWay ??= input.takeWayList[0];
    checks.push({
      name: '自提方式',
      ok: Boolean(takeWay),
      message: takeWay ? `已选择「${takeWay.title}（${takeWay.subtitle}）」，takeWayCode=${takeWay.code}` : '未提供 takeWayList，下单前需先调用 calculate-price 获取。',
    });
  } else {
    checks.push({ name: '自提方式', ok: false, message: '缺少 takeWayList，请先调用 calculate-price 获取后再下单。' });
  }

  const channelArgs: Record<string, unknown> = {
    storeCode: store.storeCode,
    orderType: 1,
    beType,
  };
  if (beType === 5 && store.beCode) channelArgs['beCode'] = store.beCode;
  if (reservationDate) channelArgs['reservationDate'] = reservationDate;
  if (takeWay) channelArgs['takeWayCode'] = takeWay.code;

  return {
    storeCode: store.storeCode,
    storeName: store.storeName,
    beType,
    orderType: 1,
    beCode: beType === 1 ? undefined : store.beCode,
    reservationDate,
    takeWay,
    checks,
    channelArgs,
  };
}

function nowHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function renderPickupPlan(p: PickupPlan): string {
  const lines = [
    `门店：${p.storeName}（${p.storeCode}）`,
    `就餐方式：${p.beType === 1 ? '到店自取' : '得来速车道取餐'}${p.beCode ? ` · beCode=${p.beCode}` : ''}`,
    p.reservationDate ? `预约取餐：${p.reservationDate}` : '取餐方式：立即取餐',
    p.takeWay ? `自提方式：${p.takeWay.title}（${p.takeWay.subtitle}） · takeWayCode=${p.takeWay.code}` : '自提方式：待算价后确定',
    '',
    '流程校验：',
    ...p.checks.map((c) => `  ${c.ok ? '✅' : '❌'} ${c.name}：${c.message}`),
  ];
  return lines.join('\n');
}
