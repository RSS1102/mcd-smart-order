import { describe, expect, it } from 'vitest';
import { validateOrderInput } from '../src/mcp-client.js';
import { McdError } from '../src/errors.js';
import { parseReservationText, pickStore } from '../src/pickup.js';
import type { CreateOrderInput, Store } from '../src/types.js';

/**
 * create-order 会产生真实交易，无法在测试中实际调用。
 * 这里改为对 validateOrderInput（纯函数）做穷举校验，
 * 把所有能本地拦住的参数错误都锁死。
 */

const BASE: CreateOrderInput = {
  storeCode: '1420762',
  orderType: 1,
  beType: 1,
  takeWayCode: 'eat-in',
  items: [{ productCode: '9900004064', quantity: 1 }],
};

function expectThrows(patch: Partial<CreateOrderInput>, keyword: string): void {
  let captured: unknown;
  try {
    validateOrderInput({ ...BASE, ...patch } as CreateOrderInput);
  } catch (e) {
    captured = e;
  }
  expect(captured, `期望抛出包含「${keyword}」的错误`).toBeInstanceOf(McdError);
  expect((captured as McdError).kind).toBe('PARAM_MISSING');
  expect((captured as McdError).message).toContain(keyword);
}

describe('create-order 参数校验', () => {
  it('合法的到店订单通过校验', () => {
    expect(() => validateOrderInput(BASE)).not.toThrow();
  });

  it('合法的外送订单（麦乐送）通过校验', () => {
    expect(() =>
      validateOrderInput({
        storeCode: '1421136',
        orderType: 2,
        beType: 2,
        beCode: '142113602',
        addressId: '1036',
        items: [{ productCode: '9900004064', quantity: 2 }],
      }),
    ).not.toThrow();
  });

  it('合法的团餐订单通过校验', () => {
    expect(() =>
      validateOrderInput({
        storeCode: '1421136',
        orderType: 2,
        beType: 6,
        beCode: '142113602',
        addressId: '1036',
        gmServiceCode: 'GM-1',
        items: [{ productCode: '9900004064', quantity: 10 }],
      }),
    ).not.toThrow();
  });

  it('到店缺 takeWayCode 被拦截', () => {
    expectThrows({ takeWayCode: undefined }, 'takeWayCode');
  });

  it('到店误传 addressId 被拦截', () => {
    expectThrows({ addressId: '1036' }, 'addressId');
  });

  it('外送缺 addressId 被拦截', () => {
    expectThrows({ orderType: 2, beType: 2, beCode: '142113602', takeWayCode: undefined, addressId: undefined }, 'addressId');
  });

  it('外送误传 takeWayCode 被拦截', () => {
    expectThrows({ orderType: 2, beType: 2, beCode: '142113602', addressId: '1036' }, 'takeWayCode');
  });

  it('团餐缺 gmServiceCode 被拦截', () => {
    expectThrows({ orderType: 2, beType: 6, beCode: '142113602', addressId: '1036', takeWayCode: undefined }, 'gmServiceCode');
  });

  it('外送缺 beCode 被拦截（到店自取以外场景必传）', () => {
    expectThrows({ orderType: 2, beType: 2, addressId: '1036', takeWayCode: undefined }, 'beCode');
  });

  it('到店自取误传 beCode 被拦截', () => {
    expectThrows({ beCode: 'X' }, '不能传 beCode');
  });

  it('items 为空被拦截', () => {
    expectThrows({ items: [] }, 'items 不能为空');
  });

  it('数量为 0 被拦截', () => {
    expectThrows({ items: [{ productCode: '9900004064', quantity: 0 }] }, 'quantity');
  });

  it('缺少 productCode 被拦截', () => {
    expectThrows({ items: [{ productCode: '', quantity: 1 }] }, 'productCode');
  });

  it('特调项缺 key 被拦截', () => {
    expectThrows(
      { items: [{ productCode: '9900004064', quantity: 1, modification: { values: [{ code: '102201', key: '', quantity: 1 }] } }] },
      'key',
    );
  });

  it('套餐 round 缺失被拦截', () => {
    expectThrows(
      { items: [{ productCode: '9900004064', quantity: 1, roundList: [{ round: '', comboItemList: [{ code: '1406', quantity: 1 }] }] }] },
      'round',
    );
  });

  it('套餐 comboItemList 为空被拦截', () => {
    expectThrows(
      { items: [{ productCode: '9900004064', quantity: 1, roundList: [{ round: '1', comboItemList: [] }] }] },
      'comboItemList',
    );
  });

  it('备注超过 50 字被拦截', () => {
    expectThrows({ remark: 'x'.repeat(51) }, 'remark');
  });

  it('reservationDate 格式错误被拦截', () => {
    expectThrows({ reservationDate: '2026/10/09 18:00' }, 'yyyy-MM-dd HH:mm');
  });
});

describe('外送场景（delivery-query-stores 返回无 address/distance）', () => {
  const deliveryStores: Store[] = [
    {
      storeCode: '1421136',
      beCode: '142113602',
      storeName: '麦当劳深圳腾讯总部园区一店餐厅',
      businessStatus: true,
      businessStartTime: '07:00',
      businessEndTime: '23:00',
      reservation: true,
    },
    {
      storeCode: '1420252',
      beCode: '142025202',
      storeName: '麦当劳深圳海城路餐厅',
      businessStatus: true,
      businessStartTime: '00:00',
      businessEndTime: '23:59',
      reservation: true,
    },
  ];

  it('无 distance 字段时按名称顺序选取，不崩溃', () => {
    const r = pickStore(deliveryStores);
    expect(r.store.storeCode).toBeDefined();
    expect(r.reason).not.toContain('undefined');
  });

  it('无 distance 字段时仍可按 storeCode 精确匹配', () => {
    const r = pickStore(deliveryStores, { storeCode: '1420252' });
    expect(r.store.storeName).toContain('海城路');
  });

  it('无 address 字段时关键词仍能匹配 storeName', () => {
    const r = pickStore(deliveryStores, { keyword: '腾讯' });
    expect(r.store.storeCode).toBe('1421136');
  });
});

describe('多段预约时段解析', () => {
  it('解析三段区间：夜市(00:00至00:29,00:30至05:29,17:30至23:59)', () => {
    const slots = parseReservationText('夜市(00:00至00:29,00:30至05:29,17:30至23:59)，早餐(05:30至10:59)');
    const night = slots.find((s) => s.name === '夜市')!;
    expect(night.ranges).toHaveLength(3);
    expect(night.ranges[0]).toEqual({ start: '00:00', end: '00:29' });
    expect(night.ranges[2]).toEqual({ start: '17:30', end: '23:59' });
    expect(slots.find((s) => s.name === '早餐')!.ranges).toHaveLength(1);
  });
});
