import { describe, expect, it } from 'vitest';
import {
  MACRO_PRESETS,
  actualRatio,
  buildNutritionIndex,
  macroGrams,
  matchNutrition,
  normalizeName,
  parseNutritionTable,
  planNutrition,
  sumNutrition,
} from '../src/nutrition.js';
import { buildMealViews } from '../src/constraints.js';
import { loadMenu, loadNutrition } from './helpers.js';

const RAW = `[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
  巨无霸,null,2146,513,27,26,42,961,171
  中薯条,null,1210,289,4,12,38,165,18`;

describe('营养紧凑表格解析', () => {
  it('解析表头与数据行', () => {
    const list = parseNutritionTable(RAW);
    expect(list).toHaveLength(3);
    const big = list.find((n) => n.productName === '巨无霸')!;
    expect(big.energyKcal).toBe(513);
    expect(big.protein).toBe(27);
    expect(big.fat).toBe(26);
    expect(big.carbohydrate).toBe(42);
    expect(big.sodium).toBe(961);
    expect(big.calcium).toBe(171);
    expect(big.nutritionDescription).toBeNull();
  });

  it('真实数据 160 条全部解析成功', () => {
    const list = loadNutrition();
    expect(list.length).toBe(160);
    expect(list.every((n) => n.productName.length > 0)).toBe(true);
    expect(list.every((n) => Number.isFinite(n.energyKcal))).toBe(true);
  });
});

describe('名称归一化与匹配', () => {
  it('去噪点字符与全角', () => {
    expect(normalizeName('【美汁源】“黄金橙橙”')).toBe('美汁源黄金橙橙');
    expect(normalizeName('麦咖啡™冰奶铁中杯')).toBe('麦咖啡冰奶铁中杯');
  });

  it('菜单名可精确命中营养表', () => {
    const idx = buildNutritionIndex(loadNutrition());
    const m = matchNutrition('巨无霸', idx);
    expect(m?.level).toBe('exact');
    expect(m?.nutrition.energyKcal).toBe(513);
  });

  it('真实菜单中单品的匹配覆盖率 > 40%', () => {
    // 只统计单品：套餐的营养**不允许**按名称匹配（会命中单品数值，
    // 「培根蔬萃双层牛堡三件套」442 vs 真实 878），必须拆子项加总。
    const views = buildMealViews(loadMenu(), loadNutrition()).filter((v) => !v.isCombo);
    const hit = views.filter((v) => v.nutritionMatch !== 'none');
    expect(hit.length / views.length).toBeGreaterThan(0.4);
  });

  it('套餐不得按名称匹配营养（避免低估近一倍）', () => {
    const views = buildMealViews(loadMenu(), loadNutrition());
    const combos = views.filter((v) => v.isCombo);
    expect(combos.length).toBeGreaterThan(0);
    for (const c of combos) {
      expect(c.nutrition, `套餐「${c.name}」不应有名称匹配的营养`).toBeNull();
      expect(c.nutritionMatch).toBe('none');
    }
  });
});

describe('三大营养素换算', () => {
  it('按供能比换算克数', () => {
    const g = macroGrams({ kcal: 600, ratio: MACRO_PRESETS.highProtein! });
    // 蛋白 35% -> 210 kcal / 4 = 52.5g
    expect(g.protein).toBeCloseTo(52.5, 1);
    // 碳水 40% -> 240 / 4 = 60g
    expect(g.carb).toBeCloseTo(60, 1);
    // 脂肪 25% -> 150 / 9 ≈ 16.67g
    expect(g.fat).toBeCloseTo(16.67, 1);
  });

  it('反算供能比求和为 1', () => {
    const r = actualRatio({ protein: 27, carbohydrate: 42, fat: 26 });
    expect(r.protein + r.carb + r.fat).toBeCloseTo(1, 5);
  });

  it('求和聚合', () => {
    const list = loadNutrition();
    const two = sumNutrition([list[0]!, list[1]!]);
    expect(two.energyKcal).toBe(list[0]!.energyKcal + list[1]!.energyKcal);
  });
});

