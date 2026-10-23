#!/usr/bin/env node
/**
 * mcd-smart-order CLI —— 用真实 MCP 数据跑通四大能力
 *
 * 用法：
 *   export MCD_MCP_TOKEN=<your token>
 *   npx tsx src/cli.ts menu     --city 深圳市 --keyword 科技园
 *   npx tsx src/cli.ts compile  --city 深圳市 --keyword 科技园 --text "预算35元，不要吃辣，牛奶过敏，热量600大卡以内"
 *   npx tsx src/cli.ts nutrition --city 深圳市 --keyword 科技园 --kcal 600 --preset highProtein
 *   npx tsx src/cli.ts pickup   --city 深圳市 --keyword 科技园 --reserve "2026-10-09 18:00"
 *
 * 说明：本 CLI 直接走 Streamable HTTP 调 mcd-mcp，与 Agent 侧的效果等价，用于回归验证。
 */

import { McdClient } from './mcp-client.js';
import { compileOrder, renderResult } from './compiler.js';
import { applyHardFilters, buildMealViews, defaultConstraints, extractConstraints, scanSubItems } from './constraints.js';
import { MACRO_PRESETS, buildNutritionIndex, matchNutrition, nutritionOfCombo, planNutrition } from './nutrition.js';
import { checkBusinessHours, checkReservationSlot, pickStore, planPickup, renderPickupPlan } from './pickup.js';
import {
  checkPayment,
  createOrderGuarded,
  extractPayInfo,
  preflight,
  renderConfirmSheet,
  renderPayGuide,
  renderQrToFile,
} from './order.js';
import { McdError } from './errors.js';
import type { BeType, Nutrition } from './types.js';
import type { MacroPresetName } from './constraints.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * 下钻餐品的组成子项，拦下「名称干净但子项含过敏原」的漏网。
 *
 * 只对**套餐**下钻（单品的名称已能反映自身；特调 modification 按 §4.5 只在
 * 牛奶/鸡蛋等配料型过敏原时才需要，这里覆盖 choices/rounds 这一层即主要风险面）。
 *
 * @param maxRounds 最多迭代几轮：每轮排除后可能有新套餐递补进 Top-K，需重新下钻
 */
async function deepScanCombos(
  client: McdClient,
  menu: { meals: Record<string, { name: string }> },
  channel: { storeCode: string; orderType: 1 | 2; beType: BeType },
  c: ReturnType<typeof defaultConstraints>,
  maxRounds: number,
  nutritionIdx?: ReturnType<typeof buildNutritionIndex>,
): Promise<{ exclusions: Map<string, string>; nutrition: Map<string, Nutrition>; nutritionNotes: string[] }> {
  const out = new Map<string, string>();
  const nut = new Map<string, Nutrition>();
  const notes: string[] = [];

  // 只对看起来像套餐的 code 下钻（套餐 code 与单品 code 段位不同，这里按名称特征 + 全量兜底）
  const comboCodes = Object.entries(menu.meals)
    .filter(([, m]) => /件套|套餐|随心配|乐园餐|双拼|全盒|拼盘|四宫格/.test(m.name))
    .map(([code]) => code);

  for (let round = 0; round < maxRounds; round++) {
    const pending = comboCodes.filter((code) => !out.has(code));
    if (pending.length === 0) break;

    let found = 0;
    for (const code of pending) {
      try {
        const d = (await client.queryMealDetail({ ...channel, code })) as Parameters<typeof scanSubItems>[0];
        const hits = scanSubItems(d, c);
        if (hits.length) {
          out.set(code, `子项不可用（${hits.map((h) => `${h.where} ${h.reason}`).join('、')}）`);
          found++;
          continue;
        }
        // 顺带算套餐真实营养（拆子项加总，不能按套餐名匹配）
        if (nutritionIdx) {
          const nr = nutritionOfCombo(d, nutritionIdx);
          if (nr.nutrition) nut.set(code, nr.nutrition);
          else if (nr.missing.length) {
            notes.push(`${menu.meals[code]?.name ?? code}：子项营养缺失（${nr.missing.slice(0, 3).join('、')}），热量未知`);
          }
        }
      } catch {
        // 详情取不到（售罄/不在当前时段菜单）：不因此排除，交给后续算价层报错
      }
    }
    if (found === 0) break; // 本轮无新增，结果已稳定
  }
  return { exclusions: out, nutrition: nut, nutritionNotes: notes };
}

