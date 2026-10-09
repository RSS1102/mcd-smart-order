import { describe, expect, it } from 'vitest';
import {
  checkBusinessHours,
  checkReservationSlot,
  parseReservationText,
  pickStore,
  planPickup,
  renderPickupPlan,
  toMinutes,
} from '../src/pickup.js';
import { assertChannel, channelArgs, extractEnvelope } from '../src/mcp-client.js';
import { McdError } from '../src/errors.js';
import { sampleStores } from './helpers.js';

describe('时间解析', () => {
  it('HH:mm 转分钟', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('07:30')).toBe(450);
    expect(toMinutes('23:59')).toBe(1439);
  });

  it('解析单日多时段预约文案', () => {
    const slots = parseReservationText('下午茶(14:44至16:45)，夜市(17:14至21:45)，宵夜(22:14至22:46)');
    expect(slots.map((s) => s.name)).toEqual(['下午茶', '夜市', '宵夜']);
    expect(slots[0]!.ranges[0]).toEqual({ start: '14:44', end: '16:45' });
  });

  it('解析跨零点时段', () => {
    const slots = parseReservationText('宵夜(00:00至04:45,22:14至23:59)，早餐(05:14至10:15)');
    expect(slots[0]!.ranges).toHaveLength(2);
    expect(slots[0]!.ranges[0]).toEqual({ start: '00:00', end: '04:45' });
  });
});

describe('门店选择', () => {
  it('按 storeCode 精确匹配', () => {
    const r = pickStore(sampleStores(), { storeCode: '1421057' });
    expect(r.store.storeName).toContain('松坪山');
    expect(r.ambiguous).toHaveLength(0);
  });

  it('按关键词匹配', () => {
    const r = pickStore(sampleStores(), { keyword: '同方信息港' });
    expect(r.store.storeCode).toBe('1420762');
  });

  it('未指定时取最近门店', () => {
    const r = pickStore(sampleStores());
    expect(r.store.distance).toBe(403);
  });

  it('storeCode 不存在时抛门店不支持', () => {
    expect(() => pickStore(sampleStores(), { storeCode: '999999' })).toThrow(McdError);
    try {
      pickStore(sampleStores(), { storeCode: '999999' });
    } catch (e) {
      expect((e as McdError).kind).toBe('STORE_UNSUPPORTED');
    }
  });

  it('门店列表为空时给出明确错误', () => {
    expect(() => pickStore([])).toThrow(/没有可点餐的门店/);
  });
});

describe('营业时间校验', () => {
  it('24 小时门店任意时间通过', () => {
    const s = sampleStores()[1]!;
    const r = checkBusinessHours(s, '03:30');
    expect(r.ok).toBe(true);
    expect(r.is24h).toBe(true);
  });

  it('非营业时间被拦截', () => {
    const s = sampleStores()[0]!; // 07:00-23:00
    expect(checkBusinessHours(s, '06:00').ok).toBe(false);
    expect(checkBusinessHours(s, '2026-10-09 12:00').ok).toBe(true);
  });

  it('时间格式错误被拦截', () => {
    const s = sampleStores()[0]!;
    expect(checkBusinessHours(s, '中午').ok).toBe(false);
  });
});

describe('预约时段校验', () => {
  const s = sampleStores()[0]!;

  it('落在夜市时段内通过', () => {
    const r = checkReservationSlot(s, '2026-10-09 18:00');
    expect(r.ok).toBe(true);
    expect(r.slotName).toBe('夜市');
  });

  it('不在任何时段内被拦截并给出可选时段', () => {
    const r = checkReservationSlot(s, '2026-10-09 12:00');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('下午茶(14:44至16:45)');
  });

  it('日期未开放预约被拦截', () => {
    const r = checkReservationSlot(s, '2026-12-31 18:00');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未开放');
  });

  it('格式错误被拦截', () => {
    expect(checkReservationSlot(s, '2026/10/09 18:00').ok).toBe(false);
  });
});

