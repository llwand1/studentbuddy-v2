/**
 * CardWall — 卡墙：词条收藏的游戏化视图（契约 `docs/TERM-CARDS-SPEC.md` §2／§8 的 T2 落地点）。
 *
 * ★ **数字是唯一的常驻读数**（T1 预算，契约 §8）：一轮聊天命中三个词，墙上三行的张数与
 *   星数就地变了，**不放任何动画**——这个动作每天发生上百次，给"又攒到一张卡"播动画
 *   等于让最有价值的信号自己贬值（也是 `web-animation-design` 的频次判据）。
 * ★ **只有升星那一刻才值得 T2**：卡数跨过了 `2^n` 门槛是低频事件（★3 要 8 张、★4 要 16 张，
 *   按日均 1～3 次提及算，一条词条一天最多跨一档），所以粒子／屏震／星位错帧只在这一刻、
 *   **只在这一张卡**上放。触发条件写在下面 `useUpgraded`：本帧星 > 上一帧星，且**不是首见**
 *   （首见＝这张卡刚进墙，它没有"升上来"这件事可庆祝）。
 * ⚠️ 星位在非 burst 状态下**不画 8 个槽**：全库 ≤500 条各挂 8 个内联 SVG（4000 个节点）是
 *   这条屏唯一没必要付的成本，而 ★8 只有满星用户才用得到槽位。平时一个图标 + 数字，
 *   升星那一刻才换出完整星带来逐颗点亮。
 *
 * ★ 领域取色用 `row.domIndex`（服务端算的在册序号），**这里不按领域名排序**——见
 *   `learning/domains.ts:domainOrdinals` 的注释：现成的领域列表行序是 `count DESC`，
 *   跟着它上色会出现"昨天蓝的领域今天变红"。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CardWallRow } from '../../lib/api-cards';
import { StarIcon, SparkleIcon, MascotIcon } from '../../components/game-icons';
import '../../styles/game.css';
import './cards-view.css';

/** T2 爆发的总时长：粒子轨道最长 520ms + 最大延迟 198ms，取整到 800ms 后摘掉 burst 类 */
const BURST_MS = 800;

/** 底边/圆点的领域档：`domIndex` 越界或未登记（null）都走中性 `gm-d0`（色环只有 5 支彩） */
function domClass(domIndex: number | null): string {
  return domIndex === null || domIndex < 0 || domIndex >= 5 ? 'gm-d0' : `gm-d${domIndex + 1}`;
}

/**
 * 找出「本帧刚升星」的那些词条。
 * ★ 上一帧的星存在 ref 里而不是靠 `usePrevious(rows)`：rows 每次 `/state` 都是新数组，
 *   任何按数组比较的写法都会全库重算，而这里要的比较只有"同一条词条的星变没变"。
 */
function useUpgraded(rows: readonly CardWallRow[]): string[] {
  const prev = useRef(new Map<string, number>());
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const up: string[] = [];
    for (const r of rows) {
      const before = prev.current.get(r.termId);
      if (before !== undefined && r.card.star > before) up.push(r.termId);
      prev.current.set(r.termId, r.card.star);
    }
    // ★ 只登记、不改类名以外的状态：升星的人为数留在下面 `burst` 的清理里
    if (up.length === 0) return;
    setIds(up);
    const t = setTimeout(() => setIds([]), BURST_MS);
    return () => clearTimeout(t);
  }, [rows]);
  return ids;
}

function Stars({ n }: { n: number }) {
  return (
    <span className="gm-stars" aria-label={`${n} 星`}>
      {Array.from({ length: n }, (_, i) => (
        // key 用序号：这一串是纯装饰的槽位，不随数据增删重排（升星时整串重画，不需要稳定身份）
        <i key={i} className="on">
          <StarIcon size={9} fill="currentColor" />
        </i>
      ))}
    </span>
  );
}

