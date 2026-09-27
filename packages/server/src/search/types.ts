/**
 * search/types — 联网搜索的共享形状。
 *
 * 单独立一个文件只为一个理由：`SearchResult` 同时被聚合层（`index.ts`）、各 provider 实现
 * （`bing-channel.ts` 等）和下游消费者（`learning/quiz-search.ts`、`pk/judge.ts`）引用，
 * 而 provider 实现反过来 import 聚合层会形成环。类型放在谁都不依赖的位置，环就断了。
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 提供方标识（结果呈现溯源） */
  source: string;
}
