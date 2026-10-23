/**
 * 约束建模：把用户的自然语言诉求编译成「可执行的查询条件」
 *
 * 这一层只做确定性规则，不依赖大模型——保证单元测试可覆盖、结果可复现。
 */

import type { Menu, MenuMeal, Nutrition } from './types.js';
import { buildNutritionIndex, matchNutrition, normalizeName } from './nutrition.js';

/* ------------------------------------------------------------------ */
/* 1. 约束输入                                                         */
/* ------------------------------------------------------------------ */

export type MacroPresetName = 'balanced' | 'highProtein' | 'lowCarb' | 'lowFat';

export interface Constraints {
  /** 预算上限（元），> 0 生效 */
  budgetMax?: number;
  /** 预算下限（元），避免「凑单过少」，可选 */
  budgetMin?: number;
  /** 热量上限 kcal */
  calorieMax?: number;
  /** 钠上限 mg */
  sodiumMax?: number;
  /** 蛋白质下限 g */
  proteinMin?: number;
  /** 口味偏好关键词，如 ['辣','芝士'] */
  tastes: string[];
  /** 忌口关键词，如 ['香菜','洋葱'] */
  avoid: string[];
  /** 过敏原，如 ['花生','牛奶','海鲜'] */
  allergens: string[];
  /** 饮食模式：素食 */
  vegetarian?: boolean;
  /** 必须包含的餐品分类槽位，如 ['main','drink'] */
  requiredSlots: SlotName[];
  /** 组合件数范围 */
  itemCount: { min: number; max: number };
  /** 三大营养素配比预设 */
  macroPreset?: MacroPresetName;
}

export type SlotName = 'main' | 'side' | 'drink' | 'dessert';

export const SLOT_LABEL: Record<SlotName, string> = {
  main: '主食',
  side: '小食',
  drink: '饮料',
  dessert: '甜品',
};

export function defaultConstraints(): Constraints {
  return {
    tastes: [],
    avoid: [],
    allergens: [],
    requiredSlots: [],
    itemCount: { min: 1, max: 4 },
  };
}

/* ------------------------------------------------------------------ */
/* 2. 过敏原 / 忌口 / 口味 知识库                                        */
/* ------------------------------------------------------------------ */

/** 过敏原 -> 命中关键词（对餐品名做包含匹配） */
export const ALLERGEN_RULES: Record<string, string[]> = {
  花生: ['花生'],
  坚果: ['坚果', '杏仁', '腰果', '夏威夷果', '开心果'],
  海鲜: ['虾', '蟹', '鱼', '鳕鱼', '鱿鱼', '海鲜'],
  贝类: ['贝', '蛤', '扇贝', '生蚝'],
  鸡蛋: ['蛋'],
  // 「吉士」是麦当劳对 cheese 的音译（吉士汉堡 = cheeseburger），必须覆盖；
  // 漏掉它会把吉士汉堡包套餐 / 双层吉士汉堡 / 高达吉士双牛堡推荐给牛奶过敏用户。
  // 同理补充起司/干酪/乳酪/黄油/酸奶/慕斯/雪糕/炼乳等常见乳制品词。
  牛奶: [
    '奶',
    '芝士',
    '吉士',
    '起司',
    '奶酪',
    '干酪',
    '乳酪',
    '牛乳',
    '奶油',
    '黄油',
    '酸奶',
    '炼乳',
    '淡奶',
    '拿铁',
    '奶铁',
    '冰淇淋',
    '雪糕',
    '慕斯',
    '麦旋风',
    '新地',
    '奶昔',
    // 名称不含「奶/冰淇淋」但实为乳制品：圆筒=冰淇淋甜筒，阿芙佳朵=咖啡+冰淇淋，
    // 派（香芋派/菠萝派）烘焙配料含乳成分。
    '圆筒',
    '阿芙佳朵',
    '派',
    // 「牧场」= ranch（如北美招牌牧场酱，含动物奶油）。此前仅靠 tag 命中，
    // tag 缺失时就会漏，补进关键词兜底。
    '牧场',
    // 巧克力/朱古力/可可：奶巧属乳制品。实测「巧克力味厚松饼猪柳蛋堡」
    // 此前无任何关键词命中，仅因营养表查不到才偶然被排除。
    '巧克力',
    '朱古力',
    '可可',
    // 咖啡/甜品里的乳制品名，此前完全未覆盖
    '卡布奇诺',
    '玛奇朵',
    '拉丝', // 马苏里拉拉丝芝士条
    '马苏里拉',
    '鲜奶',
    '乳脂',
    '奶冻',
  ],
  // 小麦（麸质）保守匹配。分四类，缺任何一类都会产生危险假阴性：
  //   ① 面包胚类：堡 / 麦满分 / 卷 / 面包 / 派
  //   ② 薯制品：薯条 / 薯饼 / 扭扭薯（与薯条同口径，避免「薯条杀、扭扭薯放」的不一致）
  //   ③ 裹粉炸鸡：麦乐鸡 / 鸡翅 / V翅 / 鸡排 / 脆汁鸡 / 鸡柳 / 炸鸡（外裹粉含小麦）
  //   ④ 面包胚但名称无「堡」：巨无霸 / 麦香鱼 / 麦香鸡
  //   ⑤ 其它：饼干、圆筒（冰淇淋蛋卷筒）
  // 注：「巨无霸」三个字里没有「堡」，是最容易漏的一个，别以为「堡」能覆盖它。
  小麦: [
    '堡',
    '麦满分',
    '卷',
    '面包',
    '派',
    '薯条',
    '薯饼',
    '扭扭薯',
    '麦乐鸡',
    '鸡翅',
    'V翅',
    '鸡排',
    '脆汁鸡',
    '鸡柳',
    '炸鸡',
    '巨无霸',
    '麦香鱼',
    '麦香鸡',
    '饼干',
    '圆筒',
  ],
  大豆: ['豆'],
  芝麻: ['芝麻'],
};

