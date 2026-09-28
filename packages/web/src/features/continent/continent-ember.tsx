/**
 * features/continent/continent-ember — 「余烬笺 · 意外发现」在知识大陆上的全部呈现（2026-09-28）。
 *
 * - `useContinentEmber`：取今天那簇异火（服务端决定烧哪张笺、落在哪格）；英雄走到相邻格时自动揭开；
 *   「度过一夜」预览下一簇；收入卡册 / 添柴致谢 / 不想再看。
 * - `EmberDialog`：揭开后的那张笺（词条 + 作者用自己的话写的理解 + 署名）。
 * - `TileDetail`：点自己的地块看详情，并可给这条词条**写一张余烬笺**（显式动作＝同意公开给别的玩家）。
 * ★ 拆成独立文件：`ContinentPage.tsx` 贴着 `.tsx ≤300` 红线。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { EmberNote, EmberSpot } from '../../lib/api-ember';
import type { HeroCell } from './useContinentHero';
import { tileStatusText, type ContinentTileView } from './continent-view';

export interface EmberMark {
  row: number;
  col: number;
  hue: string;
}

export function useContinentEmber(hero: HeroCell | null, onNotice: (t: string) => void, onLibraryChanged: () => void) {
  const [spot, setSpot] = useState<EmberSpot | null>(null);
  const [open, setOpen] = useState(false);
  const [night, setNight] = useState(0);
  const revealed = useRef<string | null>(null);

  const load = useCallback(async (n: number) => {
    try {
      const r = await api.ember.spot(n);
      setSpot(r.spot);
    } catch {
      setSpot(null); // 取不到异火不影响大陆本身
    }
  }, []);
  useEffect(() => {
    void load(night);
  }, [load, night]);

  // 靠近即揭开：英雄走到火的相邻格（含同格）时自动打开，每簇只自动开一次
  useEffect(() => {
    if (!spot || !hero) return;
    const d = Math.abs(hero.row - spot.row) + Math.abs(hero.col - spot.col);
    if (d <= 1 && revealed.current !== `${night}|${spot.note.id}`) {
      revealed.current = `${night}|${spot.note.id}`;
      setOpen(true);
    }
  }, [hero, spot, night]);

  /** 点击分流用：点到火那一格 ⇒ 够近就打开，不够近就提示走过去（返回 true 表示这一下被消费了） */
  const pickCell = useCallback(
    (row: number, col: number): boolean => {
      if (!spot || spot.row !== row || spot.col !== col) return false;
      const d = hero ? Math.abs(hero.row - row) + Math.abs(hero.col - col) : 99;
      if (d <= 1) setOpen(true);
      else onNotice('那簇颜色不对的火……走到它旁边，才看得清里面浮着的笺。');
      return d > 1 ? false : true;
    },
    [spot, hero, onNotice],
  );

  const keep = useCallback(async () => {
    if (!spot) return;
    const r = await api.ember.keep(spot.note.id);
    setSpot({ ...spot, kept: true });
    onNotice(r.already ? `你的库里已经有「${spot.note.term}」了——没动你的释义，只记下这张笺。` : `「${spot.note.term}」收入卡册——这张卡记得它来自「${spot.note.sign}」。`);
    onLibraryChanged();
  }, [spot, onNotice, onLibraryChanged]);

  const thank = useCallback(async () => {
    if (!spot) return;
    const r = await api.ember.thank(spot.note.id);
    setSpot({ ...spot, thanked: true, note: { ...spot.note, thanks: r.thanks ?? spot.note.thanks } });
    onNotice(`你往「${spot.note.sign}」的火里添了一根柴——对方会在自己的大陆上看到。`);
  }, [spot, onNotice]);

  const hide = useCallback(async () => {
    if (!spot) return;
    await api.ember.hide(spot.note.id);
    setOpen(false);
    setSpot(null);
    onNotice('这簇火不会再出现在你的大陆上了。');
  }, [spot, onNotice]);

  const mark: EmberMark | null = spot ? { row: spot.row, col: spot.col, hue: spot.note.hue } : null;
  return { spot, mark, open, close: () => setOpen(false), pickCell, keep, thank, hide, nextNight: () => setNight((n) => (n + 1) % 8), night };
}

