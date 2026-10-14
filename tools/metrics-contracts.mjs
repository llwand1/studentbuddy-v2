/** Count declaration lines, not compatibility barrel re-exports. */
export function countContractDeclarations(source) {
  return {
    iface: [...source.matchAll(/^export\s+interface\s+[A-Za-z_$][\w$]*/gm)].length,
    type: [...source.matchAll(/^export\s+type\s+[A-Za-z_$][\w$]*/gm)].length,
  };
}