function Card({ row, bursting }: { row: CardWallRow; bursting: boolean }) {
  const c = row.card;
  return (
    <article
      className={`cv-card gm-card ${domClass(row.domIndex)}${bursting ? ' gm-burst' : ''}`}
      data-r={c.rarity}
    >
      <h3 className="gm-card-name" title={row.term}>
        {row.term}
      </h3>
      <p className="gm-card-def">{row.definition}</p>
      <span className="gm-card-dom" title={row.domain}>
        {row.domain}
      </span>
      <div className="gm-card-foot">
        <span className="gm-card-count">{c.cards} 张</span>
        {bursting ? <Stars n={c.star} /> : <span className="cv-starline"><StarIcon size={12} fill="currentColor" />{c.star}</span>}
      </div>
      {/* T1 的落点：升星之外的一切变化就是这一行字换个数，不动画 */}
      <span className="gm-card-next">
        {c.progress.needed === null ? '已满星' : `差 ${c.progress.needed} 张到 ★${c.progress.nextStar}`}
      </span>
      {/* 粒子与冲击环只在 burst 帧挂载：常驻的话就是 500 张 × 13 个合成层元素。
          ★ 粒子必须在**自己的容器**里数 `nth-child`：`game.css` 的 12 条错帧键在
            `.gm-burst .gm-spark:nth-child(1..12)` 上，环和粒子做兄弟的话粒子会从
            `nth-child(2)` 起算——整圈延迟错一位，几何看着没坏但节奏是歪的。
            容器用 `display: contents`，不占 flex 槽、不挤 gap。 */}
      {bursting && (
        <>
          <i className="gm-ring" aria-hidden="true" />
          <span className="cv-sparks gm-burst" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} className="gm-spark" />
            ))}
          </span>
        </>
      )}
    </article>
  );
}

export function CardWall({ rows, logSince }: { rows: CardWallRow[]; logSince: string | null }) {
  const [domain, setDomain] = useState('');
  const [kw, setKw] = useState('');
  const [sortBy, setSortBy] = useState<'cards' | 'term'>('cards');
  const bursting = useUpgraded(rows);
  const burstSet = useMemo(() => new Set(bursting), [bursting]);

  const domains = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.domain, (seen.get(r.domain) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }, [rows]);

  const shown = useMemo(() => {
    const k = kw.trim().toLowerCase();
    const out = rows.filter((r) => (!domain || r.domain === domain) && (!k || r.term.toLowerCase().includes(k)));
    // ★ 排序口径明写：卡数同数按名字升序，保证同一份数据每次排出来一样（列表跳动比不排序难读）
    return out.sort((a, b) =>
      sortBy === 'cards' ? b.card.cards - a.card.cards || (a.term < b.term ? -1 : 1) : a.term < b.term ? -1 : 1,
    );
  }, [rows, domain, kw, sortBy]);

  return (
    <section className="cv-wall">
      <div className="cv-wall-head">
        <div className="cv-wall-title">
          <span className="gm-eyebrow">Card Wall</span>
          <h2 className="cv-h2">
            <SparkleIcon size={20} /> 卡墙 {rows.length} 张
          </h2>
          {/* 契约 §7.4：口径 1（`usage_count` 含建表前的历史）必然让"提及 20 次、卡数 8 张"成为
              正常现象。这句话不是装饰——不说，用户读到的是"少算了 12 张"。 */}
          <p className="cv-since">
            {logSince
              ? `卡牌统计自 ${logSince}（只数这之后的每一次接触，更早的提及没有留时间戳，不算）`
              : '还没有任何接触流水：聊一轮、或复习一次，墙上就会开始长。'}
          </p>
        </div>
        <div className="cv-wall-tools">
          <input
            className="cv-input"
            placeholder="搜词条"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            aria-label="搜索词条"
          />
          <button
            type="button"
            className="gm-btn gm-ghost gm-sm"
            onClick={() => setSortBy((s) => (s === 'cards' ? 'term' : 'cards'))}
          >
            {sortBy === 'cards' ? '按张数' : '按名字'}
          </button>
        </div>
      </div>

      {domains.length > 1 && (
        <div className="cv-chips" role="group" aria-label="按领域筛选">
          <button type="button" className={`cv-chip${domain === '' ? ' on' : ''}`} onClick={() => setDomain('')}>
            全部 {rows.length}
          </button>
          {domains.map(([name, n]) => (
            <button
              key={name}
              type="button"
              className={`cv-chip${domain === name ? ' on' : ''}`}
              onClick={() => setDomain(domain === name ? '' : name)}
            >
              {name} {n}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="cv-empty">
          <MascotIcon size={22} /> {rows.length === 0 ? '库里还没有词条——先去对话或词条库收几个词。' : '这个筛选条件下没有词条。'}
        </p>
      ) : (
        // ★ `gm-shake` 挂在这个**只包住墙**的包裹层上，绝不挂 body：给 body 加 transform
        //   会让所有 `position: fixed`（开盒遮罩、toast）跟着抖，那是另一类事故。
        <div className={`cv-wall-shift${bursting.length ? ' gm-shake' : ''}`}>
          <div className="gm-wall">
            {shown.map((r) => (
              <Card key={r.termId} row={r} bursting={burstSet.has(r.termId)} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