/** 忌口 -> 命中关键词 */
export const AVOID_RULES: Record<string, string[]> = {
  辣: ['辣', '川香', '麻辣', '韩式辣椒', '辛'],
  洋葱: ['洋葱'],
  香菜: ['香菜'],
  生菜: ['生菜'],
  酸黄瓜: ['酸黄瓜', '黄瓜'],
  芝士: ['芝士', '吉士', '起司', '奶酪', '干酪', '乳酪'],
  培根: ['培根', '烟肉'],
  牛肉: ['牛', '安格斯'],
  猪肉: ['猪', '火腿'],
  鸡肉: ['鸡'],
  鱼: ['鱼', '鳕鱼'],
  咖啡: ['咖啡', '美式', '拿铁', '奶铁'],
  碳酸: ['可乐', '雪碧', '汽水', '怡泉', '苏打'],
  糖: ['可乐', '雪碧', '新地', '麦旋风', '冰淇淋', '派', '奶茶'],
};

/** 口味偏好 -> 命中关键词（用于打分加权，不是硬过滤） */
export const TASTE_RULES: Record<string, string[]> = {
  辣: ['辣', '川香', '麦辣', '韩式辣椒', '辛'],
  芝士: ['芝士', '奶酪', '拉丝'],
  牛肉: ['牛', '安格斯', '巨无霸'],
  鸡肉: ['鸡', '麦辣鸡', '板烧', '麦乐鸡'],
  鱼: ['鱼', '鳕鱼', '麦香鱼'],
  咖啡: ['咖啡', '美式', '拿铁', '奶铁', '鲜萃'],
  清爽: ['柠檬', '红茶', '橙', '苹果汁', '无糖', '玉米'],
  甜: ['派', '新地', '麦旋风', '冰淇淋'],
  低卡: ['无糖', '玉米', '迷你', '小杯', '小薯条'],
  // 品类偏好：用户说「想有可乐和薯条」时，让含这两样的方案往前排。
  // 注意：套餐名不描述成分（「牛气满满套餐」不含「可乐」二字），
  // 所以这类偏好只对单品生效，会把「汉堡+薯条+可乐」的自由组合排到套餐前面。
  可乐: ['可乐'],
  薯条: ['薯条'],
};

/** 素食排除关键词 */
export const NON_VEGETARIAN = ['鸡', '牛', '猪', '鱼', '鳕鱼', '虾', '火腿', '培根', '烟肉', '安格斯', '麦香鱼', '麦乐鸡'];

/* ------------------------------------------------------------------ */
/* 3. 分类归一                                                         */
/* ------------------------------------------------------------------ */

