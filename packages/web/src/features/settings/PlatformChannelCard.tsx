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
        <button className="settings-add" disabled={busy || loading} onClick={() => void oneClick()}>
          {busy ? '配置中…' : '一键默认设置'}
        </button>
        <span className="settings-state">{state}</span>
      </div>
    </section>
  );
}
