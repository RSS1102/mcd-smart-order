/**
 * 营养物质解析与搭配求解
 *
 * 数据源：mcd-mcp 的 list-nutrition-foods。
 * 注意：该工具的 data 不是 JSON 数组，而是一段紧凑表格文本，形如：
 *
 * [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *   猪柳麦满分,null,1288,308,16,16,24,781,213
 *   巨无霸,null,2146,513,27,26,42,961,171
 *
 * 单位：kJ / kcal / g / g / g / mg / mg
 */

import type { Nutrition } from './types.js';
import { NUTRITION_FIELDS } from './types.js';

/** 解析紧凑表格文本 -> Nutrition[] */
export function parseNutritionTable(raw: string): Nutrition[] {
  const lines = raw.split(/\r?\n/);
  // 形如 [160]{a,b,c}: 的表头行，用于确认列顺序；列顺序理论上固定，但仍按表头解析更稳
  let fields: readonly string[] = NUTRITION_FIELDS;
  const headerIdx = lines.findIndex((l) => /^\s*\[\d+\]\s*\{/.test(l));
  if (headerIdx >= 0) {
    const m = /\{([^}]*)\}/.exec(lines[headerIdx]!);
    if (m) {
      const parsed = m[1]!.split(',').map((s) => s.trim());
      if (parsed.length === NUTRITION_FIELDS.length) fields = parsed;
    }
  }
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  const out: Nutrition[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const cells = line.split(',');
    if (cells.length < fields.length) continue;
    const rec: Record<string, string | number | null> = {};
    fields.forEach((f, idx) => {
      const rawCell = cells[idx]!.trim();
      rec[f] = rawCell === 'null' || rawCell === '' ? null : rawCell;
    });
    out.push({
      productName: String(rec['productName'] ?? ''),
      nutritionDescription: (rec['nutritionDescription'] as string | null) ?? null,
      energyKj: num(rec['energyKj']),
      energyKcal: num(rec['energyKcal']),
      protein: num(rec['protein']),
      fat: num(rec['fat']),
      carbohydrate: num(rec['carbohydrate']),
      sodium: num(rec['sodium']),
      calcium: num(rec['calcium']),
    });
  }
  return out.filter((n) => n.productName.length > 0);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ */
/* 名称归一化与匹配                                                     */
/* ------------------------------------------------------------------ */

const NOISE = /[【】\[\]“”"'·™\s+（）()]/g;

/** 归一化：去噪点字符、全角转半角、去掉常见后缀词 */
export function normalizeName(name: string): string {
  return name
    .replace(NOISE, '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(三件套|四件套|双人餐|单人餐|套餐|超值餐|欢乐餐)$/u, '')
    .toLowerCase();
}

/** 建立 归一化名 -> Nutrition 的索引；同名保留第一条 */
export function buildNutritionIndex(list: Nutrition[]): Map<string, Nutrition> {
  const idx = new Map<string, Nutrition>();
  for (const n of list) {
    const k = normalizeName(n.productName);
    if (!idx.has(k)) idx.set(k, n);
  }
  return idx;
}

export interface NameMatch {
  nutrition: Nutrition;
  /** exact = 归一化后完全一致；contains = 一方包含另一方；null = 未匹配 */
  level: 'exact' | 'contains' | 'none';
}

/**
 * 菜单名 -> 营养物质。
 * 先精确，再做包含匹配（菜单名往往更短，如「中薯条」vs 营养表「中薯条」）。
 * 包含匹配要求较短一方长度 >= 2，避免「堡」这种单字误命中。
 */
export function matchNutrition(menuName: string, index: Map<string, Nutrition>): NameMatch | null {
  const key = normalizeName(menuName);
  if (!key) return null;
  const exact = index.get(key);
  if (exact) return { nutrition: exact, level: 'exact' };

  let best: NameMatch | null = null;
  for (const [k, v] of index) {
    if (k.length < 2 || key.length < 2) continue;
    if (k.includes(key) || key.includes(k)) {
      // 取差异最小的那个
      const score = Math.abs(k.length - key.length);
      if (!best || score < Math.abs(best.nutrition.productName.length - key.length)) {
        best = { nutrition: v, level: 'contains' };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 营养估算与搭配求解                                                   */
/* ------------------------------------------------------------------ */

export interface MacroTarget {
  /** 目标总热量 kcal */
  kcal: number;
  /** 蛋白 / 碳水 / 脂肪 供能比，三项之和应为 1 */
  ratio: { protein: number; carb: number; fat: number };
}

export interface MacroGrams {
  protein: number;
  carb: number;
  fat: number;
}

/** 由热量与供能比换算成克数：蛋白/碳水 4 kcal per g，脂肪 9 kcal per g */
export function macroGrams(target: MacroTarget): MacroGrams {
  return {
    protein: (target.kcal * target.ratio.protein) / 4,
    carb: (target.kcal * target.ratio.carb) / 4,
    fat: (target.kcal * target.ratio.fat) / 9,
  };
}

/** 由实际克数反算供能比 */
export function actualRatio(n: Pick<Nutrition, 'protein' | 'carbohydrate' | 'fat'>): {
  protein: number;
  carb: number;
  fat: number;
} {
  const p = n.protein * 4;
  const c = n.carbohydrate * 4;
  const f = n.fat * 9;
  const total = p + c + f;
  if (total <= 0) return { protein: 0, carb: 0, fat: 0 };
  return { protein: p / total, carb: c / total, fat: f / total };
}

export function sumNutrition(items: Nutrition[]): Nutrition {
  return items.reduce<Nutrition>(
    (acc, n) => ({
      productName: acc.productName,
      nutritionDescription: null,
      energyKj: acc.energyKj + n.energyKj,
      energyKcal: acc.energyKcal + n.energyKcal,
      protein: acc.protein + n.protein,
      fat: acc.fat + n.fat,
      carbohydrate: acc.carbohydrate + n.carbohydrate,
      sodium: acc.sodium + n.sodium,
      calcium: acc.calcium + n.calcium,
    }),
    {
      productName: '',
      nutritionDescription: null,
      energyKj: 0,
      energyKcal: 0,
      protein: 0,
      fat: 0,
      carbohydrate: 0,
      sodium: 0,
      calcium: 0,
    },
  );
}

/** 预设配比 */
export const MACRO_PRESETS: Record<string, { protein: number; carb: number; fat: number }> = {
  balanced: { protein: 0.2, carb: 0.55, fat: 0.25 },
  highProtein: { protein: 0.35, carb: 0.4, fat: 0.25 },
  lowCarb: { protein: 0.3, carb: 0.25, fat: 0.45 },
  lowFat: { protein: 0.25, carb: 0.6, fat: 0.15 },
};

export interface NutritionPlanItem {
  name: string;
  code: string;
  nutrition: Nutrition;
  /** 匹配质量，供 UI 标注「营养值为近似匹配」 */
  match: 'exact' | 'contains';
}

export interface NutritionPlan {
  items: NutritionPlanItem[];
  total: Nutrition;
  targetKcal: number;
  /** 热量达成率 */
  kcalFill: number;
  targetGrams: MacroGrams;
  /** 实际供能比 */
  actual: { protein: number; carb: number; fat: number };
  /** 与目标配比的偏差绝对值之和（越小越贴合） */
  deviation: number;
  notes: string[];
}

/**
 * 营养搭配求解：在候选餐品中挑选若干件，使总热量尽量贴近目标、供能比尽量贴近配比。
 *
 * 采用带剪枝的组合搜索（DFS + 上界剪枝），候选按「单件对目标的边际贡献」预排序，
 * 保证在 maxItems 较小时（<=4）毫秒级返回。
 */
export function planNutrition(
  candidates: Array<{ code: string; name: string; nutrition: Nutrition; match: 'exact' | 'contains' }>,
  target: MacroTarget,
  opts: { maxItems?: number; topK?: number; kcalTolerance?: number } = {},
): NutritionPlan[] {
  const maxItems = Math.max(1, Math.min(opts.maxItems ?? 4, 5));
  const topK = opts.topK ?? 5;
  const tol = opts.kcalTolerance ?? 0.15; // 热量允许上下浮动 15%
  const grams = macroGrams(target);
  const kcalLo = target.kcal * (1 - tol);
  const kcalHi = target.kcal * (1 + tol);

  // 高蛋白类预设（蛋白供能比 >= 30%）下，蛋白绝对量必须参与排序，
  // 否则会选出「配比接近但蛋白严重不足」的方案（见文件末尾排序说明）。
  const targetProteinG = (target.kcal * target.ratio.protein) / 4;
  const proteinMatters = target.ratio.protein >= 0.3;

  // 预排序：单件越接近「热量缺口 / 剩余件数」越优先；
  // 高蛋白目标下再叠加蛋白贡献，保证高蛋白餐品能进入候选池
  const pool = [...candidates].filter((c) => c.nutrition.energyKcal <= kcalHi);
  const poolKey = (c: (typeof pool)[number]) =>
    Math.abs(c.nutrition.energyKcal - target.kcal / maxItems) - (proteinMatters ? c.nutrition.protein * 3 : 0);
  pool.sort((a, b) => poolKey(a) - poolKey(b));

  const results: NutritionPlan[] = [];
  const path: typeof pool = [];

  const evaluate = (picked: typeof pool): NutritionPlan => {
    const total = sumNutrition(picked.map((p) => p.nutrition));
    const act = actualRatio(total);
    const deviation =
      Math.abs(act.protein - target.ratio.protein) +
      Math.abs(act.carb - target.ratio.carb) +
      Math.abs(act.fat - target.ratio.fat);
    const notes: string[] = [];
    if (picked.some((p) => p.match === 'contains')) {
      notes.push('部分餐品未在营养表中精确命中，采用名称近似匹配，数值为估算值。');
    }
    // 目标不可达时必须明说，否则用户会误以为诉求已满足。
    // 实测：650kcal + highProtein 目标蛋白 56.9g，早餐菜单窗口内上限仅 46g。
    if (proteinMatters && total.protein < targetProteinG * 0.75) {
      notes.push(
        `蛋白目标 ${targetProteinG.toFixed(0)}g 不可达：本方案仅 ${total.protein.toFixed(0)}g` +
          `（达成率 ${((total.protein / targetProteinG) * 100).toFixed(0)}%，下限为目标的 75%）。` +
          `建议：提高热量目标、或换到正餐时段（当前菜单缺少高蛋白正餐，如鸡翅/多肉类）。`,
      );
    }
    if (total.sodium > 2000) notes.push(`钠合计 ${Math.round(total.sodium)} mg，已超过成人单餐建议上限 2000 mg，建议搭配无糖饮料或减少酱料。`);
    return {
      items: picked.map((p) => ({ name: p.name, code: p.code, nutrition: p.nutrition, match: p.match })),
      total,
      targetKcal: target.kcal,
      kcalFill: target.kcal > 0 ? total.energyKcal / target.kcal : 0,
      targetGrams: grams,
      actual: act,
      deviation,
      notes,
    };
  };

  const dfs = (start: number) => {
    if (results.length > topK * 40) return; // 结果池上限，防止极端输入
    if (path.length > 0) {
      const total = sumNutrition(path.map((p) => p.nutrition));
      if (total.energyKcal >= kcalLo) {
        results.push(evaluate([...path]));
      }
    }
    if (path.length >= maxItems) return;
    for (let i = start; i < pool.length; i++) {
      const c = pool[i]!;
      const next = sumNutrition([...path.map((p) => p.nutrition), c.nutrition]);
      if (next.energyKcal > kcalHi) continue; // 热量上界剪枝
      path.push(c);
      dfs(i + 1);
      path.pop();
    }
  };
  dfs(0);

  if (results.length === 0) {
    // 无解：退化为「最接近」的方案。
    // pool 可能因为热量过滤而为空，这里必须回落到全部候选，否则会返回空结果。
    const fallbackPool = pool.length ? pool : candidates.map((c) => ({ ...c }));
    const best = fallbackPool
      .map((c) => evaluate([c]))
      .sort((a, b) => Math.abs(a.total.energyKcal - target.kcal) - Math.abs(b.total.energyKcal - target.kcal))[0];
    if (best) {
      best.notes.push(`没有找到落在 ${Math.round(kcalLo)}~${Math.round(kcalHi)} kcal 区间的组合，以上为热量最接近的替代方案。`);
      return [best];
    }
    return [];
  }

  // 排序：① 营养素绝对量缺口 → ② 配比偏差 → ③ 热量贴近度
  //
  // 为什么要加 ①：只看配比偏差会选出「比例接近、但绝对量严重不足」的组合。
  // 实测 700 kcal + highProtein（目标蛋白 61g）：纯按偏差会给出
  // 蛋白仅 36g（达成率 59%）的方案 —— 对「增肌高蛋白」毫无意义。
  // 因此高蛋白类预设下，先把蛋白缺口小的排前面。
  const proteinShortfall = (p: NutritionPlan) =>
    proteinMatters ? Math.max(0, targetProteinG - p.total.protein) : 0;

  return results
    .sort(
      (a, b) =>
        proteinShortfall(a) - proteinShortfall(b) ||
        a.deviation - b.deviation ||
        Math.abs(a.total.energyKcal - target.kcal) - Math.abs(b.total.energyKcal - target.kcal),
    )
    .slice(0, topK);
}
