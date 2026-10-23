/**
 * 预算 + 偏好点餐编译器
 *
 * 流程：
 *   自然语言约束 -> ①编译成可执行查询条件(QueryPlan) -> ②在菜单上执行筛选 -> ③组合搜索求解
 *                 -> ④无解时按「松弛阶梯」逐级放宽，给出最接近的替代方案并说明原因
 *
 * 安全红线：过敏原约束任何情况下都不参与松弛。
 */

import type { ChannelParams, Menu, Nutrition } from './types.js';
import {
  type Constraints,
  type MealView,
  type SlotName,
  SLOT_LABEL,
  TASTE_RULES,
  applyHardFilters,
  buildMealViews,
} from './constraints.js';
import { actualRatio, macroGrams, MACRO_PRESETS, normalizeName } from './nutrition.js';

/* ------------------------------------------------------------------ */
/* 官方搭配规则（来自 query-meals 工具说明）                              */
/* ------------------------------------------------------------------ */

export interface BudgetRule {
  max: number;
  label: string;
  slots: SlotName[];
}

export const BUDGET_RULES: BudgetRule[] = [
  { max: 20, label: '20元以下：小食为主', slots: ['side'] },
  { max: 30, label: '20-30元：汉堡+小食 或 汉堡+饮料', slots: ['main', 'side'] },
  { max: 40, label: '30-40元：汉堡+薯条/小食+饮料', slots: ['main', 'side', 'drink'] },
  { max: 50, label: '40-50元：汉堡+薯条+小食+饮料', slots: ['main', 'side', 'side', 'drink'] },
  { max: Number.POSITIVE_INFINITY, label: '50元以上：丰富组合，优先不重复小食', slots: ['main', 'side', 'side', 'drink', 'dessert'] },
];

export function ruleForBudget(budget?: number): BudgetRule {
  if (!budget || budget <= 0) return BUDGET_RULES[BUDGET_RULES.length - 1]!;
  return BUDGET_RULES.find((r) => budget < r.max) ?? BUDGET_RULES[BUDGET_RULES.length - 1]!;
}

/* ------------------------------------------------------------------ */
/* 查询计划                                                            */
/* ------------------------------------------------------------------ */

export interface QueryPlan {
  /** 直接可作为 mcd-mcp 工具入参的通道参数 */
  channel: ChannelParams;
  /** 价格区间（元） */
  priceRange?: { min: number; max: number };
  /** 需要填充的槽位 */
  slots: SlotName[];
  /** 硬过滤掉的餐品编码 */
  excludeCodes: string[];
  /** 每个被排除餐品的原因 */
  excludeReasons: Record<string, string[]>;
  /** 命中预算搭配规则 */
  budgetRule: BudgetRule;
  /** 软偏好（只影响打分） */
  softTastes: string[];
  /** 可直接下发给 MCP 的调用序列 */
  mcpCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  candidateCount: number;
  notes: string[];
}

export function compileQuery(c: Constraints, views: MealView[], channel: ChannelParams): QueryPlan {
  const notes: string[] = [];
  const excludeReasons = Object.fromEntries(applyHardFilters(views, c));
  const excludeCodes = Object.keys(excludeReasons);

  // 槽位：用户显式指定优先；否则用预算规则推导
  let slots: SlotName[] = c.requiredSlots.length ? [...c.requiredSlots] : ruleForBudget(c.budgetMax).slots;
  // 去重但允许 side 出现两次（规则里 40-50 元有两个小食）
  slots = dedupeSlots(slots);
  if (slots.length > c.itemCount.max) {
    slots = slots.slice(0, Math.max(1, c.itemCount.max));
    notes.push(`预算规则建议 ${c.requiredSlots.length ? '' : ''}${slots.length} 件，已按件数上限裁剪。`);
  }
  if (c.itemCount.min > slots.length) {
    notes.push(`要求的槽位数量 ${slots.length} 少于最少件数 ${c.itemCount.min}，将补充其它餐品凑单。`);
  }

  const priceRange = c.budgetMax ? { min: c.budgetMin ?? 0, max: c.budgetMax } : undefined;

  const mcpCalls: QueryPlan['mcpCalls'] = [
    {
      tool: 'query-meals',
      args: {
        storeCode: channel.storeCode,
        orderType: channel.orderType,
        beType: channel.beType,
        ...(channel.beType !== 1 && channel.beCode ? { beCode: channel.beCode } : {}),
        ...(channel.reservationDate ? { reservationDate: channel.reservationDate } : {}),
      },
    },
    { tool: 'list-nutrition-foods', args: {} },
  ];
  if (c.budgetMax) {
    mcpCalls.push({ tool: 'query-store-coupons', args: { storeCode: channel.storeCode, orderType: channel.orderType, beType: channel.beType } });
  }

  return {
    channel,
    priceRange,
    slots,
    excludeCodes,
    excludeReasons,
    budgetRule: ruleForBudget(c.budgetMax),
    softTastes: c.tastes,
    mcpCalls,
    candidateCount: views.length - excludeCodes.length,
    notes,
  };
}

