import { describe, expect, it } from 'vitest';
import { compileOrder, checkCombo, ruleForBudget, renderResult } from '../src/compiler.js';
import {
  ALLERGEN_RULES,
  applyHardFilters,
  buildMealViews,
  defaultConstraints,
  extractConstraints,
  type Constraints,
} from '../src/constraints.js';
import { CHANNEL, loadMenu, loadNutrition } from './helpers.js';

const menu = loadMenu();
const nutri = loadNutrition();

function withC(patch: Partial<Constraints>): Constraints {
  return { ...defaultConstraints(), ...patch };
}

describe('预算搭配规则', () => {
  it('按预算落到官方规则档位', () => {
    expect(ruleForBudget(15).label).toContain('20元以下');
    expect(ruleForBudget(25).label).toContain('20-30元');
    expect(ruleForBudget(35).label).toContain('30-40元');
    expect(ruleForBudget(45).label).toContain('40-50元');
    expect(ruleForBudget(80).label).toContain('50元以上');
  });
});

describe('预算 + 偏好编译器', () => {
  it('在 35 元预算内给出主食+小食+饮料组合', () => {
    const c = withC({ budgetMax: 35, requiredSlots: ['main', 'side', 'drink'], itemCount: { min: 3, max: 3 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    expect(r.feasible).toBe(true);
    const best = r.combos[0]!;
    expect(best.items).toHaveLength(3);
    expect(best.totalPrice).toBeLessThanOrEqual(35);
    expect(checkCombo(best, c, r.plan.slots)).toHaveLength(0);
  });

  it('过敏原约束为硬约束，组合中绝不出现相关餐品', () => {
    const c = withC({ budgetMax: 60, allergens: ['牛奶'], requiredSlots: ['main', 'drink'], itemCount: { min: 2, max: 2 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    expect(r.feasible).toBe(true);
    for (const combo of r.combos) {
      for (const it of combo.items) {
        expect(it.excluded).toHaveLength(0);
        // 牛奶规则词：奶/芝士/奶油/拿铁/冰淇淋/麦旋风/新地
        expect(/奶|芝士|奶酪|奶油|拿铁|冰淇淋|麦旋风|新地/.test(it.name)).toBe(false);
      }
    }
  });

  it('素食约束排除所有含肉餐品', () => {
    const c = withC({ budgetMax: 40, vegetarian: true, requiredSlots: ['side'], itemCount: { min: 1, max: 2 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    if (r.feasible) {
      for (const it of r.combos[0]!.items) {
        expect(/鸡|牛|猪|鱼|虾|火腿|培根|烟肉|安格斯/.test(it.name)).toBe(false);
      }
    } else {
      // 该门店可能确实没有纯素小食，此时必须给出替代方案说明
      expect(r.alternative).toBeDefined();
    }
  });

  it('热量上限被严格遵守', () => {
    const c = withC({ budgetMax: 45, calorieMax: 600, requiredSlots: ['main', 'drink'], itemCount: { min: 2, max: 2 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    if (r.feasible) {
      for (const combo of r.combos) expect(combo.total.energyKcal).toBeLessThanOrEqual(600);
    } else {
      expect(r.alternative).toBeDefined();
      expect(r.violations.length).toBeGreaterThan(0);
    }
  });

  it('预算不可能满足时给出最接近替代方案并说明放宽项', () => {
    // 1 元预算 + 三件套，物理上不可能
    const c = withC({ budgetMax: 1, requiredSlots: ['main', 'side', 'drink'], itemCount: { min: 3, max: 3 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    expect(r.feasible).toBe(false);
    expect(r.alternative).toBeDefined();
    expect(r.alternative!.relaxed.length).toBeGreaterThan(0);
    expect(r.alternative!.reason).not.toBe('');
    expect(r.violations.length).toBeGreaterThan(0);
    expect(renderResult(r)).toContain('最接近的替代方案');
  });

  it('松弛阶梯不会放宽过敏原', () => {
    const c = withC({ budgetMax: 1, allergens: ['花生'], requiredSlots: ['main'], itemCount: { min: 1, max: 1 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    expect(r.alternative!.kept).toContain('过敏原「花生」');
    for (const it of r.alternative!.combo.items) expect(it.excluded).toHaveLength(0);
  });

  it('口味偏好只影响排序，不作为硬过滤', () => {
    const c = withC({ budgetMax: 40, tastes: ['辣'], requiredSlots: ['main'], itemCount: { min: 1, max: 1 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    expect(r.feasible).toBe(true);
    // 命中辣的第一名应该优先
    expect(r.combos[0]!.score).toBeGreaterThanOrEqual(r.combos[r.combos.length - 1]!.score);
  });

  it('查询计划可直接下发 MCP（含通道参数与排除清单）', () => {
    const c = withC({ budgetMax: 35, allergens: ['海鲜'], requiredSlots: ['main', 'side'] });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    const qm = r.plan.mcpCalls.find((x) => x.tool === 'query-meals')!;
    expect(qm.args['storeCode']).toBe('1420762');
    expect(qm.args['orderType']).toBe(1);
    expect(qm.args['beType']).toBe(1);
    expect(qm.args['beCode']).toBeUndefined(); // 到店自取禁止传 beCode
    expect(r.plan.excludeCodes.length).toBeGreaterThan(0);
    expect(r.plan.mcpCalls.some((x) => x.tool === 'list-nutrition-foods')).toBe(true);
  });

  it('营养数据缺失不影响求解，只做标注', () => {
    const c = withC({ budgetMax: 30, requiredSlots: ['main'], itemCount: { min: 1, max: 1 } });
    const r = compileOrder(menu, [], CHANNEL, c);
    expect(r.feasible).toBe(true);
    expect(r.combos[0]!.total.energyKcal).toBe(0);
  });
});

describe('套餐（三件套）处理', () => {
  it('套餐不参与逐槽位凑单：含套餐的方案一定是单件', () => {
    const c = withC({ budgetMax: 40, requiredSlots: ['main', 'side', 'drink'], itemCount: { min: 3, max: 3 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    expect(r.feasible).toBe(true);
    for (const combo of r.combos) {
      const hasCombo = combo.items.some((i) => i.isCombo);
      if (hasCombo) expect(combo.items).toHaveLength(1);
    }
  });

  it('套餐自身覆盖主食+小食+饮料三个槽位', () => {
    const c = withC({ budgetMax: 40, requiredSlots: ['main', 'side', 'drink'], itemCount: { min: 3, max: 3 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    const comboOnly = r.combos.find((x) => x.items.length === 1 && x.items[0]!.isCombo);
    if (comboOnly) {
      const slots = new Set(comboOnly.items[0]!.slots);
      expect(slots.has('main')).toBe(true);
      expect(slots.has('side')).toBe(true);
      expect(slots.has('drink')).toBe(true);
    }
  });
});

describe('极端约束下的健壮性', () => {
  it('预算极小时仍能给出替代方案（剪枝自动回退）', () => {
    const c = withC({ budgetMax: 0.5, requiredSlots: ['main', 'side', 'drink'], itemCount: { min: 3, max: 3 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    expect(r.feasible).toBe(false);
    expect(r.alternative).toBeDefined();
    expect(r.alternative!.combo.items.length).toBeGreaterThan(0);
  });

  it('热量上限极小时仍能给出替代方案', () => {
    const c = withC({ calorieMax: 1, requiredSlots: ['main'], itemCount: { min: 1, max: 1 } });
    const r = compileOrder(menu, nutri, CHANNEL, c);
    expect(r.alternative).toBeDefined();
  });

  it('关闭松弛时明确返回违规而不编造方案', () => {
    const c = withC({ budgetMax: 1, requiredSlots: ['main'], itemCount: { min: 1, max: 1 } });
    const r = compileOrder(menu, nutri, CHANNEL, c, { allowRelax: false });
    expect(r.feasible).toBe(false);
    expect(r.combos).toHaveLength(0);
    expect(r.alternative).toBeUndefined();
    expect(r.violations.length).toBeGreaterThan(0);
  });
});

describe('自然语言槽位提取', () => {
  it('解析预算与热量', () => {
    const c = extractConstraints('我预算35块钱以内，热量不要超过600大卡');
    expect(c.budgetMax).toBe(35);
    expect(c.calorieMax).toBe(600);
  });

  it('解析中文数字预算', () => {
    const c = extractConstraints('预算三十元以内');
    expect(c.budgetMax).toBe(30);
  });

  it('解析过敏原与忌口', () => {
    const c = extractConstraints('我对牛奶过敏，不要洋葱，想吃辣的');
    expect(c.allergens).toContain('牛奶');
    expect(c.avoid).toContain('洋葱');
    expect(c.tastes).toContain('辣');
  });

  it('解析健身场景的高蛋白预设', () => {
    const c = extractConstraints('健身增肌，蛋白质至少30g，预算50元');
    expect(c.macroPreset).toBe('highProtein');
    expect(c.proteinMin).toBe(30);
    expect(c.budgetMax).toBe(50);
  });

  it('解析槽位与件数', () => {
    const c = extractConstraints('来一个汉堡、一份薯条和一杯可乐，三件');
    expect(c.requiredSlots).toEqual(expect.arrayContaining(['main', 'side', 'drink']));
    expect(c.itemCount).toEqual({ min: 3, max: 3 });
  });
});

describe('过敏原硬过滤（安全红线 · 回归锁死）', () => {
  // 「吉士」是麦当劳对 cheese 的音译（吉士汉堡 = cheeseburger）。
  // 历史缺陷：ALLERGEN_RULES.牛奶 曾漏掉该词，导致
  //   吉士汉堡包套餐 ¥26 / 双层吉士汉堡 ¥23 / 双层吉士汉堡套餐 ¥34 / 高达吉士双牛堡 ¥22.5
  // 全部通过牛奶过敏过滤并被推荐 —— 对过敏用户构成真实伤害。
  // 以下用例锁死该行为，防止后续修改关键词表时再次退化。
  const views = buildMealViews(menu, []);

  const cheeseProducts: [string, string][] = [
    ['9900005449', '吉士汉堡包套餐'],
    ['1120', '双层吉士汉堡'],
    ['9900005464', '双层吉士汉堡套餐'],
    ['521316', '高达吉士双牛堡'],
  ];

  // 名称里没有「奶/冰淇淋」但实为乳制品，容易被漏掉
  const hiddenDairy: [string, string][] = [
    ['521951', '灰焰圆筒（冰淇淋甜筒）'],
    ['514851', '咖啡阿芙佳朵（咖啡+冰淇淋）'],
    ['9900008752', '派'],
    ['521797', '北美招牌牧场酱（ranch，含动物奶油）'],
  ];

  it('牛奶过敏必须排除全部「吉士」产品', () => {
    const excluded = applyHardFilters(views, withC({ allergens: ['牛奶'] }));
    for (const [code, name] of cheeseProducts) {
      expect(excluded.has(code), `「${name}」(${code}) 含奶酪，牛奶过敏必须排除`).toBe(true);
    }
  });

  it('牛奶过敏排除名称不含「奶」的隐含乳制品', () => {
    const excluded = applyHardFilters(views, withC({ allergens: ['牛奶'] }));
    for (const [code, name] of hiddenDairy) {
      expect(excluded.has(code), `「${name}」(${code}) 实为乳制品，牛奶过敏必须排除`).toBe(true);
    }
  });

  it('忌口芝士同样排除「吉士」产品', () => {
    const excluded = applyHardFilters(views, withC({ avoid: ['芝士'] }));
    for (const [code, name] of cheeseProducts) {
      expect(excluded.has(code), `「${name}」(${code}) 应被忌口芝士排除`).toBe(true);
    }
  });

  it('未声明牛奶过敏时不应误杀吉士产品', () => {
    const excluded = applyHardFilters(views, withC({}));
    for (const [code, name] of cheeseProducts) {
      expect(excluded.has(code), `「${name}」(${code}) 不应被无谓排除`).toBe(false);
    }
  });

  // 契约测试：这些词都是踩过坑才补进去的，删掉任何一个都会造成真实漏判。
  // （fixtures 是白天菜单快照，不含巧克力味厚松饼等早餐品，故在此锁关键词而非具体 code）
  it('牛奶关键词表必须包含全部已确认的高危词', () => {
    const must = [
      '吉士', // cheese 音译：吉士汉堡 = cheeseburger
      '起司',
      '干酪',
      '乳酪',
      '圆筒', // 冰淇淋甜筒
      '阿芙佳朵', // 咖啡 + 冰淇淋
      '派', // 烘焙配料含乳
      '牧场', // ranch，含动物奶油
      '巧克力', // 奶巧
      '朱古力',
      '可可',
      '黄油',
      '酸奶',
      '慕斯',
    ];
    for (const w of must) {
      expect(ALLERGEN_RULES['牛奶'], `牛奶规则缺少关键词「${w}」`).toContain(w);
    }
  });
});
