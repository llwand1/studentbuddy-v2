/**
 * 应用壳：侧栏（吉祥物 logo + 新对话 + 功能列表 + 可折叠历史对话 + 用户占位）
 * + 主区视图路由 + 右侧内置浏览器面板。
 * 侧栏改版：功能列表从上到下、历史列表可展开收起、
 * 底部用户框为 PK 昵称登录入口（模拟登录；真微信授权后续接入）；「对话」不再占导航项——logo 与新对话即入口。
 * 会话搜索框保留，收进历史对话区内。
 * 功能列表补「对战」一项（实测「找不到入口」）——PK 页仍是独立页，
 * 这一项只负责把 hash 改成 `#/pk`，见下方 NAV 注释。卡牌系统并入词条视图，不再单设导航项。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@sb/shared';
import { AccountBox } from '../components/AccountBox';
import { PixelSidebar } from '../components/PixelSidebar';
import { PlusIcon, ChevronDownIcon, ClockIcon } from '../components/icons';
import { NAV, PK_HASH, type View } from './nav';
import { LangToggle, useLandingLang } from './landing-lang';
import { SHELL } from './shell-copy';
import { api } from '../lib/api';
import { SessionList } from './SessionList';
import { GlobalSearch } from '../features/search/GlobalSearch';
import { useActiveSessions } from '../features/chat/useActiveSessions';
import { Mascot } from '../features/chat/Mascot';
import { BRAND_NAME } from '../lib/brand';
import { StudyWorkspaceScenes } from './StudyWorkspaceScenes';
import { StudyPortalTravel } from './StudyPortalTravel';
import { useStudyPortal } from './useStudyPortal';
import { PreviewPanel } from '../features/preview/PreviewPanel';
import { SourcePanel } from '../features/sources/SourcePanel';
import { CoachDock } from '../features/coach/CoachDock';
import { WaitDrill } from '../features/drill/WaitDrill';
import { LookupPopup } from '../features/lookup/LookupPopup';
import { useQuizWait } from '../features/drill/quiz-wait';
import { loadPomodoroState } from '../features/pomodoro/pomodoro-store';
import { HuntAlert } from '../features/hunt/HuntAlert';
import { GuideBeacon } from '../features/guide/GuideBeacon';
import { guideMainClass } from '../features/guide/guide-layout';
import { TrialNotice } from '../components/TrialNotice';
import { ReadingToolbar } from './ReadingToolbar';
import { useReadingLayout } from './useReadingLayout';
import { ReadingSplit } from './ReadingSplit';
import './app.css';
import './reading-workspace.css';

export function App() {
  /** 壳层框架文案（新对话 / 历史 / 搜索 / 导航标签）跟着全局语言走，词表见 app/shell-copy.ts */
  const { lang } = useLandingLang();
  const reading = useReadingLayout();
  const [view, setView] = useState<View>('chat');
  /** 回答收口的轮次计数（`HuntAlert` 据此重取地图看有没有刷出话题怪；契约 KNOWLEDGE-CONTINENT-SPEC §「话题怪」） */
  const [roundTick, setRoundTick] = useState(0);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  /** 会话标题过滤（纯前端，服务端列表本就 ≤ 单机量级）；空串 = 不过滤 */
  const [query, setQuery] = useState('');
  /**
   * 「回复中」徽标的两个信号源（2026-09-14 修 bug：原先只有前者，且它会被错标到刚点开的会话上）：
   * ① `localBusySid` —— **当前挂载的那间**在不在流（ChatView 上报，token 级零延迟）；
   * ② 服务端 `/api/chat/active` —— 生成不随切页中止（断开 SSE 只摘订阅者），
   *    切走的那间只能问服务端，2s 轮询兜住。两者都以正确的会话 id 标注、取并集见 `useActiveSessions`。
   */
  const [localBusySid, setLocalBusySid] = useState<string | null>(null);
  const busy = useActiveSessions(localBusySid);
  /** 历史对话列表展开/收起（默认展开） */
  const [historyOpen, setHistoryOpen] = useState(true);
  /** 词条库的搜索词（词条卡「打开词条库」入口带入；从导航点「词条」时清除） */
  const [termsKeyword, setTermsKeyword] = useState('');

  /** Standard navigation interrupts pending portal travel; terms starts with a clean search. */
  const applyView = useCallback((v: View) => {
    setView(v);
    if (v === 'terms') setTermsKeyword('');
  }, []);
  const portal = useStudyPortal(applyView);
  const goView = portal.navigate;
  const cancelTravel = portal.cancel;

  /** 词条卡 → 词条库的跨页入口：按词条名直达。 */
  const openTerms = useCallback((keyword: string) => {
    cancelTravel();
    setTermsKeyword(keyword);
    setView('terms');
  }, [cancelTravel]);

  // 番茄钟（docs/POMODORO-SPEC.md）：起应用拉一次状态。开钟 / 统计都在督促小窗抽屉里，`sb:pomodoro-open` 由 CoachDock 自己接
  useEffect(() => {
    void loadPomodoroState();
  }, []);
  /** 出题中的那间会话（§8）：与对话流的忙态并成一个信号喂给等待时刷词 */
  const quizWaitSid = useQuizWait();

  const reloadSessions = useCallback(async () => {
    try {
      setSessions(await api.sessions.list());
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void reloadSessions();
  }, [reloadSessions]);

  // 会话标题在首轮对话后由服务端更新：切回会话列表时刷新
  useEffect(() => {
    if (view === 'chat') void reloadSessions();
  }, [view, currentId, reloadSessions]);

  const newSession = useCallback(async () => {
    const s = await api.sessions.create();
    goView('chat');
    setCurrentId(s.id);
    await reloadSessions();
  }, [reloadSessions, goView]);

  /**
   * 「向 AI 追问」（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §6）——**全仓唯一实现**：
   * 对话页的词条卡调这一条（`FollowUpAction`，见 `lib/api.ts`）。
   *
   * 服务端负责建 fork 会话 + 带原对话摘要 + 立刻起流；**App 只做两件事**：切过去、刷列表
   * （新会话得立刻出现在侧栏，否则用户会以为没建成）。
   *
   * ★ 必须声明在 `reloadSessions` **之后**（依赖它；`const` 不会提升）。
   * ★ `fromSessionId` 省缺 ＝ 保留的对话 `currentId`：词条索引与 ChatView 同时保留，
   *   离开营地再回来仍指向同一会话；没有会话时如实报错，不能静默分叉到 `null`。
   * ★ **不吞错**：交给控件显示（"点了没反应"是这类跨页动作最糟的形态）。
   */
  const followUp = useCallback(
    async (term: string, question?: string, fromSessionId?: string) => {
      const from = fromSessionId ?? currentId;
      if (!from) throw new Error('还没有打开任何对话，无法从这里追问');
      const r = await api.sessions.fork(from, term, question);
      goView('chat');
      setCurrentId(r.sessionId);
      await reloadSessions(); // 内部已 try/catch，不会 reject
    },
    [currentId, reloadSessions, goView],
  );

  const openSession = (id: string) => {
    goView('chat');
    setCurrentId(id);
  };

  const removeSession = async (id: string) => {
    await api.sessions.remove(id).catch(() => undefined);
    if (currentId === id) setCurrentId(null);
    await reloadSessions();
  };

  const togglePin = async (s: Session) => {
    await api.sessions.pin(s.id, !s.pinned).catch(() => undefined);
    await reloadSessions();
  };

  /** 稳定引用：ChatView 的 useEffect 以它为依赖，箭头函数每次新建会导致 effect 反复触发 */
  const handleBusyChange = useCallback((busy: boolean, sid: string | null) => {
    setLocalBusySid(busy ? sid : null);
  }, []);

  const q = query.trim().toLowerCase();
  const visible = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;

  return (
    <div className={`sb-shell${reading.focused ? ' is-reading-focus' : ''}`}>
      <PixelSidebar collapsed={reading.collapsed}>
        {/* 品牌 logo：吉祥物团子即入口（点击回对话主界面，对话不再占导航项） */}
        <button className="sb-logo" title="studentbuddy" onClick={() => goView('chat')}>
          <Mascot />
          <span className="sb-logo-name">
            {BRAND_NAME}
            <small>{SHELL.brandTagline[lang]}</small>
          </span>
        </button>

        <button className="sb-new-chat" onClick={() => void newSession()}>
          <PlusIcon /> {SHELL.newChat[lang]}
        </button>

        {/* 功能列表（从上到下） */}
        <nav className="sb-nav">
          {NAV.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={view === key ? 'sb-nav-item active' : 'sb-nav-item'}
              onClick={() => {
                // PK 页不在本壳内：改 hash 让 main.tsx 换根渲染（返回时 PkApp 的「← 学习助手」把 hash 置回 #/）
                if (key === 'pk') {
                  cancelTravel();
                  window.location.hash = PK_HASH;
                  return;
                }
                goView(key);
              }}
            >
              <Icon /> {label[lang]}
            </button>
          ))}
        </nav>

        <hr className="sb-nav-divider" />

        {/* 历史对话（可展开/收起） */}
        <button
          className={historyOpen ? 'sb-history-head' : 'sb-history-head collapsed'}
          onClick={() => setHistoryOpen(!historyOpen)}
          aria-expanded={historyOpen}
        >
          <ClockIcon size={13} /> {SHELL.history[lang]}
          <span className="sb-history-count">{visible.length}</span>
          <ChevronDownIcon size={13} className="sb-history-chev" />
        </button>
        {historyOpen && (
          <input
            className="sb-session-search"
            placeholder={SHELL.searchChats[lang]}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {/* 全站搜索第二路（契约 docs/FTS-SPEC.md §3.4）：上面那路纯前端 title 过滤**保留不动**，两路并存。
            折叠历史区时传空串 ⇒ 面板整块不渲染（它自己判 `active`，不额外占 App 的行数预算）。 */}
        <GlobalSearch query={historyOpen ? query : ''} onOpenSession={openSession} onOpenTerm={openTerms} />
        <SessionList
          sessions={visible}
          activeId={view === 'chat' ? currentId : null}
          collapsed={!historyOpen}
          busy={busy}
          emptyHint={query ? SHELL.noMatch[lang] : null}
          onOpen={openSession}
          onTogglePin={(s) => void togglePin(s)}
          onRemove={(id) => void removeSession(id)}
        />

        {/*
          底部用户区：只有账号这一个身份入口（邮箱+密码，见 components/AccountBox）。
          登录前后会话列表的过滤条件不同，故登录/退出都要重载列表；
          PK 对战昵称不再在此处入口——PK 房间自带登录（features/pk/usePkIdentity），
          两套身份刻意不互相冒充，后续才合并（AUTH-SPEC §0）。
        */}
        <AccountBox onAuthChange={() => void reloadSessions()} /><TrialNotice />
        {/* 全局语言切换（2026-09-28）：侧栏最底一行，任何视图下都在。样式复用 .landing-lang*（见 landing-lang 头注的命名债） */}
        <span className="sb-lang-bar"><LangToggle /></span>
      </PixelSidebar>
      <section className="sb-workspace" aria-label={SHELL.readingTools[lang]}>
        <ReadingToolbar layout={reading} sessionId={currentId}
          title={view === 'chat' ? sessions.find((s) => s.id === currentId)?.title || SHELL.newChat[lang] : NAV.find((n) => n.key === view)?.label[lang]}>
          <GuideBeacon
            lang={lang}
            view={view}
            sessionId={currentId}
            onView={goView}
            onNewSession={() => void newSession()}
            onFreshChat={() => {
              goView('chat');
              setCurrentId(null);
            }}
          />
          <CoachDock />
          <HuntAlert active={view === 'chat'} roundTick={roundTick} onGoContinent={() => goView('continent')} />
        </ReadingToolbar>
        <div className="sb-reading-content">
          <main className={guideMainClass(view)}>
            <StudyWorkspaceScenes view={view} currentId={currentId} sessions={sessions} termsKeyword={termsKeyword}
              travelling={portal.travel?.destination ?? null} onEnter={portal.enter}
              onNewSession={() => void newSession()} onRoundDone={() => { void reloadSessions(); setRoundTick(n => n + 1); }}
              onBusyChange={handleBusyChange} onOpenTerms={openTerms} onFollowUp={followUp} onGoContinent={() => goView('continent')} />
            <StudyPortalTravel travel={portal.travel} onFinish={portal.finish} />
          </main>
          <ReadingSplit />
          <PreviewPanel />
          {/* 资料溯源（docs/SOURCE-TRACE-SPEC.md）：与演示面板同占右栏；有演示时它让位，演示关掉自动回来 */}
          <SourcePanel />
        </div>
      </section>
      {/*
        等待时刷词（docs/WAIT-DRILL-SPEC.md）：全局常驻，手机只手动开，桌面等待 2 秒后按许可弹出；
        而弹窗、配乐与本局战绩不该因为切页被重置；`active` 只管"自动弹"是否允许（不在对话页不弹）。
      */}
      <WaitDrill busySessionId={localBusySid ?? quizWaitSid} active={view === 'chat' && !reading.focused} />
      {/* 划词速查小窗：常驻壳层，一次只开一个（LOOKUP-SPEC §5） */}
      <LookupPopup />
    </div>
  );
}
