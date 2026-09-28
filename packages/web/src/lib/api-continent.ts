/**
 * api-continent — 开拓制知识大陆的 REST 封装（服务端 `routes/continent-world.ts` 的形状镜像）。
 * ★ 存档只记「玩家做过的事」；地貌 / 野怪 / 建筑 / 开拓令由 `@sb/shared` 的纯函数在前端现算，
 *   与服务端校验用的是同一份函数。
 */
import type { WorldSave } from '@sb/shared';
import { request } from './api-request.js';

export interface WorldPayload {
  world: WorldSave;
  termCount: number;
  day: number;
}

export type Cell = { row: number; col: number };

export type DelveQuestion =
  | { type: 'judge'; prompt: string; statement: string }
  | { type: 'choice'; prompt: string; options: string[] };

export interface DelveAsk {
  answer: string;
  source: 'ai' | 'fallback';
  questions: DelveQuestion[];
  term: string;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const continentApi = {
  world: () => request<WorldPayload>('/api/continent/world'),
  explore: (row: number, col: number) => post<WorldPayload & { fresh: Cell[] }>('/api/continent/explore', { row, col }),
  slay: (row: number, col: number, day: number) =>
    post<WorldPayload & { fresh: Cell[]; species: string }>('/api/continent/slay', { row, col, day }),
  delve: (row: number, col: number, question: string) => post<DelveAsk>('/api/continent/delve', { row, col, question }),
  delveFinish: (row: number, col: number, answers: Array<number | boolean | null>) =>
    post<Partial<WorldPayload> & { passed: boolean; wrong: number[]; lv?: number }>('/api/continent/delve/finish', {
      row,
      col,
      answers,
    }),
};
