/**
 * 应用壳：侧栏（吉祥物 logo + 新对话 + 功能列表 + 可折叠历史对话 + 用户占位）
 * + 主区视图路由 + 右侧内置浏览器面板。
 * 2026-09-09 侧栏改版（老板口述定稿）：功能列表从上到下、历史列表可展开收起、
 * 底部用户框为 PK 昵称登录入口（P0 模拟登录；真微信授权 P1 接入）；「对话」不再占导航项——logo 与新对话即入口。
 * 会话搜索框保留（批次 3 交付项），收进历史对话区内。
 * 2026-09-13：功能列表补「对战」一项（老板实测「找不到入口」）——PK 页仍是独立页，
 * 这一项只负责把 hash 改成 `#/pk`，见下方 NAV 注释。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@sb/shared';
import { AccountBox } from '../components/AccountBox';
import { PixelSidebar } from '../components/PixelSidebar';
import { PlusIcon, ChevronDownIcon, ClockIcon } from '../components/icons';
import { NAV, PK_HASH, type View } from './nav';
import { api } from '../lib/api';
import { SessionList } from './SessionList';
import { ChatView } from '../features/chat/ChatView';
import { TermIndexProvider } from '../features/chat/term-index';
import { GlobalSearch } from '../features/search/GlobalSearch';
import { useActiveSessions } from '../features/chat/useActiveSessions';
import { Mascot } from '../features/chat/Mascot';
import { BRAND_NAME, BRAND_TAGLINE } from '../lib/brand';
import { SettingsView } from '../features/settings/SettingsView';
import { QuizBankPage } from '../features/quiz/QuizBankPage';
import { TermsPage } from '../features/terms/TermsPage';
import { PreviewPanel } from '../features/preview/PreviewPanel';
import { CoachDock } from '../features/coach/CoachDock';
import { TrialNotice } from '../components/TrialNotice';
import './app.css';

export function App() {
  const [view, setView] = useState<View>('chat');
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

  /** 词条卡 → 词条库的跨页入口：按词条名直达（知识图只存引用快照那套已随功能下线，此入口由对话页词条卡使用） */
  const openTerms = useCallback((keyword: string) => {
    setTermsKeyword(keyword);
    setView('terms');
  }, []);

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
    setView('chat');
    setCurrentId(s.id);
    await reloadSessions();
  }, [reloadSessions]);

  /**
   * 「向 AI 追问」（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §6）——**全仓唯一实现**：
   * 对话页的词条卡调这一条（`FollowUpAction`，见 `lib/api.ts`）。
   *
   * 服务端负责建 fork 会话 + 带原对话摘要 + 立刻起流；**App 只做两件事**：切过去、刷列表
   * （新会话得立刻出现在侧栏，否则用户会以为没建成）。
   *
   * ★ 必须声明在 `reloadSessions` **之后**（依赖它；`const` 不会提升）。
   * ★ `fromSessionId` 省缺 ＝ **当前正看着的那条会话**（`currentId`）：`TermIndexProvider`
   *   只在 `view === 'chat'` 时挂载，而那时 `currentId` 就是用户正看着的那条 ⇒ 没有"传空 id"
   *   的窗口；兜底报错仍留着——将来若把 Provider 提到壳外，静默分叉到 `null` 会很难查。
   * ★ **不吞错**：交给控件显示（"点了没反应"是这类跨页动作最糟的形态）。
   */
  const followUp = useCallback(
    async (term: string, question?: string, fromSessionId?: string) => {
      const from = fromSessionId ?? currentId;
      if (!from) throw new Error('还没有打开任何对话，无法从这里追问');
      const r = await api.sessions.fork(from, term, question);
      setView('chat');
      setCurrentId(r.sessionId);
      await reloadSessions(); // 内部已 try/catch，不会 reject
    },
    [currentId, reloadSessions],
  );

  const openSession = (id: string) => {
    setView('chat');
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
    <div className="sb-shell">
      <PixelSidebar>
        {/* 品牌 logo：吉祥物团子即入口（点击回对话主界面，对话不再占导航项） */}
        <button className="sb-logo" title="studentbuddy" onClick={() => setView('chat')}>
          <Mascot />
          <span className="sb-logo-name">
            {BRAND_NAME}
            <small>{BRAND_TAGLINE}</small>
          </span>
        </button>

        <button className="sb-new-chat" onClick={() => void newSession()}>
          <PlusIcon /> 新对话
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
                  window.location.hash = PK_HASH;
                  return;
                }
                setView(key);
                if (key === 'terms') setTermsKeyword('');
              }}
            >
              <Icon /> {label}
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
          <ClockIcon size={13} /> 历史对话
          <span className="sb-history-count">{visible.length}</span>
          <ChevronDownIcon size={13} className="sb-history-chev" />
        </button>
        {historyOpen && (
          <input
            className="sb-session-search"
            placeholder="搜索会话"
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
          emptyHint={query ? '没有匹配的会话' : null}
          onOpen={openSession}
          onTogglePin={(s) => void togglePin(s)}
          onRemove={(id) => void removeSession(id)}
        />

        {/*
          底部用户区：只有账号这一个身份入口（邮箱+密码，见 components/AccountBox）。
          登录前后会话列表的过滤条件不同，故登录/退出都要重载列表；
          PK 对战昵称不再在此处入口——PK 房间自带登录（features/pk/usePkIdentity），
          两套身份刻意不互相冒充，M4 才合并（AUTH-SPEC §0）。
        */}
        <AccountBox onAuthChange={() => void reloadSessions()} /><TrialNotice />
      </PixelSidebar>
      <main className="sb-main">
        {view === 'chat' && (
          /* 词条索引 Provider（契约 TERM-HIGHLIGHT-SPEC §5）：正文里的词条高亮与悬浮卡
             都从这里取索引。两个跨页动作也从这里注入——`openTerms`＝卡片「打开词条库」，
             `followUp`＝卡片「向 AI 追问」（契约 KNOWLEDGE-FOLLOWUP-SPEC §6）。
             挂在这里而不是 ChatView 内部，是为了让 ChatView 零 props 改动。 */
          <TermIndexProvider onOpenTerms={openTerms} onFollowUp={followUp}>
            <ChatView
              sessionId={currentId}
              sessionTitle={sessions.find((s) => s.id === currentId)?.title}
              onNewSession={() => void newSession()}
              onRoundDone={() => void reloadSessions()}
              onBusyChange={handleBusyChange}
            />
          </TermIndexProvider>
        )}
        {view === 'quiz' && <QuizBankPage />}
        {/* key 变化时重挂：从词条卡带词进来要重新初始化搜索框 */}
        {view === 'terms' && <TermsPage key={termsKeyword} initialKeyword={termsKeyword} />}
        {view === 'settings' && <SettingsView />}
      </main>
      <PreviewPanel />
      {/*
        复习督促小窗（v25 B+C+E）：挂在**主区之上、全局常驻**——它不是某个页面的附属功能，
        而是"随时能点开看一眼欠了多少"的悬浮件，故不随 `view` 切换挂载/卸载
        （卸载会断掉 SSE 与折叠状态，用户每次切页都看到它被重置）。
      */}
      <CoachDock />
    </div>
  );
}
