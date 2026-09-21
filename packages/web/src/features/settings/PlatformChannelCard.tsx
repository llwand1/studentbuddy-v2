/**
 * PlatformChannelCard — **一键默认设置**（免费通道）＋ 免费额度剩余量。
 *
 * ── 为什么单独一张卡而不是塞进「角色模型绑定」那张表 ────────────────────────
 * 那一节是**逐角色精细调**（8 行、每行三列）；本卡是**一键粗调**（一个按钮）。
 * 两者的用户心智完全不同：前者"我知道我要哪个模型"，后者"我只想让它先跑起来"。
 * 混在一张表里，一键按钮会被当成表头的一个附属动作，而它其实是**新用户的第一入口**。
 * ★ 也与仓内既有的"每个设置分区一个卡片组件"惯例一致（`AnswerStyleCard` / `ToolsCard` …）。
 *
 * ── 这一卡要替老板守住的三条 ───────────────────────────────────────────────
 * ① **key 不可见、也取不到**：本卡只调 `POST /roles/default`，它**一个字节的凭据都不落库**；
 *    平台 key 始终只在服务端 env。故界面上没有任何"显示/复制密钥"的入口——不是漏做了，
 *    是**刻意没有**（老板原话：「一键配置后 key 是用户不可见的，也无法通过其他手段获取」）。
 * ② **额度要看得见**：每 5 小时 250 次是**滚动窗口**，用户看不到剩余量就只能靠撞墙发现。
 * ③ **用完有出路**：超限不是死路——上方「服务商」一节就是 BYOK 通道，文案要指过去。
 * ④ **覆盖要问一声**（2026-09-21 老板拍板加）：这个按钮会**覆盖用户已有的 8 行绑定**
 *    （含自填模型名），而它偏偏是**新用户第一眼就会点的实心主色按钮**。故做成两段式：
 *    首屏只进确认态、确认键才真动手，且代价说明用 `role="alert"` 念出来。
 */
import { useEffect, useState } from 'react';
import type { PlatformQuotaState } from '@sb/shared';
import { api } from '../../lib/api';
import './settings.css';

/** 把"最早一笔滑出窗口"的时刻说成人话。★ 是**滚动回补**，不是整点重置（见 shared/platform-quota）。 */
function remainText(resetAt: number): string {
  const ms = resetAt - Date.now();
  if (ms <= 0) return '现在';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

export function PlatformChannelCard({
  flash,
  onConfigured,
}: {
  flash: (ok: boolean, text: string) => void;
  /** 一键配完要刷新上面那张绑定表——否则用户看到的是"点了没反应"（表还是旧的） */
  onConfigured: () => void;
}) {
  const [quota, setQuota] = useState<(PlatformQuotaState & { limited: boolean }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * ★ 二次确认态（2026-09-21 老板拍板加）。
   *
   * 为什么必须有：这个动作**会覆盖用户已有的 8 行绑定**——含他自己手填的模型名，
   * `ON CONFLICT DO UPDATE` 把 `model` 一并清空。而它是个**实心主色大按钮**，
   * 落在「免费通道」这张卡里，是**新用户第一眼就会点**的那个。没有确认，
   * 一个已经精细调过 8 个角色的老用户误点一下，配置就没了。
   *
   * ★ 用**两段式按钮**而不是 `window.confirm`：本仓已有先例（`terms/DomainBar.tsx` 的
   *   两段式删除，理由写在那个文件头注里）——原生弹窗在本地 Web 里观感割裂。
   * ★ 状态放在本组件内、不进 `SettingsView`：确认态是**这个按钮自己的**瞬时 UI 状态，
   *   提上去只会让父组件多一个与它无关的 state。
   */
  const [confirming, setConfirming] = useState(false);

  const loadQuota = async () => {
    try {
      setQuota(await api.providers.quota());
    } catch {
      // 额度只是**提示信息**，读不到不该打断整个设置页（用户真正要配的东西在别的卡片里）
      setQuota(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadQuota();
  }, []);

  /**
   * ★ 只由**确认键**调用（首屏那枚「一键默认设置」只负责进入确认态）。
   * 无论成败都退回初始态：失败时让用户**重新读一遍那句后果**再决定要不要重试，
   * 而不是停在一个"再点一下就生效"的确认态上（那时他已经忘了这按钮会覆盖什么）。
   */
  const oneClick = async () => {
    setBusy(true);
    try {
      const r = await api.providers.oneClickDefault();
      flash(true, `已一键配好 ${r.roles} 个角色：走免费通道，用 ${r.model}`);
      onConfigured();
      await loadQuota();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const left = quota ? Math.max(0, quota.limit - quota.used) : 0;
  const state = loading
    ? '读取额度中…'
    : !quota
      ? '额度读取失败（不影响使用）'
      : quota.limited
        ? `本窗口已用 ${quota.used} / ${quota.limit} 次，剩余 ${left} 次；最早一笔将在 ${remainText(quota.resetAt)}后可再调用`
        : '本地模式：不计入免费额度';

  return (
    <section className="settings-sec">
      <h3>免费通道 · 一键默认设置</h3>
      <p className="settings-hint">
        一键把 8 个学习环节全部绑到平台免费通道，使用服务默认模型（<b>agnes-2.5-flash</b>）。
        额度<b>每 5 小时 250 次</b>、按你的账号单独计算；用完或想换更好的模型，就在上方「服务商」里
        配自己的 key，再回「角色模型绑定」逐项指定。
        <br />
        平台密钥由服务方托管——界面不显示、接口不返回，你也取不到；本操作只写「用哪个服务商、用哪个模型」，
        <b>不会把密钥存进你的账号</b>。
      </p>

      <div className="settings-actions">
        {confirming ? (
          <>
            <button className="settings-add danger" disabled={busy} onClick={() => void oneClick()}>
              {busy ? '配置中…' : '确认覆盖'}
            </button>
            <button className="settings-cancel" disabled={busy} onClick={() => setConfirming(false)}>
              取消
            </button>
          </>
        ) : (
          <button className="settings-add" disabled={busy || loading} onClick={() => setConfirming(true)}>
            一键默认设置
          </button>
        )}
        <span className="settings-state">{state}</span>
      </div>

      {confirming && (
        // `role="alert"`：这句是**代价说明**，不是补充阅读材料。它出现的那一刻必须被读屏念出来
        // ——确认态本身没有任何别的视觉位移（按钮原地换了文案），不念出来等于确认了个寂寞。
        <p className="settings-hint warn" role="alert">
          ⚠ 这一步会<b>覆盖你现有的 8 个角色绑定</b>——包括你自填的模型名，一律改回免费通道的默认模型
          （<b>agnes-2.5-flash</b>）。想保留某个角色的自选模型，先取消，改完再逐行调。确定继续吗？
        </p>
      )}
    </section>
  );
}
