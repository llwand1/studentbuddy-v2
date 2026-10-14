import { expect, it } from 'vitest';
import ts from 'typescript';
import { resolve, relative } from 'node:path';

function unsafeHandlers(program: ts.Program): string[] {
  const checker = program.getTypeChecker(), problems: string[] = [];
  const promise = (type: ts.Type): boolean => type.isUnion() ? type.types.some(promise) : ['Promise', 'PromiseLike'].includes(type.getSymbol()?.getName() ?? '');
  const matcher = (type: ts.Type): boolean => type.isUnionOrIntersection() ? type.types.some(matcher) : ['IRouterMatcher', 'IRouterHandler'].includes(type.getSymbol()?.getName() ?? '');
  function risky(node: ts.Node, visited = new Set<ts.Node>()): boolean {
    if (visited.has(node)) return false; visited.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return risky(node.expression, visited);
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return true;
    if (ts.isArrowFunction(node) && ts.isVoidExpression(node.body) && promise(checker.getTypeAtLocation(node.body.expression))) return true;
    if (checker.getTypeAtLocation(node).getCallSignatures().some(signature => promise(signature.getReturnType()))) return true;
    let symbol = checker.getSymbolAtLocation(node); if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    for (const declaration of symbol?.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && risky(declaration.initializer, visited)) return true;
      if (ts.isFunctionDeclaration(declaration) && risky(declaration, visited)) return true;
    }
    if (ts.isCallExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (declaration && 'body' in declaration && declaration.body && ts.isBlock(declaration.body)) {
        for (const statement of declaration.body.statements) if (ts.isReturnStatement(statement) && statement.expression && risky(statement.expression, visited)) return true;
      }
    }
    return false;
  }
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || /\.test\./.test(source.fileName) || source.fileName.includes('node_modules')) continue;
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && /^(get|post|put|patch|delete|all|use)$/.test(node.expression.name.text)
        && (/(?:router$|^app$)/i.test(node.expression.expression.getText(source))
          || matcher(checker.getTypeAtLocation(node.expression)))) {
        for (const argument of node.arguments) {
          function check(handler: ts.Node): void {
            if (ts.isArrayLiteralExpression(handler)) { handler.elements.forEach(check); return; }
            if (risky(handler)) problems.push(`${relative('.', source.fileName)}:${source.getLineAndCharacterOfPosition(handler.getStart(source)).line + 1}`);
          }
          check(argument);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return problems;
}
const config = ts.readConfigFile('packages/server/tsconfig.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'packages/server');

it('all current HTTP Promise callbacks are consumed, including named and factory-returned handlers', () => {
  const files = parsed.fileNames.filter(file => !/\.test\./.test(file));
  expect(unsafeHandlers(ts.createProgram(files, parsed.options))).toEqual([]);
}, 20_000);

it('the audit rejects named, contextually disguised, direct and factory-returned async handlers', () => {
  const filename = resolve('packages/server/src/http/route-audit-fixture.ts'), host = ts.createCompilerHost(parsed.options);
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version, onError, createNew) => resolve(file) === filename ? ts.createSourceFile(file, `
    import express, {type RequestHandler} from 'express';
    import {asyncHandler} from './async-handler.js';
    const app=express(), arbitrary=express.Router();
    function named(){return Promise.reject('x');}
    const disguised:RequestHandler=async()=>{throw new Error('x');};
    function factory():RequestHandler{return async()=>{throw new Error('x');};}
    app.get('/named',named); app.get('/factory',factory()); app.get('/cast',disguised);
    app.get('/direct',async()=>{}); app.get('/safe',asyncHandler(async()=>{}));
    arbitrary.get('/alias',disguised); arbitrary.use([[disguised]]);
    app.post('/dropped',()=>void named());
  `, version, true) : getSource(file, version, onError, createNew);
  expect(unsafeHandlers(ts.createProgram([filename], parsed.options, host))).toHaveLength(7);
}, 20_000);