const CATEGORY_SLOT: Array<{ re: RegExp; slot: SlotName }> = [
  { re: /汉堡|堡|卷|牛堡|肉堡|麦满分|主食/, slot: 'main' },
  { re: /炸鸡|蘸酱|鸡块|鸡翅|鸡排/, slot: 'main' },
  { re: /薯条|薯饼|薯格|扭扭薯|小食|玉米|鸡块|鸡翅|洋葱圈|拼盘/, slot: 'side' },
  { re: /甜品|派|冰淇淋|新地|麦旋风|蛋糕/, slot: 'dessert' },
  { re: /饮品|饮料|咖啡|可乐|雪碧|茶|果汁|牛奶|酷/, slot: 'drink' },
];

/** 分类名（含换行）归一 */
export function cleanCategoryName(name: string): string {
  return name.replace(/\s+/g, '').replace(/\n/g, '');
}

export function slotOfCategory(categoryName: string): SlotName | null {
  const c = cleanCategoryName(categoryName);
  for (const { re, slot } of CATEGORY_SLOT) if (re.test(c)) return slot;
  return null;
}

const ITEM_SLOT: Array<{ re: RegExp; slot: SlotName }> = [
  // ⚠️ 必须带 `i`：normalizeName 会 toLowerCase，菜单里的「V翅」到这里已是「v翅」，
  // 用大写 V 写正则永远匹配不上，会落到分类名兜底（「炸鸡」→ 主食），
  // 导致「想吃汉堡」的用户拿到 10 个鸡翅。
  { re: /(堡|汉堡|麦满分|卷)$/i, slot: 'main' },
  { re: /(薯条|薯饼|薯格|扭扭薯|玉米杯|麦乐鸡|鸡块|鸡翅|鸡排|鸡柳|v翅|十翅|洋葱圈|芝士条)$/i, slot: 'side' },
  { re: /(派|新地|麦旋风|冰淇淋|圆筒)$/i, slot: 'dessert' },
  { re: /(可乐|雪碧|咖啡|红茶|绿茶|果汁|牛奶|玉米|拿铁|奶铁|美式|酷|柠檬水|怡泉|气泡水)$/i, slot: 'drink' },
];

export function slotOfItem(itemName: string): SlotName | null {
  const n = normalizeName(itemName);
  for (const { re, slot } of ITEM_SLOT) if (re.test(n)) return slot;
  return null;
}

/* ------------------------------------------------------------------ */
/* 4. 餐品视图：把菜单 map 摊平成带分类、价格、营养的候选                  */
/* ------------------------------------------------------------------ */

export interface MealView {
  code: string;
  name: string;
  /** 现价，元 */
  price: number;
  originalPrice: number;
  categories: string[];
  slots: SlotName[];
  tags: string[];
  canWithOrder: boolean;
  image: string;
  nutrition: Nutrition | null;
  nutritionMatch: 'exact' | 'contains' | 'none';
  /** 是否命中硬排除（过敏原/忌口/素食） */
  excluded: string[];
  /**
   * 是否为「套餐」（三件套/双人餐/拼盘等）。
   * 套餐本身已含主食+小食+饮料，应作为独立完整解评估，不再参与逐槽位凑单。
   */
  isCombo: boolean;
}

/** 套餐名称特征 */
const COMBO_RE = /件套|套餐|双人餐|三人餐|四人餐|全家桶|拼盘|乐园餐|随心配|超值餐|欢乐餐/;

/** 名称 + 标签 + 分类拼接出的「可搜索文本」 */
/**
 * 硬过滤的匹配文本。**刻意不含分类名**。
 *
 * 原因（实测踩坑）：分类名含「堡」的有「巨无霸牛鱼肉堡」「安格斯MAX厚牛堡」
 * 「鸡肉汉堡/卷」等。若让分类名参与匹配，小麦过敏下的 `堡` 会命中**分类名**，
 * 把这三个分类下的**全部**餐品连坐判死 —— 误杀范围远大于收益。
 * 餐品名与 tags 已足够承载成分信息，分类名只提供品类信息，不用于排除决策。
 */
function haystack(name: string, tags: string[], _categories: string[]): string {
  return normalizeName([name, ...tags].join('|'));
}

export function matchRule(text: string, rules: Record<string, string[]>): string[] {
  const hits: string[] = [];
  for (const [key, words] of Object.entries(rules)) {
    if (words.some((w) => text.includes(normalizeName(w)))) hits.push(key);
  }
  return hits;
}

