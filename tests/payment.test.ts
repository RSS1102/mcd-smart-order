import { describe, expect, it } from 'vitest';
import {
  __resetOrderCache,
  checkPayment,
  createOrderGuarded,
  extractPayInfo,
  orderFingerprint,
  preflight,
  renderConfirmSheet,
  renderPayGuide,
  renderQrToTerminal,
} from '../src/order.js';
import { McdError } from '../src/errors.js';
import type { McdClient } from '../src/mcp-client.js';
import type { ChannelParams, OrderItemInput, OrderResult } from '../src/types.js';

const CHANNEL: ChannelParams = { storeCode: '1420762', orderType: 1, beType: 1 };
const ITEMS: OrderItemInput[] = [{ productCode: '9900004064', quantity: 1 }];

/** 最小可用的假 client，只实现 order.ts 用到的三个方法 */
function fakeClient(over: {
  price?: number;
  menuMeals?: Record<string, { name: string }>;
  createResult?: OrderResult;
  orderResult?: OrderResult;
  onCreate?: () => void;
  onPrice?: () => void;
}): McdClient {
  return {
    queryMeals: async () => ({ meals: over.menuMeals ?? { '9900004064': { name: '板烧鸡腿堡三件套' } } }),
    calculatePrice: async () => {
      over.onPrice?.();
      return { price: over.price ?? 3450, takeWayList: [{ code: 'eat-in', title: '堂食' }] };
    },
    createOrder: async () => {
      over.onCreate?.();
      return over.createResult ?? { orderId: 'ORD1', payH5Url: 'https://pay.mcd.cn/x' };
    },
    queryOrder: async () => over.orderResult ?? { orderId: 'ORD1', orderDetail: { orderId: 'ORD1', orderStatus: '1' } },
  } as unknown as McdClient;
}

describe('确认单渲染', () => {
  it('包含门店、餐品、子项、合计与确认指引', () => {
    const text = renderConfirmSheet({
      storeName: '同方信息港餐厅',
      storeCode: '1420762',
      channelLabel: '到店自取 · 堂食',
      lines: [{ name: '板烧鸡腿堡三件套', quantity: 1, unitPrice: 34.5, subItems: ['主食 板烧鸡腿堡', '小食 中薯条'] }],
      total: 34.5,
      originalTotal: 47.5,
      allergenNote: '含牛奶成分，已按过敏原核查（本单无乳制品）',
    });
    expect(text).toContain('同方信息港餐厅');
    expect(text).toContain('板烧鸡腿堡三件套 ×1');
    expect(text).toContain('主食 板烧鸡腿堡');
    expect(text).toContain('合计 ¥34.50（原价 ¥47.50）');
    expect(text).toContain('含牛奶成分');
    expect(text).toContain('确认下单');
  });

  it('数量 >1 时金额按单价累计', () => {
    const text = renderConfirmSheet({
      storeName: 'X', storeCode: '1', channelLabel: '堂食',
      lines: [{ name: '可乐', quantity: 2, unitPrice: 9.5 }], total: 19,
    });
    expect(text).toContain('可乐 ×2   ¥19.00');
  });
});

describe('下单前复核 preflight', () => {
  it('价格与库存都正常时通过', async () => {
    const r = await preflight(fakeClient({ price: 3450 }), CHANNEL, ITEMS, 3450);
    expect(r.ok).toBe(true);
    expect(r.priceDelta).toBe(0);
    expect(r.blockers).toHaveLength(0);
  });

  it('涨价必须阻断（不能默默按新价下单）', async () => {
    const r = await preflight(fakeClient({ price: 3950 }), CHANNEL, ITEMS, 3450);
    expect(r.ok).toBe(false);
    expect(r.priceDelta).toBe(5);
    expect(r.blockers.join()).toContain('上涨 ¥5.00');
  });

  it('降价不阻断，只提示', async () => {
    const r = await preflight(fakeClient({ price: 2950 }), CHANNEL, ITEMS, 3450);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toContain('下降 ¥5.00');
  });

  it('餐品从菜单消失（售罄）必须阻断', async () => {
    const r = await preflight(fakeClient({ menuMeals: {} }), CHANNEL, ITEMS, 3450);
    expect(r.ok).toBe(false);
    expect(r.blockers.join()).toContain('已售罄或下架');
  });
});

describe('幂等：同一组合只创建一次', () => {
  it('相同门店 + 相同组合的指纹一致，规格差异会改变指纹', () => {
    const a = orderFingerprint('1420762', ITEMS);
    const b = orderFingerprint('1420762', [{ productCode: '9900004064', quantity: 1 }]);
    expect(a).toBe(b);
    expect(orderFingerprint('1420762', [{ productCode: '9900004064', quantity: 2 }])).not.toBe(a);
    expect(orderFingerprint('9999999', ITEMS)).not.toBe(a);
  });

  it('第二次调用复用首次订单，不重复发送请求', async () => {
    __resetOrderCache();
    let calls = 0;
    const c = fakeClient({ onCreate: () => { calls++; } });
    const first = await createOrderGuarded(c, '1420762', { ...CHANNEL, items: ITEMS, takeWayCode: 'eat-in' }, { dryRun: false, confirmed: true });
    const second = await createOrderGuarded(c, '1420762', { ...CHANNEL, items: ITEMS, takeWayCode: 'eat-in' }, { dryRun: false, confirmed: true });
    expect(calls).toBe(1);
    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.result?.orderId).toBe('ORD1');
  });
});

