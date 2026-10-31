// Compiles contracts/ with the solc npm package (no native binary, no download)
// and writes ABI + bytecode to build/contracts.json.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const solc = require('solc');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourcesIn(dir, prefix = 'contracts') {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, sourcesIn(path, key));
    else if (entry.name.endsWith('.sol')) out[key] = { content: readFileSync(path, 'utf8') };
  }
  return out;
}

const input = {
  language: 'Solidity',
  sources: sourcesIn(join(root, 'contracts')),
  settings: {
    evmVersion: 'cancun',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

function findImports(path) {
  try {
    return { contents: readFileSync(join(root, 'node_modules', path), 'utf8') };
  } catch {
    return { error: `not found: ${path}` };
  }
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
// Show every error, but only our own warnings: OpenZeppelin's are not ours to fix.
for (const e of output.errors ?? []) {
  if (e.severity === 'error' || e.sourceLocation?.file.startsWith('contracts/')) console.error(e.formattedMessage);
}
if (errors.length) process.exit(1);

const artifacts = {};
for (const [file, contracts] of Object.entries(output.contracts)) {
  if (!file.startsWith('contracts/')) continue;
  for (const [name, c] of Object.entries(contracts)) {
    artifacts[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
  }
}
mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'contracts.json'), JSON.stringify(artifacts, null, 2));
console.log(`compiled ${Object.keys(artifacts).join(', ')} with solc ${solc.version()}`);
