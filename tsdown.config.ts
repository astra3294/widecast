import { defineConfig } from 'tsdown'

const pluginId = 'widecast'
const platformModules = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  {
    name: 'widecast/library',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    // 宿主半边刻意零 @deepseek-ai/* 导入(linked 包的模块解析回退不到 dsh 内部),
    // 此处 external 仅为保险,正常构建不会有任何 @deepseek-ai 依赖被打入。
    external: [/^@deepseek-ai\//],
    outputOptions: {
      entryFileNames: '[name].js',
      chunkFileNames: 'chunks/[name]-[hash].js',
    },
  },
  {
    name: 'widecast/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: true,
    external: platformModules,
    noExternal: (id: string) => (platformModules.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