describe('dry-run 与确认门', () => {
  it('默认 dry-run 不发送请求', async () => {
    __resetOrderCache();
    let calls = 0;
    const c = fakeClient({ onCreate: () => { calls++; } });
    const r = await createOrderGuarded(c, '1420762', { ...CHANNEL, items: ITEMS, takeWayCode: 'eat-in' });
    expect(calls).toBe(0);
    expect(r.sent).toBe(false);
    expect(r.requestPreview).toBeTruthy();
  });

  it('未显式确认时即使 dryRun=false 也不发送', async () => {
    __resetOrderCache();
    let calls = 0;
    const c = fakeClient({ onCreate: () => { calls++; } });
    await expect(
      createOrderGuarded(c, '1420762', { ...CHANNEL, items: ITEMS, takeWayCode: 'eat-in' }, { dryRun: false, confirmed: false }),
    ).rejects.toBeInstanceOf(McdError);
    expect(calls).toBe(0);
  });
});

describe('支付信息提取与二维码', () => {
  it('从 create-order 返回中提取 payH5Url / 过期时间 / 实付金额', () => {
    const info = extractPayInfo({
      orderId: 'ORD1',
      payH5Url: 'https://pay.mcd.cn/x',
      orderDetail: { orderId: 'ORD1', orderStatus: '1', expirePayTime: '2026-10-23 12:30', realTotalAmount: '34.50' },
    });
    expect(info.payH5Url).toBe('https://pay.mcd.cn/x');
    expect(info.expirePayTime).toBe('2026-10-23 12:30');
    expect(info.amount).toBe('34.50');
  });

  it('二维码为纯块字符，不含 ANSI 转义', () => {
    const qr = renderQrToTerminal('https://pay.mcd.cn/h5/pay?orderId=ORD1');
    expect(qr).toContain('█');
    expect(qr).not.toMatch(/\x1b\[/);
  });

  it('无 payH5Url 时给出 APP 内支付的降级指引，而不是空白', () => {
    const text = renderPayGuide({ orderId: 'ORD1' }, { qr: true });
    expect(text).toContain('未包含支付链接');
    expect(text).toContain('麦当劳 APP');
  });
});

describe('支付结果核实', () => {
  const mk = (status: string): McdClient =>
    fakeClient({ orderResult: { orderId: 'ORD1', orderDetail: { orderId: 'ORD1', orderStatus: status, pickupCode: 'P123', storeName: 'X店' } } });

  it('待支付 → pending，且提示不会重复创建订单', async () => {
    const r = await checkPayment(mk('1'), 'ORD1');
    expect(r.pending).toBe(true);
    expect(r.paid).toBe(false);
    expect(r.message).toContain('不会重复创建订单');
  });

  it('配餐中 → 已支付，给出取餐码', async () => {
    const r = await checkPayment(mk('2'), 'ORD1');
    expect(r.paid).toBe(true);
    expect(r.pickupCode).toBe('P123');
    expect(r.message).toContain('取餐码：P123');
  });

  it('已取消 → 说明需重新下单', async () => {
    const r = await checkPayment(mk('7'), 'ORD1');
    expect(r.cancelled).toBe(true);
    expect(r.message).toContain('重新下单');
  });

  it('未知状态不误判为已支付', async () => {
    const r = await checkPayment(mk('99'), 'ORD1');
    expect(r.paid).toBe(false);
    expect(r.cancelled).toBe(false);
  });
});

describe('订单状态：数字码与中文标签都要兼容', () => {
  const mk = (status: string): McdClient =>
    fakeClient({ orderResult: { orderId: 'ORD1', orderDetail: { orderId: 'ORD1', orderStatus: status, pickupCode: 'P1' } } });

  it('实测返回的中文「待支付」必须识别为 pending', async () => {
    // outputSchema 写的是 "1"，真实返回是「待支付」。若只认数字，
    // pending=false，用户说「付完了」时会被当成未知状态
    const r = await checkPayment(mk('待支付'), 'ORD1');
    expect(r.pending).toBe(true);
    expect(r.paid).toBe(false);
    expect(r.message).toContain('不会重复创建订单');
  });

  it('中文「配餐中」识别为已支付', async () => {
    const r = await checkPayment(mk('配餐中'), 'ORD1');
    expect(r.paid).toBe(true);
  });

  it('中文「已取消」识别为取消', async () => {
    const r = await checkPayment(mk('已取消'), 'ORD1');
    expect(r.cancelled).toBe(true);
  });

  it('数字码仍然兼容', async () => {
    expect((await checkPayment(mk('1'), 'ORD1')).pending).toBe(true);
    expect((await checkPayment(mk('2'), 'ORD1')).paid).toBe(true);
    expect((await checkPayment(mk('7'), 'ORD1')).cancelled).toBe(true);
  });
});

describe('query-order 返回结构：详情在顶层而非 orderDetail', () => {
  it('顶层直接给 orderStatus 时也能识别（实测结构）', async () => {
    // create-order 是 data.orderDetail.{...}，query-order 是 data.{...}
    // 只读 orderDetail 会拿到空，状态变「未知」
    const flat = {
      orderId: 'ORD1',
      orderStatus: '待支付',
      status: '10',
      pickupCode: '',
      storeName: 'X店',
    } as unknown as OrderResult;
    const c = { queryOrder: async () => flat } as unknown as McdClient;
    const r = await checkPayment(c, 'ORD1');
    expect(r.status).toBe('待支付');
    expect(r.pending).toBe(true);
  });

  it('同一响应里 status="10" 不可靠，应以 orderStatus 为准', async () => {
    // outputSchema 说 10 = 配餐中，但实际订单是待支付
    const flat = { orderId: 'ORD1', orderStatus: '待支付', status: '10' } as unknown as OrderResult;
    const c = { queryOrder: async () => flat } as unknown as McdClient;
    const r = await checkPayment(c, 'ORD1');
    expect(r.paid, '不能被 status="10" 误判为已支付').toBe(false);
    expect(r.pending).toBe(true);
  });
});
