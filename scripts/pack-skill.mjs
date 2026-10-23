#!/usr/bin/env node
/**
 * 打包成可上传到 WorkBuddy 的技能包。
 *
 * WorkBuddy 的「技能 → 添加技能 → 上传技能」需要一个技能包；
 * Skill 的运行只依赖 SKILL.md（规则全在里面），所以最小包只放这一个文件。
 * 需要连代码一起分发时加 --full（含 src/ tests/ 等，体积大很多）。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const NAME = 'mcd-smart-order';
const full = process.argv.includes('--full');
const outDir = resolve('build');
const stage = resolve(outDir, NAME);
const zipPath = resolve(outDir, `${NAME}-skill${full ? '-full' : ''}.zip`);

if (!existsSync('SKILL.md')) {
  console.error('找不到 SKILL.md，请在项目根目录运行。');
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const files = full
  ? ['SKILL.md', 'README.md', 'MCP_INTEGRATION.md', 'LICENSE', 'package.json', 'tsconfig.json', 'src', 'tests', 'fixtures', 'examples', 'docs']
  : ['SKILL.md'];

for (const f of files) {
  if (existsSync(f)) cpSync(f, resolve(stage, f), { recursive: true });
}

rmSync(zipPath, { force: true });
execFileSync('zip', ['-rq', zipPath, NAME], { cwd: outDir });

console.log(`✅ 技能包已生成：${zipPath}`);
console.log(`   内容：${files.filter((f) => existsSync(f)).join(', ')}`);
console.log('');
console.log('在 WorkBuddy 中导入：');
console.log('  左侧「专家 · 技能 · 连接器」→「技能」→「添加技能」→「上传技能」→ 选择上面的 zip');
