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
  return i > 0 ? { base: name.slice(0, i), ext: name.slice(i) } : { base: name, ext: '' };
}