export function EmberDialog(props: {
  spot: EmberSpot;
  onKeep: () => Promise<void>;
  onThank: () => Promise<void>;
  onHide: () => Promise<void>;
  onClose: () => void;
}) {
  const { spot } = props;
  const n = spot.note;
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="continent-modal" role="dialog" aria-modal="true" aria-label={`余烬笺 ${n.term}`}>
      <div className={`continent-modal-card continent-ember-card ember-hue-${n.hue}`}>
        <header className="continent-modal-head">
          <span className="continent-modal-title">
            火焰里浮出一张笺——
            <small>{n.domain || '未分领域'}</small>
          </span>
          <button className="continent-btn ghost" onClick={props.onClose}>
            关闭
          </button>
        </header>
        <h3 className="continent-ember-term">{n.term}</h3>
        <p className="continent-ember-body">「{n.body}」</p>
        <p className="continent-ember-sign">
          —— 留笺人 <b>{n.sign}</b> · {n.createdAt.slice(0, 10)}
          {n.thanks > 0 ? ` · 已有 ${n.thanks} 人添柴` : ''}
        </p>
        <footer className="continent-modal-foot">
          <button className="continent-btn primary" disabled={busy || spot.kept} onClick={() => void run(props.onKeep)()}>
            {spot.kept ? '已收入卡册' : '收入卡册'}
          </button>
          <button className="continent-btn" disabled={busy || spot.thanked} onClick={() => void run(props.onThank)()}>
            {spot.thanked ? '已添柴致谢' : '添一根柴（致谢）'}
          </button>
          <button className="continent-btn ghost" disabled={busy} onClick={() => void run(props.onHide)()}>
            不想再看
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 地块详情 + 写余烬笺 */
export function TileDetail({ tile, onClose, onNotice }: { tile: ContinentTileView; onClose: () => void; onNotice: (t: string) => void }) {
  const [mine, setMine] = useState<EmberNote | null>(null);
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState('');
  const [sign, setSign] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setWriting(false);
    api.ember
      .mine()
      .then((r) => {
        if (!alive) return;
        const hit = r.notes.find((x) => x.term === tile.term && x.domain === tile.domain) ?? null;
        setMine(hit);
        setBody(hit?.body ?? '');
        setSign(hit?.sign ?? '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tile.id, tile.term, tile.domain]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.ember.write(tile.id, body, sign || undefined);
      setMine(r.note);
      setWriting(false);
      onNotice(`余烬笺已点燃——「${tile.term}」会化作一簇${r.note.sign ? `署名「${r.note.sign}」的` : ''}火，出现在别的旅人的大陆上。`);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="continent-detail">
      <span className="continent-modal-title">
        {tile.term}
        <small>
          {tile.domain} · {tileStatusText(tile)}
        </small>
      </span>
      <p className="continent-detail-def">{tile.definition}</p>
      {mine && !writing && (
        <p className="continent-ember-mine">
          你的余烬笺：「{mine.body}」—— {mine.sign}
          {mine.thanks > 0 ? ` · ${mine.thanks} 位旅人添过柴` : ' · 还没有人路过'}
        </p>
      )}
      {writing && (
        <div className="continent-ember-write">
          <textarea
            className="continent-input"
            rows={3}
            maxLength={200}
            value={body}
            placeholder="用你自己的话写下你对它的理解（8～200 字）。它会化作一簇异火，出现在别的玩家的大陆上。"
            onChange={(e) => setBody(e.target.value)}
          />
          <input className="continent-input" maxLength={12} value={sign} placeholder="署名（留空则用昵称）" onChange={(e) => setSign(e.target.value)} />
          <p className="continent-ember-hint">写下即表示同意公开：别的玩家会看到这段话和你的署名。随时可以撤回。</p>
        </div>
      )}
      <div className="continent-detail-acts">
        {writing ? (
          <button className="continent-btn primary" disabled={busy} onClick={() => void save()}>
            点燃余烬笺
          </button>
        ) : (
          <button className="continent-btn" onClick={() => setWriting(true)}>
            {mine ? '改写余烬笺' : '留一张余烬笺'}
          </button>
        )}
        {mine && !writing && (
          <button
            className="continent-btn ghost"
            onClick={() =>
              void api.ember.remove(mine.id).then(() => {
                setMine(null);
                onNotice('余烬笺已撤回，那簇火熄了。');
              })
            }
          >
            撤回
          </button>
        )}
        <button className="continent-btn ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}

/** 横幅：今天大陆上有没有异火、「度过一夜」 */
export function EmberBanner({ ember }: { ember: ReturnType<typeof useContinentEmber> }) {
  if (!ember.spot) return null;
  return (
    <p className="continent-banner continent-ember-banner">
      {ember.night === 0 ? '今夜' : `第 ${ember.night} 夜后`}，大陆上燃着一簇颜色不对的火——那是另一位旅人留下的余烬笺，走到它旁边就能读到。
      <button type="button" className="continent-btn ghost" onClick={ember.nextNight}>
        度过一夜
      </button>
    </p>
  );
}