export function buildMealViews(menu: Menu, nutritionList: Nutrition[]): MealView[] {
  const idx = buildNutritionIndex(nutritionList);
  const catByCode = new Map<string, { name: string; tags: string[] }[]>();
  for (const cat of menu.categories) {
    for (const ref of cat.meals) {
      const arr = catByCode.get(ref.code) ?? [];
      arr.push({ name: cleanCategoryName(cat.name), tags: ref.tags ?? [] });
      catByCode.set(ref.code, arr);
    }
  }

  const views: MealView[] = [];
  for (const [code, m] of Object.entries(menu.meals)) {
    const cats = catByCode.get(code) ?? [];
    const catNames = cats.map((c) => c.name);
    const tags = [...new Set(cats.flatMap((c) => c.tags))];
    const text = haystack(m.name, tags, catNames);
    const slots = new Set<SlotName>();
    // 名称优先：名称已能明确槽位时，**不再用分类名兜底**。
    //
    // 原因：分类名「鸡肉汉堡\n/卷」下既有汉堡也有麦乐鸡、鸡翅，
    // 若两者都加，麦乐鸡会同时是 side 和 main，最后被当成主食推荐给
    // 「想吃汉堡」的用户。这与 §4.0 移除分类名的教训是同一个。
    const is = slotOfItem(m.name);
    if (is) {
      slots.add(is);
    } else {
      for (const cn of catNames) {
        const s = slotOfCategory(cn);
        if (s) slots.add(s);
      }
    }
    // 套餐判据要严：套餐 = 主食 + 小食 + 饮料的完整组合。
    //
    // 「拼盘 / 双拼」**不能算套餐** —— 「薄皮V翅双拼十翅」是 10 个鸡翅，
    // 既没有主食也没有饮料，若被当套餐会直接加入 main+side+drink 三个槽位，
    // 成为「完整解」被推荐给「想吃汉堡」的用户。
    const isCombo =
      /件套|套餐|双人餐|三人餐|四人餐|全家桶|乐园餐|随心配|超值餐|欢乐餐/.test(m.name) ||
      catNames.some((n) => /套餐|单人餐|双人餐|乐园餐/.test(n));

    // 🔴 套餐的营养**不能按名称匹配**。
    //
    // 「培根蔬萃双层牛堡三件套」会被模糊匹配到「培根蔬萃双层牛堡」= 442 kcal，
    // 而真实套餐是 汉堡 442 + 中薯条 289 + 可乐 147 = 878 kcal —— 低估近一倍。
    // 用户以为在 800 上限内，实际超了 78 kcal。
    //
    // 套餐营养必须拆子项加总（见 `nutritionOfCombo`，需 query-meal-detail）。
    // 在拿到子项数据之前，宁可标记为「未知」，也不能拿单品数值冒充。
    const nm = isCombo ? null : matchNutrition(m.name, idx);
    // 套餐自身即覆盖 主食+小食+饮料(+甜品)，让它单独就能满足多槽位要求
    const finalSlots = new Set<SlotName>(slots);
    if (isCombo) {
      finalSlots.add('main');
      finalSlots.add('side');
      finalSlots.add('drink');
    }
    // 酱料/调味品不是主食。实测「北美招牌牧场酱 ¥3」被分类推导成 main，
    // 会在主食稀缺时占位，产出「酱 + 小食 + 饮料」这种不像一顿饭的方案。
    if (/(?:酱|蘸酱|调味|风味酱)$|酱$/.test(m.name.trim())) finalSlots.delete('main');
    views.push({
      code,
      name: m.name,
      price: Number.parseFloat(m.currentPrice) || 0,
      originalPrice: Number.parseFloat(m.originalPrice) || 0,
      categories: catNames,
      slots: [...finalSlots],
      isCombo,
      tags,
      canWithOrder: m.canWithOrder,
      image: m.image,
      nutrition: nm?.nutrition ?? null,
      nutritionMatch: nm?.level ?? 'none',
      excluded: [],
    });
    // 记录一次文本用于后续排除判定（避免重复计算）
    (views[views.length - 1] as MealView & { _text?: string })._text = text;
  }
  return views;
}

/** 应用硬约束，给 view 打 excluded 标记，返回被排除的原因映射 */
/**
 * 对**单个文本**跑硬过滤（用于套餐子项名、rounds 名等）。
 * 返回命中原因数组，空数组 = 通过。
 * 规则与 applyHardFilters 完全一致，避免两处规则漂移。
 */
