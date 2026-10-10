/**
 * 「公开字节里不许出现内部字样」这条红线的**唯一一份**词表（`docs/SEO-SPEC.md` §5 第 12 条）。
 *
 * ★ 为什么要有这么一个模块：同一族红线要扫六类字节——SPA 外壳、词条页、目录页、更新页与订阅、
 *   英文侧那一批，以及**构建产物里的 JS／CSS**（issue #8 起。此前一直不扫，
 *   依据是「压缩器会剥注释」这一没验过的推断——注释确实剥了，字符串常量原样留着）。
 *   词表抄四遍，就会有一遍是旧的。这里一份，锁都从它取。
 * ★ 词表按「漏出去各自坏在哪」分四组，不是一张扁平清单：
 *   ①仓内路径与命令＝把实现面交出去；②服务器形状＝运维信息泄露（本站是 self-host，
 *   这条同时是产品叙事的一部分）；③口令字样＝真正的安全事故；
 *   ④拉丁写法＝①②③全是中文与路径形状，英文页需要一个只收「本仓的英文口头词」的一组。
 * ★ 这条锁**只能挡住已经想到的写法**，挡不住没想到的说法——所以它旁边那条「内容源是手写清洗表」
 *   才是主结构：没写进语料的东西，正则再漏也漏不出去。
 */

/** ① 仓内路径与命令 */
const REPO_SHAPES: readonly RegExp[] = [/\bdocs\//, /\bpackages\//, /\bsrc\//, /\bnode_modules\b/, /\btools\//, /npm run/, /\bnpx\b/, /vite build/, /\btsx\b/, /git push/];

/** ② 服务器与部署形状（含本机开发端口） */
const SERVER_SHAPES: readonly RegExp[] = [
  /systemd/,
  /systemctl/,
  /\.service\b/,
  /\/opt\//,
  /\/var\/log/,
  /\/etc\//,
  /Caddyfile/,
  /\bcaddy\b/i,
  /127\.0\.0\.1/,
  /\blocalhost\b/i,
  /\bssh\b/,
  /:18791\b/,
  /:5173\b/,
  /:8787\b/,
  /:5199\b/,
  /:14210\b/,
];

/** ③ 口令与密钥字样 */
const SECRET_SHAPES: readonly RegExp[] = [/password/i, /\bsecret\b/i, /token\s*[:=]/i, /\bsk-[A-Za-z0-9]/, /\bBearer\s/, /\.env\b/, /\broot@/];

/**
 * ④ 英文侧的本仓字样。
 * ★ 为什么还要这一组：①②③收的都是中文与路径形状，英文页一旦带出仓内文件名或命令名，
 *   一个都拦不住。这一组只收「本仓的英文写法」，不收通用英文词——
 *   收宽了就会红在正常讲解文案上，而那之后的下场是有人把整把锁拆掉。
 */
const LATIN_SHAPES: readonly RegExp[] = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bWIP\b/,
  /\bAGENTS\.md\b/,
  /\bCHANGELOG\.md\b/,
  /\btest-plan\b/,
  /\bdeploy\.sh\b/,
  /\bcheck\.mjs\b/,
  /\bworktree\b/,
  /\bnpm\b/,
  /\bpnpm\b/,
  /\bvitest\b/,
  /\beslint\b/,
  /\bvite\b/,
  /\btsc\b/,
  /\bsudo\b/,
  /\bnginx\b/,
  /\bplaceholder\b/,
  /\bstubbed?\b/,
  /\bmock(?:ed|s)?\b/,
  /\bgatekeep\w*/,
];

export const INTERNAL_SHAPES: readonly RegExp[] = [
  ...REPO_SHAPES,
  ...SERVER_SHAPES,
  ...SECRET_SHAPES,
  ...LATIN_SHAPES,
];

/**
 * ★ 唯一一处白名单：SPA 外壳里 vite 那一句入口脚本。
 *   它是构建要求的字节，不是叙述——把 `.tsx` 算成「内部字样」等于要求改构建产物的形状。
 *   豁免写成**整串精确匹配**（含标签名与属性顺序），不是「凡带 src/ 都放行」；
 *   调用方只能拿这一条来比，且测试另外锁住「整份外壳里它至多出现一次」。
 */
export const SHELL_ENTRY_EXCEPTION = '<script type="module" src="/src/main.tsx"></script>';

