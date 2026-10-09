import { readFileSync } from 'node:fs';
import type { MealDetail, Menu, Nutrition, Store } from '../src/types.js';
import { parseNutritionTable } from '../src/nutrition.js';

const here = (p: string) => new URL(p, import.meta.url);

export function loadMenu(): Menu {
  return JSON.parse(readFileSync(here('../fixtures/meals.sample.json'), 'utf-8')) as Menu;
}

export function loadNutrition(): Nutrition[] {
  return parseNutritionTable(readFileSync(here('../fixtures/nutrition.sample.txt'), 'utf-8'));
}

export function loadMealDetail(): MealDetail {
  return JSON.parse(readFileSync(here('../fixtures/meal-detail.sample.json'), 'utf-8')) as MealDetail;
}

/** 与深圳市科技园真实返回一致的门店样例 */
export function sampleStores(): Store[] {
  return [
    {
      storeCode: '1420762',
      storeName: '麦当劳深圳同方信息港餐厅',
      address: '科技园北区朗山路11号同方信息港E栋G层5号商铺',
      distance: 403,
      businessStatus: true,
      businessStartTime: '07:00',
      businessEndTime: '23:00',
      longitude: 0,
      latitude: 0,
      reservation: true,
      reservationTimeOptions: [
        { date: '2026-10-09', today: true, reservationOptionText: '下午茶(14:44至16:45)，夜市(17:14至21:45)，宵夜(22:14至22:46)' },
        { date: '2026-10-10', today: false, reservationOptionText: '早餐(07:14至10:15)，午餐(10:44至14:15)，下午茶(14:44至16:45)，夜市(17:14至21:45)，宵夜(22:14至22:46)' },
      ],
    },
    {
      storeCode: '1421057',
      storeName: '麦当劳深圳松坪山餐厅',
      address: '西丽街道松坪山社区松坪山群芳街40号',
      distance: 810,
      businessStatus: true,
      businessStartTime: '00:00',
      businessEndTime: '23:59',
      longitude: 0,
      latitude: 0,
      reservation: true,
      reservationTimeOptions: [
        { date: '2026-10-09', today: true, reservationOptionText: '下午茶(14:44至16:45)，夜市(17:14至21:45)，宵夜(22:14至23:59)' },
        { date: '2026-10-10', today: false, reservationOptionText: '宵夜(00:00至04:45,22:14至23:59)，早餐(05:14至10:15)，午餐(10:44至14:15)，下午茶(14:44至16:45)，夜市(17:14至21:45)' },
      ],
    },
    {
      storeCode: '1420888',
      storeName: '麦当劳深圳科技园长园得来速餐厅',
      address: '粤海街道科技园社区高新中一道2号',
      distance: 732,
      businessStatus: false,
      businessStartTime: '07:00',
      businessEndTime: '22:00',
      longitude: 0,
      latitude: 0,
      reservation: true,
      beCode: 'DT-1420888',
    },
  ];
}

export const CHANNEL = { storeCode: '1420762', orderType: 1 as const, beType: 1 as const };