export function hitHardFilters(text: string, c: Constraints): string[] {
  const t = normalizeName(text);
  const why: string[] = [];
  for (const a of c.allergens) {
    const words = ALLERGEN_RULES[a] ?? [a];
    if (words.some((w) => t.includes(normalizeName(w)))) why.push(`含过敏原「${a}」`);
  }
  for (const av of c.avoid) {
    const words = AVOID_RULES[av] ?? [av];
    if (words.some((w) => t.includes(normalizeName(w)))) why.push(`忌口「${av}」`);
  }
  if (c.vegetarian && NON_VEGETARIAN.some((w) => t.includes(normalizeName(w)))) why.push('非素食');
  return why;
}

/**
 * 扫描套餐/单品的**组成子项**，返回命中的过敏原/忌口原因。
 *
 * 用途：套餐名只描述主食（如「巨无霸三件套」名称不含「堡」），
 * 名称层过滤会漏判。必须下钻到 rounds[].choices[].name 与 rounds[].name。
 *
 * @param detail query-meal-detail 的返回
 * @param requireAll  true = 该轮所有选项都命中才算（整单必然不可解）
 *                    false = 只要有任一选项命中就算（用户可能换到含敏档位）
 */
export function scanSubItems(
  detail: {
    rounds?: Array<{
      name?: string;
      minQuantity?: number;
      choices?: Array<{ name?: string; isDefault?: number; quantity?: number }>;
    }>;
  },
  c: Constraints,
  requireAll = false,
): { reason: string; where: string }[] {
  const hits: { reason: string; where: string }[] = [];
  for (const r of detail.rounds ?? []) {
    const choices = r.choices ?? [];
    // rounds[].name 本身也可能含关键词（如「韩式辣椒黄油风味酱」）
    if (r.name) {
      const why = hitHardFilters(r.name, c);
      if (why.length) hits.push({ reason: why.join('/'), where: `round「${r.name}」` });
    }
    for (const ch of choices) {
      if (!ch.name) continue;
      // 🔴 判据是「是否实际会装进这单」，不是「是否默认」。
      // 实测 BFF四宫格小食盘 9900015730 轮1 minQuantity=3，默认配置是 3 件：
      //   麦辣鸡翅-2块 (isDefault=1) + 麦乐鸡-5块 (isDefault=0 但 quantity=1)
      //   + 脆皮鸡柳3根 (isDefault=0 但 quantity=1)
      // 只看 isDefault=1 会漏掉后两件。
      // 真正的「用户没选、可不加」的项是 quantity=0 且 isDefault=0。
      const selected = ch.isDefault === 1 || (ch.quantity ?? 0) >= 1;
      if (requireAll || selected) {
        const why = hitHardFilters(ch.name, c);
        if (why.length) hits.push({ reason: why.join('/'), where: `子项「${ch.name}」` });
      }
    }
  }
  return hits;
}

export function applyHardFilters(views: MealView[], c: Constraints): Map<string, string[]> {
  const reasons = new Map<string, string[]>();
  for (const v of views) {
    const text = (v as MealView & { _text?: string })._text ?? haystack(v.name, v.tags, v.categories);
    const why: string[] = [];

    for (const a of c.allergens) {
      const words = ALLERGEN_RULES[a] ?? [a];
      if (words.some((w) => text.includes(normalizeName(w)))) why.push(`含过敏原「${a}」`);
    }
    for (const av of c.avoid) {
      const words = AVOID_RULES[av] ?? [av];
      if (words.some((w) => text.includes(normalizeName(w)))) why.push(`忌口「${av}」`);
    }
    if (c.vegetarian && NON_VEGETARIAN.some((w) => text.includes(normalizeName(w)))) why.push('非素食');
    if (v.price <= 0) why.push('价格异常（不可售）');
    if (why.length) {
      v.excluded = why;
      reasons.set(v.code, why);
    }
  }
  return reasons;
}

/* ------------------------------------------------------------------ */
/* 5. 自然语言槽位提取                                                  */
/* ------------------------------------------------------------------ */

const CN_NUM: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const UNIT_KCAL = ['千卡', '大卡', 'kcal', 'KCAL', '卡路里', '卡'];

