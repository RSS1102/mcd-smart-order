/**
 * 麦当劳中国 MCP 数据模型类型定义
 *
 * 本文件字段全部来自 mcd-mcp 真实接口返回（tools/call 结果），不做臆测。
 * 对应 MCP Server: https://mcp.mcd.cn  (Streamable HTTP, MCP Version <= 2025-06-18)
 */

/* ------------------------------------------------------------------ */
/* 1. 通用响应信封                                                      */
/* ------------------------------------------------------------------ */

/** 所有工具统一信封。业务失败时 success=false + code!=200，data 缺失 */
export interface McpEnvelope<T> {
  success: boolean;
  /** 200 成功；400 参数校验失败；60006 商品售罄/不可售；429 限流；401 Token 无效 */
  code: number;
  message: string;
  datetime: string;
  traceId: string;
  data?: T;
}

/* ------------------------------------------------------------------ */
/* 2. 就餐方式 / 订单类型                                                */
/* ------------------------------------------------------------------ */

/** beType：业务类型 */
export type BeType = 1 | 2 | 5 | 6;

/** orderType：1-到店（含到店自取 + 得来速），2-外送（含麦乐送 + 企业团餐） */
export type OrderType = 1 | 2;

export const BE_TYPE_LABEL: Record<BeType, string> = {
  1: '到店自取',
  2: '麦乐送到家',
  5: '得来速车道取餐',
  6: '企业团餐',
};

export interface ChannelParams {
  storeCode: string;
  orderType: OrderType;
  beType: BeType;
  /** 到店自取(beType=1) 禁止传；得来速/外送/团餐 必传 */
  beCode?: string;
  /** 预约场景必传，格式 yyyy-MM-dd HH:mm；非预约场景必须不传 */
  reservationDate?: string;
}

/* ------------------------------------------------------------------ */
/* 3. 门店                                                             */
/* ------------------------------------------------------------------ */

export interface ReservationTimeOption {
  date: string;
  today: boolean;
  reservationOptionText: string;
}

/**
 * 门店。
 * ⚠️ 到店场景（query-nearby-stores）与外送场景（delivery-query-stores）字段不一致：
 *  - 到店：有 address / distance / longitude / latitude
 *  - 外送：**没有** address / distance / longitude / latitude，只有 storeCode + beCode + storeName
 * 因此这几个字段是可选的，使用时必须做空值处理。
 */
export interface Store {
  storeCode: string;
  storeName: string;
  address?: string;
  /** 单位：米。外送场景无此字段 */
  distance?: number;
  /** 是否营业中 */
  businessStatus: boolean;
  businessStartTime: string;
  businessEndTime: string;
  longitude?: number;
  latitude?: number;
  /** 是否支持预约 */
  reservation: boolean;
  reservationTimeOptions?: ReservationTimeOption[];
  /** 得来速(beType=5) 场景才有；到店自取(beType=1) 场景为空串 */
  beCode?: string;
}

/** delivery-query-addresses 返回。注意 phone 服务端已脱敏（如 157****4071） */
export interface DeliveryAddress {
  addressId: string;
  contactName: string;
  /** 服务端返回即为脱敏值，勿自行拼接完整号码 */
  phone: string;
  fullAddress: string;
}

/* ------------------------------------------------------------------ */
/* 4. 菜单                                                             */
/* ------------------------------------------------------------------ */

export interface MealRef {
  code: string;
  tags?: string[];
}

/** query-meals 返回 data.categories[] —— 注意：分类没有 code，只有 name */
export interface MenuCategory {
  name: string;
  meals: MealRef[];
}

export interface MenuMeal {
  name: string;
  image: string;
  /** 现价，字符串形式的「元」，如 "33.5" */
  currentPrice: string;
  /** 原价，字符串形式的「元」 */
  originalPrice: string;
  /** 是否支持随单购 */
  canWithOrder: boolean;
  discountType?: string;
  withOrder?: unknown;
}

export interface Menu {
  categories: MenuCategory[];
  /** code -> 餐品；只有在售餐品才会出现（售罄 = 不在此 map 中） */
  meals: Record<string, MenuMeal>;
  /** 常点餐品 */
  frequent?: MealRef;
}

/* ------------------------------------------------------------------ */
/* 5. 餐品详情                                                          */
/* ------------------------------------------------------------------ */

