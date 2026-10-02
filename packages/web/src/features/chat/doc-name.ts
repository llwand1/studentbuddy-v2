/**
 * 文档模式的小工具单独成文件（先例：`features/quiz/mix-report.ts`）——
 * 纯函数写在组件里，测试就得连带 react/jsx-runtime 一起进 node 环境的测试链路，不值当。
 */

/**
 * 拆出扩展名好让它单独渲染：pill 里文件名主体受 `max-width` + ellipsis 约束，
 * 中文长文件名被截时不能连 `.txt` / `.md` 一起丢掉（否则看不出载的是哪类文件）。
 * 无扩展名（如默认名「粘贴资料」）时 ext 为空串，调用方按 falsy 不渲染。
 */
export function splitDocName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  // 点在首字符（`.gitignore` 类整名即文件名）不算扩展名，整名进 base
  if (i <= 0) return { base: name, ext: '' };
  const ext = name.slice(i);
  // ★ 2026-10-02：末段还得**长得像扩展名**才算（点 + 1~8 位字母数字）。
  //   起因是网页资料（DOC-RAG-SPEC §10）把**网页标题**当资料名，而标题里带点是常态：
  //   `Array.prototype.map() - JavaScript | MDN` 按老规则会被拆成
  //   ext = `.map() - JavaScript | MDN`，于是标题的**大半截**被塞进那个本该只放 `.txt`
  //   的小字 span，`max-width + ellipsis` 也就截不到该截的地方了。
  //   往返不变量不受影响：不认的时候整名回 base（`结尾有点.`、`....` 两例照旧逐字还原）。
  return /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? { base: name.slice(0, i), ext } : { base: name, ext: '' };
}