describe('自提流程编排', () => {
  const stores = sampleStores();

  it('到店自取 + 立即取餐：不产生 beCode', () => {
    const p = planPickup({ store: stores[0]!, beType: 1, reserve: false, takeWayList: [{ code: 'eat-in', title: '堂食', subtitle: '店内用餐' }, { code: 'locker-out', title: '外带', subtitle: '店外取餐柜' }] });
    expect(p.beCode).toBeUndefined();
    expect(p.channelArgs['beCode']).toBeUndefined();
    expect(p.takeWay?.code).toBe('eat-in');
    expect(p.checks.every((c) => c.ok)).toBe(true);
    expect(renderPickupPlan(p)).toContain('到店自取');
  });

  it('偏好取餐柜时选择 locker-out', () => {
    const p = planPickup({ store: stores[0]!, beType: 1, reserve: false, takeWayList: [{ code: 'eat-in', title: '堂食', subtitle: '店内用餐' }, { code: 'locker-out', title: '外带', subtitle: '店外取餐柜' }], takeWayHint: '取餐柜' });
    expect(p.takeWay?.code).toBe('locker-out');
  });

  it('得来速缺 beCode 时抛错', () => {
    expect(() => planPickup({ store: stores[0]!, beType: 5, reserve: false })).toThrow(/得来速 beCode/);
  });

  it('得来速正常时带上 beCode', () => {
    const p = planPickup({ store: stores[2]!, beType: 5, reserve: false, takeWayList: [{ code: 'eat-in', title: '堂食', subtitle: '店内用餐' }] });
    expect(p.channelArgs['beCode']).toBe('DT-1420888');
    // 该门店 businessStatus=false，校验项应标红但不阻断
    expect(p.checks.find((c) => c.name === '门店营业状态')!.ok).toBe(false);
  });

  it('预约取餐缺时间时抛参数缺失', () => {
    expect(() => planPickup({ store: stores[0]!, beType: 1, reserve: true })).toThrow(/预约取餐必须提供取餐时间/);
  });

  it('预约时段非法时抛时段错误', () => {
    expect(() => planPickup({ store: stores[0]!, beType: 1, reserve: true, reservationDate: '2026-10-09 12:00' })).toThrow(McdError);
    try {
      planPickup({ store: stores[0]!, beType: 1, reserve: true, reservationDate: '2026-10-09 12:00' });
    } catch (e) {
      expect((e as McdError).kind).toBe('RESERVATION_SLOT_INVALID');
    }
  });

  it('预约合法时把 reservationDate 写入通道参数', () => {
    const p = planPickup({ store: stores[0]!, beType: 1, reserve: true, reservationDate: '2026-10-09 18:00', takeWayList: [{ code: 'locker-out', title: '外带', subtitle: '店外取餐柜' }] });
    expect(p.channelArgs['reservationDate']).toBe('2026-10-09 18:00');
    expect(p.channelArgs['takeWayCode']).toBe('locker-out');
  });
});

describe('通道参数规则', () => {
  it('到店自取传了 beCode 会被拒绝', () => {
    expect(() => assertChannel({ storeCode: '1', orderType: 1, beType: 1, beCode: 'X' })).toThrow(/不能传 beCode/);
  });

  it('外送缺 beCode 会被拒绝', () => {
    expect(() => assertChannel({ storeCode: '1', orderType: 2, beType: 2 })).toThrow(/beCode 必传/);
  });

  it('缺 storeCode 会被拒绝', () => {
    expect(() => assertChannel({ storeCode: '', orderType: 1, beType: 1 })).toThrow(/storeCode/);
  });

  it('reservationDate 格式校验', () => {
    expect(() => assertChannel({ storeCode: '1', orderType: 1, beType: 1, reservationDate: '2026/10/09 18:00' })).toThrow(/yyyy-MM-dd HH:mm/);
  });

  it('channelArgs 在到店自取场景剔除 beCode', () => {
    const args = channelArgs({ storeCode: '1', orderType: 1, beType: 1 });
    expect(args['beCode']).toBeUndefined();
  });
});

describe('响应信封解析', () => {
  it('从带说明的文本中抠出 JSON 信封', () => {
    const text = `# API Response Information

Some description with {"fake": true} braces.

## Original Response

{"success":true,"code":200,"message":"请求成功","data":{"a":1}}`;
    const env = extractEnvelope<{ a: number }>(text);
    expect(env?.success).toBe(true);
    expect(env?.data?.a).toBe(1);
  });

  it('售罄错误被归类为 SOLD_OUT', () => {
    const env = extractEnvelope('{"success":false,"code":60006,"message":"商品已售罄或不可售，换一个商品或检查orderType/beType","traceId":"abc"}');
    const err = McdError.fromEnvelope(env);
    expect(err.kind).toBe('SOLD_OUT');
    expect(err.traceId).toBe('abc');
    expect(err.toUserMessage()).toContain('traceId');
  });

  it('400 参数缺失归类为 PARAM_MISSING', () => {
    const err = McdError.fromEnvelope({ success: false, code: 400, message: 'storeCode门店编码不能为空' });
    expect(err.kind).toBe('PARAM_MISSING');
  });

  it('401 / 429 正确归类', () => {
    expect(McdError.fromEnvelope({ code: 401 }).kind).toBe('TOKEN_INVALID');
    expect(McdError.fromEnvelope({ code: 429 }).kind).toBe('RATE_LIMITED');
  });
});
