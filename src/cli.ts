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
import { defaultConstraints, extractConstraints } from './constraints.js';
import { MACRO_PRESETS, buildNutritionIndex, matchNutrition, planNutrition } from './nutrition.js';
import { checkBusinessHours, checkReservationSlot, pickStore, planPickup, renderPickupPlan } from './pickup.js';
import { McdError } from './errors.js';
import type { BeType } from './types.js';
import type { MacroPresetName } from './constraints.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
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
    const r = compileOrder(menu, nutri, channel, c, { topK: 3 });
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

    const candidates = Object.entries(menu.meals)
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

  console.log(`未知命令：${cmd}
可用命令：menu / compile / nutrition / pickup`);
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