function dedupeSlots(slots: SlotName[]): SlotName[] {
  const out: SlotName[] = [];
  const seen = new Map<SlotName, number>();
  for (const s of slots) {
    const n = (seen.get(s) ?? 0) + 1;
    seen.set(s, n);
    // 同一槽位最多保留 2 个（40-50 元规则允许双小食）
    if (n <= 2) out.push(s);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 组合与评估                                                          */
/* ------------------------------------------------------------------ */

export interface Combo {
  items: MealView[];
  totalPrice: number;
  originalPrice: number;
  savedAmount: number;
  total: Nutrition;
  /** 供能比 */
  ratio: { protein: number; carb: number; fat: number };
  tasteHits: string[];
  /** 命中的预算搭配规则描述 */
  ruleLabel: string;
  score: number;
  /** 命中的硬约束说明（用于解释为什么选它） */
  reasons: string[];
  /** 未命中营养数据的餐品 */
  missingNutrition: string[];
}

export interface Violation {
  field: 'budget' | 'calorie' | 'sodium' | 'protein' | 'slots' | 'itemCount' | 'stock';
  message: string;
  /** 超出/缺口多少 */
  delta?: number;
}

function emptyNutrition(): Nutrition {
  return { productName: '', nutritionDescription: null, energyKj: 0, energyKcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, calcium: 0 };
}

function sumOf(items: MealView[]): Nutrition {
  return items.reduce<Nutrition>(
    (acc, it) => {
      const n = it.nutrition;
      if (!n) return acc;
      return {
        productName: '',
        nutritionDescription: null,
        energyKj: acc.energyKj + n.energyKj,
        energyKcal: acc.energyKcal + n.energyKcal,
        protein: acc.protein + n.protein,
        fat: acc.fat + n.fat,
        carbohydrate: acc.carbohydrate + n.carbohydrate,
        sodium: acc.sodium + n.sodium,
        calcium: acc.calcium + n.calcium,
      };
    },
    emptyNutrition(),
  );
}

/**
 * 用户**点名**的具体品类（「想有可乐和薯条」）权重高于泛口味偏好。
 *
 * 原因：泛偏好是「倾向」，点名是「我要这个」。若都按 10 分算，
 * 一个省 ¥13 的套餐（套餐奖励 12 + 省钱 15）会压过「汉堡+薯条+可乐」的
 * 正确组合（品类命中仅 20），用户就拿不到自己说的东西。
 */
const NAMED_ITEM_WEIGHT: Record<string, number> = {
  可乐: 16,
  薯条: 16,
};

function tasteScore(items: MealView[], tastes: string[]): { hits: string[]; score: number } {
  const hits = new Set<string>();
  let score = 0;
  // 每个偏好**只计一次**。此前是每个命中餐品都加 10，导致
  // 「低卡」在玉米杯、无糖可乐上各加一次（+20），把用户点名的「薯条」压下去。
  // 偏好是「这套餐有没有满足」，不是「命中了几件」。
  for (const t of tastes) {
    const words = TASTE_RULES[t] ?? [t];
    const hit = items.some((it) => {
      const text = normalizeName([it.name, ...it.tags, ...it.categories].join('|'));
      return words.some((w) => text.includes(normalizeName(w)));
    });
    if (hit) {
      hits.add(t);
      score += NAMED_ITEM_WEIGHT[t] ?? 10;
    }
  }
  return { hits: [...hits], score };
}

export function evaluateCombo(items: MealView[], c: Constraints, rule: BudgetRule): Combo {
  const totalPrice = round2(items.reduce((s, i) => s + i.price, 0));
  const originalPrice = round2(items.reduce((s, i) => s + (i.originalPrice || i.price), 0));
  const total = sumOf(items);
  const ratio = actualRatio(total);
  const { hits, score: tScore } = tasteScore(items, c.tastes);
  const missingNutrition = items.filter((i) => !i.nutrition).map((i) => i.name);

  const reasons: string[] = [];
  let score = tScore;

  // 减脂意图：用户明确说了「减肥/低卡/减脂」时，排序取向要变
  const lowCalIntent = c.tastes.includes('低卡');

  // 预算利用率：越接近上限越好，但不越界
  //
  // 权重随意图变化：减脂用户的首要目标是热量，不是把预算花满。
  // 若仍给 40 分权重，「省 ¥29 的 707 kcal 厚牛堡」会压过「贵 ¥8 的 600 kcal 组合」——
  // 实测就是这个问题。
  if (c.budgetMax) {
    const util = totalPrice / c.budgetMax;
    const w = lowCalIntent ? 15 : 40;
    score += Math.max(0, w * (1 - Math.abs(1 - util)));
    if (util <= 1) reasons.push(`预算利用率 ${(util * 100).toFixed(0)}%`);
  }
  // 折扣
  const saved = round2(Math.max(0, originalPrice - totalPrice));
  if (saved > 0) {
    score += Math.min(15, saved * 1.5);
    reasons.push(`较原价省 ¥${saved.toFixed(1)}`);
  }
  // 热量
  //
  // 两种情况取向相反：
  //   · 只给了上限、没提减脂 → 「贴近上限」更实在（用户想吃够这个量）
  //   · 明确说了减肥/低卡     → 上限是天花板不是目标，但**也不是越低越好**
  //
  // 实测教训：第一版按「越低越好」排，结果 Top-1 是 213 kcal 的麦乐鸡套餐 ——
  // 那是挨饿不是减肥。800 kcal 的 50%（=400）作为「一顿正餐」的合理下限，
  // 低于它扣分，高于它在区间内越低越好。
  if (c.calorieMax) {
    const fill = total.energyKcal / c.calorieMax;
    if (fill <= 1) {
      if (lowCalIntent) {
        const minMeal = c.calorieMax * 0.5;
        if (total.energyKcal < minMeal) {
          score -= 40; // 明显不足一顿正餐，压到后面
          reasons.push(`${Math.round(total.energyKcal)} kcal，不足一顿正餐（建议 ≥ ${Math.round(minMeal)}）`);
        } else {
          score += 30 * (1 - fill);
          reasons.push(`${Math.round(total.energyKcal)} kcal，低于上限 ${c.calorieMax}`);
        }
      } else {
        score += 20 * fill;
      }
    } else {
      score -= 60 * (fill - 1);
    }
  }
  // 配比
  if (c.macroPreset) {
    const p = MACRO_PRESETS[c.macroPreset];
    if (p) {
      const dev = Math.abs(ratio.protein - p.protein) + Math.abs(ratio.carb - p.carb) + Math.abs(ratio.fat - p.fat);
      score -= dev * 30;
    }
  }
  // 蛋白质下限
  if (c.proteinMin && total.protein >= c.proteinMin) {
    score += 15;
    reasons.push(`蛋白质 ${total.protein.toFixed(0)} g，达标`);
  }
  // 钠上限
  if (c.sodiumMax && total.sodium > c.sodiumMax) score -= 40;
  // 营养数据缺失轻微惩罚
  score -= missingNutrition.length * 5;
  // 件数接近目标
  if (items.length >= c.itemCount.min && items.length <= c.itemCount.max) score += 5;
  // 套餐本身即完整解：鼓励「一份套餐搞定」，避免无意义凑单
  if (items.length === 1 && items[0]!.isCombo) {
    score += 12;
    reasons.push('套餐已含主食+小食+饮料，无需凑单');
  }

  return {
    items: [...items],
    totalPrice,
    originalPrice,
    savedAmount: saved,
    total,
    ratio,
    tasteHits: hits,
    ruleLabel: rule.label,
    score: round2(score),
    reasons,
    missingNutrition,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export function checkCombo(combo: Combo, c: Constraints, planSlots: SlotName[]): Violation[] {
  const v: Violation[] = [];
  if (c.budgetMax && combo.totalPrice > c.budgetMax + 1e-6) {
    v.push({ field: 'budget', message: `总价 ¥${combo.totalPrice.toFixed(1)} 超出预算 ¥${c.budgetMax}`, delta: round2(combo.totalPrice - c.budgetMax) });
  }
  if (c.budgetMin && combo.totalPrice < c.budgetMin) {
    v.push({ field: 'budget', message: `总价 ¥${combo.totalPrice.toFixed(1)} 低于预算下限 ¥${c.budgetMin}`, delta: round2(c.budgetMin - combo.totalPrice) });
  }
  if (c.calorieMax && combo.total.energyKcal > c.calorieMax + 1e-6) {
    v.push({ field: 'calorie', message: `热量 ${Math.round(combo.total.energyKcal)} kcal 超出上限 ${c.calorieMax} kcal`, delta: Math.round(combo.total.energyKcal - c.calorieMax) });
  }
  if (c.sodiumMax && combo.total.sodium > c.sodiumMax + 1e-6) {
    v.push({ field: 'sodium', message: `钠 ${Math.round(combo.total.sodium)} mg 超出上限 ${c.sodiumMax} mg`, delta: Math.round(combo.total.sodium - c.sodiumMax) });
  }
  if (c.proteinMin && combo.total.protein < c.proteinMin - 1e-6) {
    v.push({ field: 'protein', message: `蛋白质 ${combo.total.protein.toFixed(0)} g 低于下限 ${c.proteinMin} g`, delta: round2(c.proteinMin - combo.total.protein) });
  }
  if (combo.items.length < c.itemCount.min || combo.items.length > c.itemCount.max) {
    v.push({ field: 'itemCount', message: `件数 ${combo.items.length} 不在 ${c.itemCount.min}~${c.itemCount.max} 区间` });
  }
  for (const s of planSlots) {
    const need = planSlots.filter((x) => x === s).length;
    const got = combo.items.filter((i) => i.slots.includes(s)).length;
    if (got < need) {
      v.push({ field: 'slots', message: `缺少${SLOT_LABEL[s]}（需要 ${need} 件，实际 ${got} 件）` });
    }
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* 搜索                                                               */
/* ------------------------------------------------------------------ */

const POOL_LIMIT = 14; // 每槽位候选上限，控制搜索规模
/** 剪枝上界系数：需覆盖松弛阶梯的最大累计放宽幅度（1.1 × 1.25 = 1.375） */
const PRUNE_SCALE = 1.5;

/**
 * 槽位候选池。
 * 注意：套餐（三件套等）不进槽位池——它本身已是完整组合，
 * 若参与逐槽位凑单会出现「三件套 + 饮料」这种重复搭配。
 */
function poolForSlot(views: MealView[], slot: SlotName, c: Constraints): MealView[] {
  const ok = views.filter(
    (v) =>
      v.excluded.length === 0 &&
      !v.isCombo &&
      v.slots.includes(slot) &&
      // 有热量约束时，营养数据缺失的餐品无法校验，不能「静默通过」
      (!c.calorieMax || v.nutrition !== null),
  );
  ok.sort((a, b) => preScore(b, c) - preScore(a, c));
  return ok.slice(0, POOL_LIMIT);
}

function preScore(v: MealView, c: Constraints): number {
  let s = 0;
  const text = normalizeName([v.name, ...v.tags, ...v.categories].join('|'));
  for (const t of c.tastes) {
    const words = TASTE_RULES[t] ?? [t];
    if (words.some((w) => text.includes(normalizeName(w)))) s += 10;
  }
  if (v.originalPrice > v.price) s += (v.originalPrice - v.price) * 1.5;
  if (v.nutrition) {
    if (c.calorieMax) s += Math.max(0, 10 * (1 - Math.abs(v.nutrition.energyKcal / c.calorieMax - 0.4)));
    if (c.proteinMin) s += v.nutrition.protein;
  }
  if (v.tags.includes('爆款') || v.tags.includes('人气')) s += 3;
  return s;
}

export interface CompileResult {
  feasible: boolean;
  plan: QueryPlan;
  /** 满足全部硬约束的组合（按分数降序） */
  combos: Combo[];
  /** 首轮求解命中的违规（feasible=true 时为空） */
  violations: Violation[];
  /** 无解时的最接近替代方案 */
  alternative?: {
    combo: Combo;
    /** 被放宽的约束 */
    relaxed: string[];
    /** 为什么原约束无解 */
    reason: string;
    /** 仍然保留的硬约束 */
    kept: string[];
  };
  explanation: string[];
  /** 搜索统计 */
  stats: { searched: number; pruned: number };
}

type RelaxStep = { name: string; apply: (c: Constraints) => Constraints | null };

/**
 * 松弛阶梯：按「对用户体验影响从小到大」依次放宽。
 * 过敏原 / 素食 不在此列——永远不放宽。
 */
const RELAX_LADDER: RelaxStep[] = [
  {
    name: '热量上限 +10%',
    apply: (c) => (c.calorieMax ? { ...c, calorieMax: Math.round(c.calorieMax * 1.1) } : null),
  },
  {
    name: '预算上限 +10%',
    apply: (c) => (c.budgetMax ? { ...c, budgetMax: round2(c.budgetMax * 1.1) } : null),
  },
  {
    name: '件数上限 +1',
    apply: (c) => (c.itemCount.max < 5 ? { ...c, itemCount: { ...c.itemCount, max: c.itemCount.max + 1 } } : null),
  },
  {
    name: '钠上限 +20%',
    apply: (c) => (c.sodiumMax ? { ...c, sodiumMax: Math.round(c.sodiumMax * 1.2) } : null),
  },
  {
    name: '蛋白质下限 -20%',
    apply: (c) => (c.proteinMin ? { ...c, proteinMin: round2(c.proteinMin * 0.8) } : null),
  },
  {
    name: '热量上限 +25%（累计）',
    apply: (c) => (c.calorieMax ? { ...c, calorieMax: Math.round(c.calorieMax * 1.25) } : null),
  },
  {
    name: '预算上限 +25%（累计）',
    apply: (c) => (c.budgetMax ? { ...c, budgetMax: round2(c.budgetMax * 1.25) } : null),
  },
  {
    name: '放弃最少件数要求',
    apply: (c) => (c.itemCount.min > 1 ? { ...c, itemCount: { ...c.itemCount, min: 1 } } : null),
  },
];

export interface CompileOptions {
  topK?: number;
  /** 是否启用松弛阶梯，默认 true */
  allowRelax?: boolean;
  /**
   * 由调用方**下钻套餐子项**后判定不可用的餐品：code -> 原因（见 scanSubItems）。
   *
   * 为什么需要外部注入：套餐名只描述主食，名称层过滤会漏判。
   * 实测「巨无霸三件套」名称不含「堡」，却能逃过小麦过敏过滤被推荐出去，
   * 而它的主食就是巨无霸（面包胚）。必须下钻到 rounds[].choices[].name 才能拦下。
   *
   * 不在此处直接调 MCP 是为了保持 compiler 是纯函数（离线可测）。
   */
  comboExclusions?: Map<string, string>;
  /**
   * 由调用方**拆子项加总**得到的套餐真实营养（见 `nutritionOfCombo`）。
   *
   * 为什么需要：套餐名只描述主食，按名称匹配会命中单品数值
   * （「培根蔬萃双层牛堡三件套」→ 442 kcal，真实 878 kcal），
   * 用它做热量约束会把超标套餐推荐给减脂用户。
   */
  comboNutrition?: Map<string, Nutrition>;
}

/** 主入口：编译 + 求解 */
export function compileOrder(
  menu: Menu,
  nutritionList: Nutrition[],
  channel: ChannelParams,
  constraints: Constraints,
  opts: CompileOptions = {},
): CompileResult {
  const topK = opts.topK ?? 3;
  const allowRelax = opts.allowRelax ?? true;

  const views = buildMealViews(menu, nutritionList);

  // 并入外部下钻结论，复用现有排除机制（不新增分支）
  if (opts.comboExclusions?.size) {
    for (const v of views) {
      const why = opts.comboExclusions.get(v.code);
      if (why && v.excluded.length === 0) v.excluded = [why];
    }
  }

  // 并入外部拆解出的套餐真实营养（覆盖 null，不覆盖单品）
  if (opts.comboNutrition?.size) {
    for (const v of views) {
      if (!v.isCombo) continue;
      const n = opts.comboNutrition.get(v.code);
      if (n) {
        v.nutrition = n;
        v.nutritionMatch = 'contains';
      }
    }
  }

  const plan = compileQuery(constraints, views, channel);
  const explanation: string[] = [];

  const run = (
    c: Constraints,
    prune = true,
  ): { feasible: Combo[]; all: Combo[]; violations: Violation[]; stats: { searched: number; pruned: number } } => {
    const live = views.filter((v) => v.excluded.length === 0);
    const rule = ruleForBudget(c.budgetMax);
    let slots = plan.slots.length ? plan.slots : rule.slots;

    // 无主食档：官方搭配规则每档都含汉堡（主食），过敏原把主食清空后就无档可用。
    // 此时把 main 换成 side，避免退化成「只给一杯饮料」或「只给一个超预算套餐」。
    //
    // ⚠️ 注意判断条件：plan.slots 由预算规则推导，**永远非空**，
    // 不能用 `!plan.slots.length` 判断「用户没指定」——那会让这段永远不执行。
    // 正确判据是：用户**没有显式要求**主食（requiredSlots 不含 main），
    // 且主食池确实为空。
    let downgraded = false;
    if (
      slots.includes('main') &&
      !c.requiredSlots.includes('main') &&
      poolForSlot(live, 'main', c).length === 0
    ) {
      const alt = slots.map((s) => (s === 'main' ? ('side' as const) : s));
      if (alt.every((s) => poolForSlot(live, s, c).length > 0)) {
        slots = dedupeSlots(alt);
        downgraded = true;
        explanation.push(
          `⚠️ 当前约束下本店没有可用主食（已全部被过敏原/忌口规则排除），` +
            `已改用「无主食档」：以小食+饮料组合替代。这类组合热量偏低，可能不足以当一餐。`,
        );
      }
    }

    const feasible: Combo[] = [];
    const all: Combo[] = [];
    let searched = 0;
    let pruned = 0;

    // ① 套餐本身就是完整解，先独立评估
    for (const v of live.filter((x) => x.isCombo && (!c.calorieMax || x.nutrition !== null))) {
      searched++;
      const combo = evaluateCombo([v], c, rule);
      all.push(combo);
      if (checkCombo(combo, c, slots).length === 0) feasible.push(combo);
    }

    const pools = slots.map((s) => poolForSlot(live, s, c));
    if (pools.some((p) => p.length === 0)) {
      if (all.length > 0) {
        // 逐槽位凑单不可行，但套餐方案可用
        return { feasible, all, violations: feasible.length ? [] : summarizeViolations(all, c, slots), stats: { searched, pruned } };
      }
      return {
        feasible,
        all,
        violations: [{ field: 'slots', message: `槽位「${slots.map((s) => SLOT_LABEL[s]).join('+')}」在当前门店没有可用餐品（可能已售罄或被过敏原/忌口规则排除）` }],
        stats: { searched, pruned },
      };
    }

    const path: MealView[] = [];
    const used = new Set<string>();

    const dfs = (depth: number) => {
      if (depth === slots.length) {
        searched++;
        const combo = evaluateCombo(path, c, rule);
        all.push(combo);
        const v = checkCombo(combo, c, slots);
        if (v.length === 0) feasible.push(combo);
        return;
      }
      const pool = pools[depth]!;
      for (const cand of pool) {
        if (used.has(cand.code)) continue;
        // 价格剪枝（上界放宽到 PRUNE_SCALE，为后面的松弛阶梯留出空间）
        if (prune && c.budgetMax) {
          const sofar = path.reduce((s, i) => s + i.price, 0);
          if (sofar + cand.price > c.budgetMax * PRUNE_SCALE) {
            pruned++;
            continue;
          }
        }
        // 热量剪枝
        if (prune && c.calorieMax) {
          const ksofar = path.reduce((s, i) => s + (i.nutrition?.energyKcal ?? 0), 0);
          if (ksofar + (cand.nutrition?.energyKcal ?? 0) > c.calorieMax * PRUNE_SCALE) {
            pruned++;
            continue;
          }
        }
        used.add(cand.code);
        path.push(cand);
        dfs(depth + 1);
        path.pop();
        used.delete(cand.code);
      }
    };
    dfs(0);

    // 剪枝过猛导致候选全空（约束极不合理时）→ 关闭剪枝重跑，确保总能给出「最接近」的替代方案
    if (all.length === 0 && prune) return run(c, false);

    feasible.sort((a, b) => b.score - a.score);
    all.sort((a, b) => b.score - a.score);
    const violations = feasible.length === 0 && all.length > 0 ? summarizeViolations(all, c, slots) : [];
    return { feasible, all, violations, stats: { searched, pruned } };
  };

  const first = run(constraints);
  if (first.feasible.length > 0) {
    explanation.push(`命中搭配规则：${plan.budgetRule.label}`);
    if (plan.excludeCodes.length) {
      explanation.push(`已按过敏原/忌口规则排除 ${plan.excludeCodes.length} 个餐品`);
    }
    return {
      feasible: true,
      plan,
      combos: first.feasible.slice(0, topK),
      violations: [],
      explanation,
      stats: first.stats,
    };
  }

  // 无解 -> 松弛阶梯
  const keptHard = [
    ...constraints.allergens.map((a) => `过敏原「${a}」`),
    ...constraints.avoid.map((a) => `忌口「${a}」`),
    ...(constraints.vegetarian ? ['素食'] : []),
  ];
  const reason = first.violations.length
    ? first.violations.map((v) => v.message).join('；')
    : '当前门店在售餐品中不存在满足全部约束的组合';

  if (!allowRelax) {
    return {
      feasible: false,
      plan,
      combos: [],
      violations: first.violations.length ? first.violations : [{ field: 'stock', message: reason }],
      explanation: [...explanation, reason],
      stats: first.stats,
    };
  }

  let cur = constraints;
  const relaxed: string[] = [];
  let found: Combo[] = [];
  for (const step of RELAX_LADDER) {
    const next = step.apply(cur);
    if (!next) continue;
    const r = run(next);
    relaxed.push(step.name);
    if (r.feasible.length > 0) {
      found = r.feasible;
      cur = next;
      break;
    }
    cur = next;
  }

  // 阶梯全走完仍无解：给「最接近」的组合（违规数最少、超出幅度最小）
  if (found.length === 0) {
    const r = run(cur);
    if (r.all.length > 0) {
      const best = [...r.all].sort((a, b) => violationCost(a, cur, plan.slots) - violationCost(b, cur, plan.slots))[0]!;
      return {
        feasible: false,
        plan,
        combos: [],
        violations: checkCombo(best, constraints, plan.slots),
        alternative: {
          combo: best,
          relaxed,
          reason,
          kept: keptHard.length ? keptHard : ['无附加硬约束'],
        },
        explanation: [...explanation, reason, ...relaxed.map((x) => `已尝试放宽：${x}`)],
        stats: r.stats,
      };
    }
  }

  if (found.length > 0) {
    const best = found[0]!;
    return {
      feasible: false,
      plan,
      combos: [],
      violations: checkCombo(best, constraints, plan.slots),
      alternative: {
        combo: best,
        relaxed,
        reason,
        kept: keptHard.length ? keptHard : ['无附加硬约束'],
      },
      explanation: [...explanation, reason, `放宽 ${relaxed.join('、')} 后得到可行方案`],
      stats: first.stats,
    };
  }

  return {
    feasible: false,
    plan,
    combos: [],
    violations: [{ field: 'stock', message: '当前门店可用餐品为空，无法生成组合，请更换门店或就餐方式' }],
    explanation: [...explanation, '当前门店可用餐品为空'],
    stats: first.stats,
  };
}

function violationCost(combo: Combo, c: Constraints, slots: SlotName[]): number {
  return checkCombo(combo, c, slots).reduce((s, v) => s + Math.abs(v.delta ?? 1), 0);
}

function summarizeViolations(all: Combo[], c: Constraints, slots: SlotName[]): Violation[] {
  const counter = new Map<string, Violation>();
  for (const combo of all.slice(0, 200)) {
    for (const v of checkCombo(combo, c, slots)) {
      const prev = counter.get(v.field);
      if (!prev || Math.abs(v.delta ?? 0) > Math.abs(prev.delta ?? 0)) counter.set(v.field, v);
    }
  }
  return [...counter.values()];
}

/* ------------------------------------------------------------------ */
/* 结果渲染                                                            */
/* ------------------------------------------------------------------ */

export function renderCombo(combo: Combo): string {
  const lines = combo.items.map((i) => `  - ${i.name} ×1  ¥${i.price.toFixed(1)}${i.nutrition ? `  ${Math.round(i.nutrition.energyKcal)} kcal` : '  营养未知'}`);
  lines.push(`  合计 ¥${combo.totalPrice.toFixed(1)}（原价 ¥${combo.originalPrice.toFixed(1)}${combo.savedAmount > 0 ? `，省 ¥${combo.savedAmount.toFixed(1)}` : ''}）`);
  lines.push(`  营养估算：${Math.round(combo.total.energyKcal)} kcal ｜ 蛋白 ${combo.total.protein.toFixed(0)}g / 碳水 ${combo.total.carbohydrate.toFixed(0)}g / 脂肪 ${combo.total.fat.toFixed(0)}g ｜ 钠 ${Math.round(combo.total.sodium)}mg`);
  if (combo.tasteHits.length) lines.push(`  命中口味偏好：${combo.tasteHits.join('、')}`);
  if (combo.reasons.length) lines.push(`  理由：${combo.reasons.join('；')}`);
  if (combo.missingNutrition.length) lines.push(`  ⚠️ 缺少营养数据：${combo.missingNutrition.join('、')}`);
  return lines.join('\n');
}

export function renderResult(r: CompileResult): string {
  const out: string[] = [];
  if (r.feasible) {
    out.push(`✅ 找到 ${r.combos.length} 个满足全部约束的组合：\n`);
    r.combos.forEach((c, i) => out.push(`方案 ${i + 1}（得分 ${c.score}）\n${renderCombo(c)}\n`));
  } else {
    out.push('❌ 没有满足全部约束的组合。');
    if (r.violations.length) out.push('未满足的约束：\n' + r.violations.map((v) => `  - ${v.message}`).join('\n'));
    if (r.alternative) {
      out.push(`\n🔁 最接近的替代方案（放宽：${r.alternative.relaxed.join('、') || '无'}）`);
      out.push(`原因：${r.alternative.reason}`);
      out.push(`仍然严格保留：${r.alternative.kept.join('、')}`);
      out.push(renderCombo(r.alternative.combo));
    }
  }
  // explanation 里含「排除了多少餐品」「改用了无主食档」等关键知情信息，
  // 之前从未输出，用户看不到过滤范围与降级原因。
  if (r.explanation?.length) {
    out.push('\n📌 说明：\n' + r.explanation.map((x) => `  - ${x}`).join('\n'));
  }
  return out.join('\n');
}

/** 供营养模块复用的宏量换算导出 */
export { macroGrams };
