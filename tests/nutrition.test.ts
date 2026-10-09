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

  it('真实菜单的匹配覆盖率 > 40%', () => {
    const views = buildMealViews(loadMenu(), loadNutrition());
    const hit = views.filter((v) => v.nutritionMatch !== 'none');
    expect(hit.length / views.length).toBeGreaterThan(0.4);
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