/** 解析中文/数字混合金额，如 "35块" "三十五元" "<=40" */
export function parseMoney(text: string): number | undefined {
  const t = text.replace(/[，,]/g, '');
  const m = /(?:不超过|最多|上限|低于|小于|以内|预算|<=|<)?\s*(\d+(?:\.\d+)?)\s*(?:块钱|块|元|rmb|元以内)/i.exec(t);
  if (m) return Number.parseFloat(m[1]!);
  const m2 = /(?:不超过|最多|上限|低于|小于|以内|预算)\s*([零一二两三四五六七八九十百]+)\s*(?:块钱|块|元)/.exec(t);
  if (m2) return cn2num(m2[1]!);
  return undefined;
}

export function cn2num(s: string): number {
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const hi = a ? (CN_NUM[a] ?? 0) : 1;
    const lo = b ? (CN_NUM[b] ?? 0) : 0;
    return hi * 10 + lo;
  }
  return CN_NUM[s] ?? Number.NaN;
}

/** 解析热量上限，如 "600大卡以内" "不超过500 kcal" */
export function parseCalorie(text: string): number | undefined {
  for (const u of UNIT_KCAL) {
    const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const m = re.exec(text);
    if (m) return Number.parseFloat(m[1]!);
  }
  return undefined;
}

/** 解析钠上限 mg */
export function parseSodium(text: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(?:mg|毫克)\s*(?:钠|以内|以下)?/i.exec(text);
  if (m && /钠/.test(text)) return Number.parseFloat(m[1]!);
  return undefined;
}