/** 扫一段公开字节，返回命中的字样（每条最多报一次） */
export function internalWordingHits(text: string, allow: readonly string[] = []): string[] {
  return scanShapes(text, INTERNAL_SHAPES, allow);
}

function scanShapes(text: string, shapes: readonly RegExp[], allow: readonly string[] = []): string[] {
  const haystack = allow.reduce((s, exact) => s.split(exact).join(' '), text);
  const hits: string[] = [];
  for (const re of shapes) {
    const m = re.exec(haystack)?.[0];
    if (m && !hits.includes(m)) hits.push(m);
  }
  return hits;
}

/**
 * ── 构建产物那一路（`dist` 下的 `.js`／`.css`，issue #8）─────────────────────────
 *
 * ★ 为什么同一份词表还要另开一条通路：那五组形状是为**人写的散文**设计的，而压缩后的代码里
 *   有三类东西它们一律咬中：第三方库的常量（React 的错误解码地址、highlight.js 的关键字表与
 *   语言别名表）、DOM/CSS 自己的关键字（`placeholder`）、压缩器给的短标识符（`function P0(e)`）。
 *   把这些算成「内部字样」等于要求改第三方库，而那之后的下场还是有人拆锁（同第⑤组的理由）。
 * ★ 所以这里的规矩是**逐处点名豁免 ＋ 死锁自检**，不是「产物整类放行」：
 *   每条豁免写成一个具体的串（`BUNDLE_ALLOW`），测试再断言它**当场还在产物里出现**——
 *   依赖一升级、文案一改，豁免就变成死的，测试立刻红，逼重新看一眼。
 * ★ 只有 `BUNDLE_INAPPLICABLE` 那两条是整体不适用，且各自有东西顶上（口令那条换成
 *   「字面值」形状）；测试拿假 leak 钉住这两条不是偷懒。
 * ★ 实测账（2026-09-25，本机 `npm run build -w @sb/web` 后逐条数过）：JS 439 683 B ＋ CSS 147 405 B。
 */

/** 整体不适用的两条：在压缩代码里它们是必然，不是泄露 */
export const BUNDLE_INAPPLICABLE: readonly RegExp[] = [/\bP[012]\b/, /password/i];

/**
 * 顶替 `/password/i` 的形状：`password` 当字段名是本产品的实现词汇（注册、登录、改密都要它），
 * 只有**被赋成字符串常量**才是把口令写进了前端——那正是这条要守的。
 */