describe('营养搭配求解', () => {
  it('给出贴近目标热量的组合', () => {
    const nutri = loadNutrition();
    const idx = buildNutritionIndex(nutri);
    const candidates = ['板烧鸡腿堡', '中薯条', '可乐中杯', '玉米杯小杯', '麦乐鸡5块']
      .map((name) => {
        const m = matchNutrition(name, idx);
        return m ? { code: name, name, nutrition: m.nutrition, match: m.level === 'exact' ? ('exact' as const) : ('contains' as const) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const plans = planNutrition(candidates, { kcal: 700, ratio: MACRO_PRESETS.balanced! }, { maxItems: 3, topK: 3 });
    expect(plans.length).toBeGreaterThan(0);
    const best = plans[0]!;
    expect(best.total.energyKcal).toBeGreaterThanOrEqual(700 * 0.85);
    expect(best.total.energyKcal).toBeLessThanOrEqual(700 * 1.15);
    expect(best.deviation).toBeLessThan(0.6);
  });

  it('目标热量过小时回落到最接近的替代方案并说明原因', () => {
    const nutri = loadNutrition();
    const idx = buildNutritionIndex(nutri);
    const m = matchNutrition('巨无霸', idx)!;
    const plans = planNutrition([{ code: 'x', name: '巨无霸', nutrition: m.nutrition, match: 'exact' }], { kcal: 100, ratio: MACRO_PRESETS.balanced! });
    expect(plans.length).toBe(1);
    expect(plans[0]!.notes.join()).toContain('没有找到落在');
  });

  it('高钠组合会给出提示', () => {
    const nutri = loadNutrition();
    const idx = buildNutritionIndex(nutri);
    const pick = (n: string) => {
      const m = matchNutrition(n, idx)!;
      return { code: n, name: n, nutrition: m.nutrition, match: 'exact' as const };
    };
    const plans = planNutrition([pick('巨无霸'), pick('麦辣鸡腿汉堡'), pick('大薯条')], { kcal: 1400, ratio: MACRO_PRESETS.balanced! }, { maxItems: 3 });
    const any = plans.find((p) => p.notes.some((n) => n.includes('钠')));
    expect(any).toBeDefined();
  });
});

describe('目标不可达与异常达成率必须明说（回归锁死）', () => {
  // 用固定三件构造确定场景，避免依赖真实菜单波动
  const cand = (name: string, kcal: number, p: number, f: number, c: number) => ({
    code: name,
    name,
    nutrition: {
      productName: name,
      nutritionDescription: null,
      energyKj: kcal * 4.184,
      energyKcal: kcal,
      protein: p,
      fat: f,
      carbohydrate: c,
      sodium: 0,
      calcium: 0,
    },
    match: 'exact' as const,
  });

  it('蛋白未达目标 75% 时必须输出「不可达」提示', () => {
    // 高蛋白目标 600kcal → 蛋白 52.5g；给一堆低蛋白餐品，必然不可达
    const plans = planNutrition(
      [cand('低蛋白A', 300, 5, 10, 40), cand('低蛋白B', 300, 5, 10, 40)],
      { kcal: 600, ratio: MACRO_PRESETS['highProtein']! },
      { maxItems: 2, topK: 1 },
    );
    expect(plans.length).toBeGreaterThan(0);
    const joined = plans[0]!.notes.join(' ');
    expect(joined).toContain('不可达');
    expect(joined).toMatch(/蛋白目标 \d+g 不可达/);
  });

  it('脂肪严重超标（>150%）时必须单独点名', () => {
    // 目标脂肪 = 600 × 0.25 / 9 ≈ 16.7g；给一份 40g 脂肪的，达成率约 240%
    const plans = planNutrition(
      [cand('高脂A', 300, 20, 25, 10), cand('高脂B', 300, 20, 25, 10)],
      { kcal: 600, ratio: MACRO_PRESETS['highProtein']! },
      { maxItems: 2, topK: 1 },
    );
    expect(plans.length).toBeGreaterThan(0);
    const joined = plans[0]!.notes.join(' ');
    expect(joined).toMatch(/脂肪达成率 \d+%/);
    expect(joined).toContain('严重超标');
  });

  it('超出默认热量窗口的方案必须标注放宽幅度', () => {
    // 600kcal 默认窗口上限 690；这里组合到 ~720，落在 +25%(=750) 内
    const plans = planNutrition(
      [cand('甲', 360, 25, 15, 30), cand('乙', 360, 25, 15, 30)],
      { kcal: 600, ratio: MACRO_PRESETS['highProtein']! },
      { maxItems: 2, topK: 3 },
    );
    const over = plans.filter((p) => p.total.energyKcal > 600 * 1.15);
    expect(over.length).toBeGreaterThan(0);
    const joined = over[0]!.notes.join(' ');
    expect(joined).toContain('超出默认窗口上限');
    expect(joined).toContain('+25%');
  });

  it('超过 +25% 放宽上限的组合一律丢弃', () => {
    const plans = planNutrition(
      [cand('大A', 400, 30, 18, 34), cand('大B', 400, 30, 18, 34)],
      { kcal: 600, ratio: MACRO_PRESETS['highProtein']! },
      { maxItems: 2, topK: 5 },
    );
    for (const p of plans) {
      expect(p.total.energyKcal, `方案热量 ${p.total.energyKcal} 超出 +25% 上限`).toBeLessThanOrEqual(600 * 1.25);
    }
  });
});
