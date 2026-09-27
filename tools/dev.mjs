/**
 * 并行启动前后端 dev 服务器（跨平台，零依赖）。
 *
 * 为什么需要它：`package.json` 原 dev 脚本写作 `npm run dev:server & npm run dev:web`。
 * `&` 在 sh 里是「后台并行」，但在 **Windows 的 cmd.exe**（npm 默认 script-shell）里是
 * **顺序执行**——于是 `dev:web` 会一直等 `dev:server` 退出，而 `dev:server` 是 tsx watch
 * 模式永不退出 ⇒ 前端永远起不来（本机反复踩到，只能手动分两次起服务）。
 *
 * 这里改成 spawn 真并行，并做两件原脚本没有的事：
 *   1) stdio 直接继承 —— 两个服务的输出都进当前终端、Ctrl+C 一起收到；
 *   2) 任一子进程退出即收掉另一个并透传退出码 —— 否则一个崩了另一个还在跑，
 *      留下一个「看起来在跑但只剩一半」的幽灵服务，比直接全挂更难排查。
 */
import { spawn } from 'node:child_process';

const TASKS = ['dev:server', 'dev:web'];

// shell:true 让 Windows 解析 npm.cmd、*nix 解析 npm，免去手写平台后缀
const children = TASKS.map((task) =>
  spawn('npm', ['run', task], { stdio: 'inherit', shell: true }),
);

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
  process.exitCode = code;
}

for (const child of children) {
  child.on('exit', (code, signal) => shutdown(code ?? (signal ? 1 : 0)));
  child.on('error', (err) => {
    console.error(`[dev] 子进程启动失败：${err.message}`);
    shutdown(1);
  });
}

// 手动收子进程：Ctrl+C 只送到 dev.mjs 本身，不保证转发给已 spawn 的 npm 子进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0));
}
