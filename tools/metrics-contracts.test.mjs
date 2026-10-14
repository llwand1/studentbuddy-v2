import {test} from 'node:test';
import assert from 'node:assert/strict';
import {countContractDeclarations} from './metrics-contracts.mjs';
test('compatibility barrels never inflate declaration counts',()=>{
  assert.deepEqual(countContractDeclarations("export type { Foo } from './foo.js';\nexport type * from './bar.js';\nexport { type Foo } from './foo.js';\n"),{iface:0,type:0});
});
test('named interface and generic/union type declarations retain the established baseline definition',()=>{
  assert.deepEqual(countContractDeclarations('export interface Foo {}\nexport type Bar<T> = T | null;\nexport type Baz = string;\n'),{iface:1,type:2});
});
test('ordinary imports, private declarations and prefixed comments are not counted',()=>{
  assert.deepEqual(countContractDeclarations('// export type Fake = string;\n * export interface Fake {}\nimport type {Foo} from "x";\ntype Internal = string;\n'),{iface:0,type:0});
});