const BUNDLE_SECRET_SHAPES: readonly RegExp[] = [/passw(?:or)?d\w*\s*[:=]\s*["'`][^"'`\s]{4,}["'`]/i];

/**
 * 按 **source 字符串**比对，不按对象身份。
 * ★ 两处字面量写法相同的正则是两个不同对象，`includes(re)` 恒为 false —— 那样「这两条整体不适用」
 *   会静默失效，产物扫描永远红在 `P0` 与 `password` 上，而下一次有人做的东西就是把整段豁免删掉。
 */
const INAPPLICABLE_SOURCES = new Set(BUNDLE_INAPPLICABLE.map((re) => re.source));

const BUNDLE_SHAPES: readonly RegExp[] = [
  ...INTERNAL_SHAPES.filter((re) => !INAPPLICABLE_SOURCES.has(re.source)),
  ...BUNDLE_SECRET_SHAPES,
];

export interface BundleAllow {
  readonly needle: string;
  readonly why: string;
}

/** 逐处点名的豁免（每条都要在产物里真的出现，否则测试红） */
export const BUNDLE_ALLOW: readonly BundleAllow[] = [
  { needle: 'this.token=new n(h)', why: 'VS Code 共享内存取消 token 的对象构造' },
  { needle: 'messageToken=', why: 'VS Code JSONRPC 消息序号计数' },
  { needle: 'messageToken:', why: 'VS Code JSONRPC 部分消息的序号字段' },
  { needle: 'ProgressToken=', why: 'VS Code JSONRPC 进度 ID 类型导出' },
  { needle: 'token:B[0],value:B[1]', why: 'VS Code JSONRPC 的进度 ID 与值' },
  { needle: 'token:O,value:j', why: 'VS Code JSONRPC 的进度通知 ID 与值' },
  { needle: 'NegatedToken:', why: 'Langium 否定语法类型' },
  { needle: 'RegexToken:', why: 'Langium 正则语法类型' },
  { needle: 'UntilToken:', why: 'Langium until 语法类型' },
  { needle: 'this.result.token=n.terminalType,this.result.occurrence=n.idx', why: 'Chevrotain 规则遍历的终结符与下标' },
  { needle: 'this.result.token=i.terminalType,this.result.occurrence=i.idx', why: 'Chevrotain 规则遍历的终结符与下标' },
  { needle: 'this.token=r,this.resyncedTokens=[]', why: 'Chevrotain 语法异常携带的 token 列表' },
  { needle: 'this.token=t,this.resyncedTokens=[]', why: 'Chevrotain 语法异常携带的 token 列表' },
  { needle: 'previousToken=', why: 'Chevrotain 前一语法 token 游标' },
  { needle: 'setNodeLocationFromToken=', why: 'Chevrotain 从 token 定位语法节点的方法' },
  { needle: 'actualToken:', why: 'Chevrotain 预期/实际语法 token 诊断' },
  { needle: 'cancellationToken:', why: 'Langium/VS Code 任务取消类型参数' },
  { needle: 'report:!0,token:t', why: 'KaTeX strict 公式诊断中的语法 token' },
  { needle: 'const{token:n}=t,i=Re(n.startOffset)', why: 'Langium 解析错误 token 起点的定位' },
  { needle: 'https://langium.org/docs/reference/configuration-services/#resolving-cyclic-dependencies', why: 'Langium 的依赖环诊断文档' },
  { needle: 'this._token=l.Cancelled', why: 'VS Code 取消状态赋值' },
  { needle: 'this._token=l.None', why: 'VS Code 空取消状态赋值' },
  { needle: 'funcName:t,parser:this,token:a,breakOnTokenText:i', why: 'KaTeX 调用数学函数的语法上下文' },
  { needle: 'token:void 0,occurrence:void 0,isEndOfRule:', why: 'Chevrotain 语法规则遍历的空 token 结果' },
  { needle: 'chevrotain.io/docs/guide/resolving_lexer_errors.html', why: 'Chevrotain 官方词法错误文档地址' },
  { needle: 'r!=="node_modules"&&r!=="out"', why: 'Langium 默认工作区忽略的目录名，不是本站文件路径' },
  { needle: 'this._token=new f', why: 'VS Code 取消 token 对象构造，非认证密钥' },
  { needle: 'nextToken=', why: 'KaTeX 的下一语法 token 游标' },
  { needle: 'addToken=this.addToken', why: 'Chevrotain 词法 token 收集方法' },
  { needle: 'token:`checkout ${', why: 'Mermaid Git 图 checkout 语法错误' },
  { needle: 'token:{rules:[', why: 'Mermaid/Jison 的词法规则表' },
  { needle: 'token:"->>-"', why: 'Mermaid 时序图的箭头语法错误' },
  { needle: ", token: \"", why: "Jison 多重语法动作诊断，非认证 token" },
  { needle: "commentToken:", why: "Mermaid 语法符号表" },
  { needle: "textToken:", why: "Mermaid 语法符号表" },
  { needle: "textNoTagsToken:", why: "Mermaid 语法符号表" },
  { needle: "edgeTextToken:", why: "Mermaid 语法符号表" },
  { needle: "CancellationToken=", why: "VS Code JSONRPC 的取消类型" },
  { needle: "token:`cherryPick ${", why: "Mermaid Git 图 cherryPick 语法错误" },
  { needle: "size:ze(t[0],\"size\").value,token:s", why: "KaTeX 中缀分数解析 token" },
  { needle: "vite:preloadError", why: "Vite 动态加载失败事件，非工程文案" },
  { needle: "\"placeholder\"", why: "DOMPurify 的合法 HTML 属性名" },
  { needle: "Incomplete placeholder at end of macro body", why: "KaTeX 宏参数语法诊断" },
  { needle: "placeholder-${", why: "Mermaid 布局的内部虚拟节点 ID" },
  { needle: "TODO: We should probably remove this in a future release.", why: "Mermaid 附带的标签 CSS 注释" },
  { needle: "TODO make this a vec3, simplifies some code below", why: "Cytoscape 附带的 GLSL 着色器注释" },
  { needle: "tsc:Qa,tscc:Qa", why: "Cytoscape Tarjan 强连通算法别名，非 TypeScript 编译器" },
  { needle: "../../node_modules/.pnpm/vscode-jsonrpc@9.0.3/node_modules/vscode-jsonrpc/", why: "Mermaid 发布包中 VS Code/Langium 的模块标识，不是本项目路径" },
  { needle: "../../node_modules/.pnpm/vscode-languageserver-types@3.18.4/node_modules/vscode-languageserver-types/", why: "Mermaid 发布包中 VS Code/Langium 的模块标识，不是本项目路径" },
  { needle: "../../node_modules/.pnpm/vscode-languageserver-protocol@3.18.4/node_modules/vscode-languageserver-protocol/", why: "Mermaid 发布包中 VS Code/Langium 的模块标识，不是本项目路径" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#COMPLEMENT", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#REGEXP_PARSING", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#UNICODE_OPTIMIZE", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#CUSTOM_OPTIMIZE", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#ANCHORS", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#UNREACHABLE", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#LINE_BREAKS", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#IDENTIFY_TERMINATOR", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#CUSTOM_LINE_BREAK", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_lexer_errors.html#MISSING_LINE_TERM_CHARS", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/FAQ.html#NUMERICAL_SUFFIXES", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_grammar_errors.html#COMMON_PREFIX", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_grammar_errors.html#AMBIGUOUS_ALTERNATIVES", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/changes/BREAKING_CHANGES.html#_6-0-0", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/changes/BREAKING_CHANGES.html#_4-0-0", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/internals.html#grammar-recording", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: "https://chevrotain.io/docs/guide/resolving_grammar_errors.html#IGNORING_AMBIGUITIES", why: "Chevrotain 官方语法诊断说明链接" },
  { needle: 'token:this.terminals_', why: 'Mermaid/Jison 解析错误对象的语法 token，非认证密钥' },
  { needle: 'token:null,line:', why: 'Mermaid 解析错误的空语法 token 与行号' },
  { needle: 'alphaNumToken:', why: 'Mermaid 语法符号表中的数字字母 token' },
  { needle: 'idStringToken:', why: 'Mermaid 语法符号表中的 ID token' },
  { needle: 'endToken:', why: 'Mermaid 流程图的结束语法 token' },
  { needle: 'valueToken:', why: 'Mermaid 集合图的值语法 token' },
  { needle: 'token:`merge ${', why: 'Mermaid Git 图的 merge 语法错误，内容是分支名' },
  { needle: 'CancellationToken=void 0', why: 'VS Code JSONRPC 的取消类型导出' },
  { needle: 'type:"infix",mode:t.mode,replaceWith:a,token:s', why: 'KaTeX 分数中缀解析的语法 token' },
  { needle: 'https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE', why: 'Babel MIT 许可证来源链接' },
  { needle: 'https://github.com/jquery/jquery/blob/master/src/event.js', why: 'Cytoscape 引用的 jQuery MIT 许可证来源链接' },
  { needle: 'Token: ->', why: 'Chevrotain 的语法 token 无法匹配诊断' },
  { needle: 'reactjs.org/docs/error-decoder.html', why: 'React 自带的错误解码地址，指向 React 官网' },
  { needle: '/api/tools/', why: '本站公开的 API 前缀，被「仓内 tools/ 目录」那条撞中' },
  { needle: 'exit|npm|npx|node|git|sudo|mkdir', why: 'highlight.js 的 shell 关键字表，出现是为了给代码块上色' },
  { needle: 'tsx:"js"', why: 'highlight.js 语言别名表里的一项（键与值都算上，只放过一半会残下值里那个 tsx）' },
  { needle: 'tsx:"tsx"', why: '同上，另一张表里它映射到自己' },
  { needle: 'pk-sk-line', why: '骨架屏 class 名，撞在密钥形状 sk- 上' },
  { needle: 'placeholder:', why: 'React DOM 属性名，不是「占位内容没填」' },
  { needle: 'placeholder,value:', why: '同一个属性在压缩后以对象属性形式被读走（`x.placeholder, value:…`）' },
  { needle: '::placeholder', why: 'CSS 伪元素选择器' },
];

/** 扫构建产物字节（JS／CSS）：同一份词表，减去整体不适用那两条，加上代码表面那条口令形状 */
export function bundleWordingHits(text: string): string[] {
  return scanShapes(text, BUNDLE_SHAPES, BUNDLE_ALLOW.map((a) => a.needle));
}