export interface ModificationValue {
  code: string;
  price: number;
  name: string;
  maxQuantity: number;
  minQuantity: number;
  selectedQuantity: number;
  /** 用户选中该项时要回传的 key */
  selectedKey: string;
  /** 用户未选中该项时要回传的 key（可能为空串） */
  unselectedKey: string;
}

export interface ModificationItem {
  maxValues: number;
  minValues: number;
  values: ModificationValue[];
}

export interface Modification {
  items: ModificationItem[];
}

export interface Choice {
  code: string;
  name: string;
  quantity: number;
  maxQuantity: number;
  minQuantity?: number;
  /** 1 = 默认选中 */
  isDefault: number;
  /** 差价，形如 "+ ¥2" / "- ¥1" / "+ ¥0" */
  diffPrice: string;
  supportModify: boolean;
  modification?: Modification;
}

/** 套餐的「轮」：主食任意选 / 选择套餐内小食 / 选择套餐内饮料 */
export interface Round {
  id: number;
  name: string;
  quantity: number;
  maxQuantity: number;
  minQuantity: number;
  choices: Choice[];
}

export interface MealDetail {
  code: string;
  name: string;
  rounds: Round[];
  image: string;
  supportModify: boolean;
}

/* ------------------------------------------------------------------ */
/* 6. 算价                                                             */
/* ------------------------------------------------------------------ */

export interface TakeWay {
  code: string;
  title: string;
  subtitle: string;
}

export interface PriceProduct {
  productCode: string;
  productName: string;
  quantity: number;
  /** 以下金额单位均为「分」 */
  originalSubtotal: number;
  subtotal: number;
}

export interface MealAssistance {
  code: string;
  name: string;
}

export interface PriceResult {
  productOriginalPrice: number;
  productPrice: number;
  /** 运费，到店场景为 0 */
  deliveryOriginalPrice?: number;
  deliveryPrice?: number;
  /** 打包费 */
  packingOriginalPrice?: number;
  packingPrice?: number;
  /** 餐具费 */
  tablewarePrice?: number;
  originalPrice: number;
  discount: number;
  /** 应付金额，单位「分」 */
  price: number;
  productList: PriceProduct[];
  /** orderType=1 时才有，create-order 的 takeWayCode 取自这里 */
  takeWayList?: TakeWay[];
  /** 团餐场景的助餐服务列表（gmServiceCode 取自这里） */
  mealAssistanceList?: MealAssistance[];
}

/* ------------------------------------------------------------------ */
/* 7. 营养物质（list-nutrition-foods）                                   */
/* ------------------------------------------------------------------ */

/**
 * list-nutrition-foods 的 data 是一段紧凑文本，不是 JSON 数组：
 *
 * [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *   猪柳麦满分,null,1288,308,16,16,24,781,213
 *   ...
 *
 * 单位：energyKj/energyKcal = kJ/kcal；protein/fat/carbohydrate = g；sodium/calcium = mg
 */
export interface Nutrition {
  productName: string;
  nutritionDescription: string | null;
  energyKj: number;
  energyKcal: number;
  protein: number;
  fat: number;
  carbohydrate: number;
  sodium: number;
  calcium: number;
}

export const NUTRITION_FIELDS = [
  'productName',
  'nutritionDescription',
  'energyKj',
  'energyKcal',
  'protein',
  'fat',
  'carbohydrate',
  'sodium',
  'calcium',
] as const;

/* ------------------------------------------------------------------ */
/* 8. 下单                                                             */
/* ------------------------------------------------------------------ */

export interface ModificationInput {
  code: string;
  key: string;
  quantity: number;
}

export interface RoundItemInput {
  code: string;
  quantity: number;
  modification?: { values: ModificationInput[] };
}

export interface RoundInput {
  round: string;
  comboItemList: RoundItemInput[];
}

export interface OrderItemInput {
  productCode: string;
  quantity: number;
  couponId?: string;
  couponCode?: string;
  modification?: { values: ModificationInput[] };
  roundList?: RoundInput[];
}

export interface CreateOrderInput extends ChannelParams {
  items: OrderItemInput[];
  /** orderType=1 必传，取自 calculate-price.data.takeWayList[].code */
  takeWayCode?: string;
  /** orderType=2 必传 */
  addressId?: string;
  /** 团餐 beType=6 必传，取自 query-meal-assistance */
  gmServiceCode?: string;
  needTableware?: boolean;
  remark?: string;
  withOrder?: {
    cardId?: string;
    cardType?: number;
    membershipCode?: string;
    membershipSpecId?: string;
  };
}