/** 解析蛋白下限 g */
export function parseProteinMin(text: string): number | undefined {
  const m = /(?:蛋白质|蛋白)[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(?:g|克)?/i.exec(text);
  if (m && /(至少|不低于|以上|高于|超过|最少)/.test(text)) return Number.parseFloat(m[1]!);
  const m2 = /(?:至少|不低于|以上|高于|超过|最少)\s*(\d+(?:\.\d+)?)\s*(?:g|克)?\s*(?:蛋白质|蛋白)/i.exec(text);
  if (m2) return Number.parseFloat(m2[1]!);
  return undefined;
}

const ALLERGEN_SYNONYMS: Record<string, string> = {
  花生: '花生', 坚果: '坚果', 海鲜: '海鲜', 鱼类: '海鲜', 鱼: '海鲜', 虾: '海鲜', 蟹: '海鲜',
  贝类: '贝类', 鸡蛋: '鸡蛋', 蛋: '鸡蛋', 蛋类: '鸡蛋',
  牛奶: '牛奶', 乳制品: '牛奶', 奶制品: '牛奶', 芝士: '牛奶', 奶酪: '牛奶', 乳糖: '牛奶',
  小麦: '小麦', 麸质: '小麦', 面筋: '小麦', 大豆: '大豆', 芝麻: '芝麻',
};

const TASTE_SYNONYMS: Record<string, string> = {
  辣: '辣', 辣的: '辣', 微辣: '辣', 重口: '辣',
  芝士: '芝士', 奶酪: '芝士', 牛肉: '牛肉', 牛: '牛肉',
  鸡肉: '鸡肉', 鸡: '鸡肉', 鱼: '鱼', 咖啡: '咖啡',
  清爽: '清爽', 清淡: '清爽', 甜: '甜', 甜品: '甜',
  低卡: '低卡', 低热量: '低卡', 减脂: '低卡', 减肥: '低卡',
  控卡: '低卡', 低脂: '低卡', 少油: '低卡', 瘦身: '低卡',
  可乐: '可乐', 薯条: '薯条',
};

/**
 * 「饮食目标型」偏好词：出现即算，**不需要**前置动词。
 *
 * 为什么单独列：用户不会说「我喜欢低卡」，而是直接说「今天减肥」「想控卡」。
 * 按通用规则要求前置「喜欢/想吃/偏好」，这类诉求会被完全丢弃 ——
 * 实测「我想吃个汉堡，今天想减肥」的 tastes 为空，导致排序只剩省钱与预算利用率，
 * 最终把 707 kcal、脂肪 44g 的厚牛堡排在第一位。
 */
const STANDALONE_TASTES = new Set(['低卡']);

const AVOID_SYNONYMS: Record<string, string> = {
  辣: '辣', 香菜: '香菜', 洋葱: '洋葱', 生菜: '生菜', 酸黄瓜: '酸黄瓜', 黄瓜: '酸黄瓜',
  芝士: '芝士', 培根: '培根', 牛肉: '牛肉', 猪肉: '猪肉', 鸡肉: '鸡肉',
  鱼: '鱼', 咖啡: '咖啡', 碳酸: '碳酸', 汽水: '碳酸', 糖: '糖', 甜: '糖',
};

/** 从用户的一句话中提取约束。返回值只含「明确提到」的项。 */
export function extractConstraints(utterance: string): Constraints {
  const c = defaultConstraints();
  const t = utterance.trim();

  const money = parseMoney(t);
  if (money !== undefined) c.budgetMax = money;

  const kcal = parseCalorie(t);
  if (kcal !== undefined) c.calorieMax = kcal;

  const sodium = parseSodium(t);
  if (sodium !== undefined) c.sodiumMax = sodium;

  const protein = parseProteinMin(t);
  if (protein !== undefined) c.proteinMin = protein;

  if (/素食|不吃肉|全素|斋/.test(t)) c.vegetarian = true;

  // 过敏原
  if (/过敏|不能吃|吃不了|忌过敏|对.*过敏/.test(t)) {
    for (const [syn, key] of Object.entries(ALLERGEN_SYNONYMS)) {
      if (t.includes(syn) && !c.allergens.includes(key)) c.allergens.push(key);
    }
  }
  // 忌口
  if (/忌口|不要|不吃|别放|去|免|少/.test(t)) {
    for (const [syn, key] of Object.entries(AVOID_SYNONYMS)) {
      const re = new RegExp(`(?:不要|不吃|忌口|别放|去|免)[^，。；]{0,3}${syn}|${syn}(?:不要|不吃)`);
      if (re.test(t) && !c.avoid.includes(key)) c.avoid.push(key);
    }
  }
  // 口味偏好
  for (const [syn, key] of Object.entries(TASTE_SYNONYMS)) {
    // 饮食目标型（低卡/减脂/减肥…）：出现即算，不要求前置动词
    if (STANDALONE_TASTES.has(key) && t.includes(syn)) {
      if (!c.tastes.includes(key)) c.tastes.push(key);
      continue;
    }
    if (/(?:喜欢|爱吃|想吃|想要|偏好|来点|要)/.test(t) && t.includes(syn) && !c.tastes.includes(key)) {
      c.tastes.push(key);
    } else if (t.includes(`喜欢${syn}`) || t.includes(`爱吃${syn}`) || t.includes(`想吃${syn}`)) {
      if (!c.tastes.includes(key)) c.tastes.push(key);
    }
  }

  // 槽位
  //
  // ⚠️ 软偏好 vs 硬槽位的区分（与 SKILL.md §4.3 一致）：
  // 「**最好**有饮料」「**想**喝可乐」是偏好，不是硬性要求。
  // 若写成 requiredSlots，会把本来可行的组合误判为无解
  // （实测：小麦过敏 + 「最好有饮料」→ slots 只剩 ['drink'] → 只输出单件饮料）。
  const slots: SlotName[] = [];
  const softRe = /(?:最好|最好能|最好有|如果能|要是能|希望|最好再来|可以的话|顺便)/;
  const isSoft = (kw: string): boolean => {
    // 该槽位关键词是否被软化词修饰
    const idx = t.indexOf(kw);
    if (idx < 0) return false;
    const before = t.slice(Math.max(0, idx - 8), idx);
    return softRe.test(before);
  };
  if (/汉堡|堡|主食/.test(t) && !isSoft('汉堡') && !isSoft('堡')) slots.push('main');
  if (/小食|薯条|鸡块|鸡翅/.test(t)) slots.push('side');
  if (/饮料|喝的|可乐|咖啡|饮品/.test(t) && !isSoft('饮料') && !isSoft('喝的')) slots.push('drink');
  if (/甜品|派|冰淇淋|新地/.test(t)) slots.push('dessert');
  c.requiredSlots = slots;

  // 件数
  const cnt = /([零一二两三四五六七八九十]|\d)\s*件/.exec(t);
  if (cnt) {
    const n = cn2num(cnt[1]!);
    if (Number.isFinite(n) && n >= 1) c.itemCount = { min: n, max: n };
  }

  if (/高蛋白|增肌|健身/.test(t)) c.macroPreset = 'highProtein';
  else if (/低碳|生酮|控糖/.test(t)) c.macroPreset = 'lowCarb';
  else if (/低脂|少油/.test(t)) c.macroPreset = 'lowFat';
  else if (/均衡|平衡/.test(t)) c.macroPreset = 'balanced';

  return c;
}