async function resolveStore(client: McdClient, beType: 1 | 5 = 1) {
  const city = arg('city', '深圳市')!;
  const keyword = arg('keyword', '科技园')!;
  const stores = await client.queryNearbyStores({ beType, searchType: 2, city, keyword });
  const picked = pickStore(stores, { storeCode: arg('store'), keyword: arg('shop') });
  return picked;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const client = new McdClient();

  if (cmd === 'menu') {
    const { store } = await resolveStore(client);
    const menu = await client.queryMeals({ storeCode: store.storeCode, orderType: 1, beType: 1 });
    console.log(`门店：${store.storeName}（${store.storeCode}） 营业 ${store.businessStartTime}-${store.businessEndTime}`);
    for (const c of menu.categories) {
      console.log(`\n【${c.name.replace(/\n/g, '')}】`);
      for (const ref of c.meals) {
        const m = menu.meals[ref.code];
        if (m) console.log(`  ${ref.code}  ${m.name}  ¥${m.currentPrice}${m.originalPrice !== m.currentPrice ? ` (原价 ¥${m.originalPrice})` : ''}`);
      }
    }
    return;
  }

  if (cmd === 'compile') {
    const text = arg('text', '预算35元以内，来个汉堡、薯条和可乐')!;
    const c = extractConstraints(text);
    if (arg('budget')) c.budgetMax = Number(arg('budget'));
    if (arg('kcal')) c.calorieMax = Number(arg('kcal'));
    if (has('veg')) c.vegetarian = true;

    const { store } = await resolveStore(client);
    const channel = { storeCode: store.storeCode, orderType: 1 as const, beType: 1 as const };
    const [menu, nutri] = await Promise.all([client.queryMeals(channel), client.listNutritionFoods()]);

    console.log(`门店：${store.storeName}（${store.storeCode}）`);
    console.log(`解析到的约束：${JSON.stringify({ ...c, requiredSlots: c.requiredSlots }, null, 1)}\n`);

    // 下钻套餐子项：套餐名只描述主食，名称层过滤会漏判；顺带算真实营养
    const nutriIdx = buildNutritionIndex(nutri);
    const scan = await deepScanCombos(client, menu, channel, c, 3, nutriIdx);
    if (scan.exclusions.size) {
      console.log(`🔎 下钻 ${scan.exclusions.size} 个餐品的组成子项，发现不可用：`);
      for (const [code, why] of scan.exclusions) {
        console.log(`   ✗ ${menu.meals[code]?.name ?? code}（${code}）—— ${why}`);
      }
      console.log();
    }
    if (scan.nutritionNotes.length) {
      for (const n of scan.nutritionNotes) console.log(`⚠️ ${n}`);
      console.log();
    }

    const r = compileOrder(menu, nutri, channel, c, {
      topK: 3,
      comboExclusions: scan.exclusions,
      comboNutrition: scan.nutrition,
    });
    console.log(renderResult(r));
    console.log(`\n[统计] 搜索 ${r.stats.searched} 个组合，剪枝 ${r.stats.pruned} 次`);
    return;
  }

  if (cmd === 'nutrition') {
    const kcal = Number(arg('kcal', '600'));
    const presetRaw = arg('preset', 'balanced')!;
    const preset: MacroPresetName = (presetRaw in MACRO_PRESETS ? presetRaw : 'balanced') as MacroPresetName;
    const { store } = await resolveStore(client);
    const channel = { storeCode: store.storeCode, orderType: 1 as const, beType: 1 as const };
    const [menu, nutri] = await Promise.all([client.queryMeals(channel), client.listNutritionFoods()]);
    const idx = buildNutritionIndex(nutri);

    // 营养搭配同样必须应用过敏原硬过滤。
    // 实测：不过滤时 700kcal 高蛋白方案会给出「纯牛奶 + 双层吉士汉堡」组合。
    const allergens = (arg('allergen') ?? '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const excluded = new Set<string>();
    if (allergens.length > 0) {
      const views = buildMealViews(menu, nutri);
      for (const code of applyHardFilters(views, { ...defaultConstraints(), allergens }).keys()) {
        excluded.add(code);
      }
      console.log(`已按过敏原「${allergens.join('、')}」排除 ${excluded.size} 个餐品\n`);
    }

    const candidates = Object.entries(menu.meals)
      .filter(([code]) => !excluded.has(code))
      .map(([code, m]) => {
        const nm = matchNutrition(m.name, idx);
        return nm ? { code, name: m.name, nutrition: nm.nutrition, match: nm.level === 'exact' ? ('exact' as const) : ('contains' as const) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const plans = planNutrition(candidates, { kcal, ratio: MACRO_PRESETS[preset]! }, { maxItems: 3, topK: 3 });
    console.log(`目标 ${kcal} kcal，配比 ${preset} = ${JSON.stringify(MACRO_PRESETS[preset])}\n`);
    plans.forEach((p, i) => {
      console.log(`方案 ${i + 1}：`);
      p.items.forEach((it) => console.log(`  - ${it.name}  ${it.nutrition.energyKcal} kcal  蛋白${it.nutrition.protein}g/碳水${it.nutrition.carbohydrate}g/脂肪${it.nutrition.fat}g`));
      console.log(
        `  合计 ${Math.round(p.total.energyKcal)} kcal（达成率 ${(p.kcalFill * 100).toFixed(0)}%）｜蛋白 ${p.total.protein.toFixed(0)}g / 碳水 ${p.total.carbohydrate.toFixed(0)}g / 脂肪 ${p.total.fat.toFixed(0)}g`,
      );
      console.log(`  实际供能比 蛋白 ${(p.actual.protein * 100).toFixed(0)}% / 碳水 ${(p.actual.carb * 100).toFixed(0)}% / 脂肪 ${(p.actual.fat * 100).toFixed(0)}%（偏差 ${p.deviation.toFixed(3)}）`);
      p.notes.forEach((n) => console.log(`  ⚠️ ${n}`));
      console.log();
    });
    return;
  }

  if (cmd === 'pickup') {
    const beType: BeType = arg('dt') ? 5 : 1;
    const { store, reason } = await resolveStore(client, beType);
    console.log(`选店：${store.storeName}（${store.storeCode}）· ${reason}\n`);
    console.log(`营业时间校验：${checkBusinessHours(store, arg('at', nowHm())!).message}`);

    const reserveDate = arg('reserve');
    if (reserveDate) {
      const rc = checkReservationSlot(store, reserveDate);
      console.log(`预约时段校验：${rc.message}`);
      if (!rc.ok) return;
    }

    const channel = { storeCode: store.storeCode, orderType: 1 as const, beType };
    // 先用一份便宜餐品算价，拿 takeWayList
    const menu = await client.queryMeals(channel);
    const firstCode = Object.keys(menu.meals)[0]!;
    const price = await client.calculatePrice({ ...channel, items: [{ productCode: firstCode, quantity: 1 }] });
    const p = planPickup({ store, beType, reserve: Boolean(reserveDate), reservationDate: reserveDate, takeWayList: price.takeWayList, takeWayHint: arg('way') });
    console.log('\n' + renderPickupPlan(p));
    return;
  }

  if (cmd === 'delivery') {
    const addresses = await client.deliveryQueryAddresses();
    if (addresses.length === 0) {
      console.log('账号暂无配送地址，可先用 delivery-create-address 创建后再试。');
      return;
    }
    const chosen = arg('addressId')
      ? addresses.find((a) => a.addressId === arg('addressId')) ?? addresses[0]!
      : addresses[0]!;
    console.log(`配送地址：${chosen.fullAddress}（${chosen.contactName} ${chosen.phone}）\n`);

    const beType: 2 | 6 = arg('team') ? 6 : 2;
    const stores = await client.deliveryQueryStores({ beType, addressId: chosen.addressId });
    console.log(`可配送门店（beType=${beType}）：`);
    for (const s of stores) {
      console.log(`  ${s.storeCode}  beCode=${s.beCode ?? '-'}  ${s.storeName}  ${s.businessStartTime}-${s.businessEndTime}`);
    }
    console.log('\n注意：外送门店返回体不含 address / distance 字段。');
    return;
  }

  if (cmd === 'order') {
    // 下单与支付。安全设计：默认 dry-run（不发送请求），
    // 要真下单必须同时传 --yes 与 --confirm，两道闸都过才发送。
    const productCode = arg('code');
    const quantity = Number(arg('qty', '1'));
    if (!productCode) {
      console.error('用法：order --code <productCode> [--qty 1] [--dry-run] [--yes --confirm]');
      console.error('     order --check <orderId>     # 查询支付结果');
      console.error('     order --qr                  # 支付链接以二维码形式输出（默认开启）');
      process.exit(1);
    }

    const checkId = arg('check');
    if (checkId) {
      const r = await checkPayment(client, checkId);
      console.log(r.message);
      if (r.cancelled) console.log('如需重新下单，请说明具体餐品。');
      return;
    }

    const { store } = await resolveStore(client);
    const channel = { storeCode: store.storeCode, orderType: 1 as const, beType: 1 as const };
    const items = [{ productCode, quantity }];

    // ① 算价拿基准
    const price = await client.calculatePrice({ ...channel, items });
    const takeWay = price.takeWayList?.[0];
    if (!takeWay) {
      console.error('算价未返回 takeWayList，无法确定取餐方式。');
      process.exit(1);
    }

    // 取真实餐品名（确认单必须让用户看得懂，不能只给 code）
    let productName = productCode;
    try {
      const menu = await client.queryMeals(channel);
      productName = menu.meals[productCode]?.name ?? productCode;
    } catch {
      /* 菜单查不到就退回 code */
    }

    const totalYuan = price.price / 100;
    const sheet = {
      storeName: store.storeName,
      storeCode: store.storeCode,
      channelLabel: `到店自取 · ${takeWay.title}`,
      lines: [{ name: productName, quantity, unitPrice: totalYuan / quantity }],
      total: totalYuan,
      priceNote: `价格来源：calculate-price（${new Date().toLocaleTimeString('zh-CN')}）`,
    };
    console.log(renderConfirmSheet(sheet));
    console.log();

    // ② 下单前复核
    const pf = await preflight(client, channel, items, price.price);
    if (pf.warnings.length) for (const w of pf.warnings) console.log(`⚠️ ${w}`);
    if (!pf.ok) {
      console.error('❌ 下单前复核未通过：');
      for (const b of pf.blockers) console.error(`   - ${b}`);
      process.exit(1);
    }
    console.log('✅ 价格与库存复核通过\n');

    // ③ 创建订单（默认 dry-run）
    const dryRun = !has('yes');
    const outcome = await createOrderGuarded(
      client,
      store.storeCode,
      { ...channel, items, takeWayCode: takeWay.code },
      { dryRun, confirmed: has('confirm') },
    );

    if (outcome.reused) {
      console.log(`♻️ 该组合已创建过订单 ${outcome.result?.orderId}，复用而不重复下单。\n`);
    }
    if (outcome.requestPreview) {
      console.log('🧪 dry-run：以下参数已构造完成但未发送');
      console.log(JSON.stringify(outcome.requestPreview, null, 1));
      console.log('\n确认无误后加 --yes --confirm 才会真正下单（会产生真实订单）。');
      return;
    }

    if (outcome.result) {
      const pay = extractPayInfo(outcome.result);
      console.log(renderPayGuide(pay, { desktopQr: has('desktop') }));
      const locker = outcome.result.orderDetail?.lockerQrCode;
      if (locker) console.log(`\n取餐柜二维码（不是支付码）：${locker}`);

      // 图片二维码才是能可靠扫的形式；默认落盘，--no-qr-file 可关。
      if (pay.payH5Url && !has('no-qr-file')) {
        const out = arg('qr-file', `./pay-${pay.orderId}.png`)!;
        try {
          await renderQrToFile(pay.payH5Url, out, 480);
          console.log(`\n🖼️ 二维码图片已保存：${out}（用手机相机扫这张，不要扫终端字符）`);
        } catch (e) {
          console.log(`\n⚠️ 二维码图片保存失败（${(e as Error).message}），请直接用上面的链接。`);
        }
      }
    }
    return;
  }

  console.log(`未知命令：${cmd}
可用命令：menu / compile / nutrition / pickup / delivery / order`);
}

function nowHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

main().catch((e) => {
  if (e instanceof McdError) {
    console.error(`[${e.kind}] ${e.toUserMessage()}`);
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});

// 保持 defaultConstraints 在本文件被引用（便于扩展默认值）
void defaultConstraints;
