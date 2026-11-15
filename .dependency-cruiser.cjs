/**
 * Dependency rules from architecture §4 ("Dependency rules"), enforced in CI.
 * Packages that do not exist yet (domain, indicators, market-data, smc-engine, ...) are already covered,
 * so the rules apply from the first commit that adds them.
 * Patterns avoid nested quantifiers: dependency-cruiser refuses regular expressions it considers unsafe.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make initialisation order fragile.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-never-import-other-apps',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'contracts-depends-only-on-zod',
      severity: 'error',
      from: { path: '^packages/contracts/src/', pathNot: '[.]test[.]ts$' },
      to: { pathNot: ['^packages/contracts/', 'node_modules/zod/'] },
    },
    {
      name: 'domain-depends-on-nothing-internal',
      severity: 'error',
      from: { path: '^packages/domain/src/', pathNot: '[.]test[.]ts$' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/domain/' },
    },
    {
      name: 'pure-packages-stay-pure',
      severity: 'error',
      comment:
        'indicators, market-data and smc-engine depend only on domain (smc-engine also on indicators).',
      from: { path: '^packages/(indicators|market-data|smc-engine)/src/', pathNot: '[.]test[.]ts$' },
      to: {
        pathNot: [
          '^packages/(domain|indicators|market-data|smc-engine)/',
          'node_modules/(decimal[.]js|big[.]js)/',
        ],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'pure-packages-no-node-io',
      severity: 'error',
      from: {
        path: '^packages/(domain|indicators|market-data|smc-engine|contracts)/src/',
        pathNot: '[.]test[.]ts$',
      },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'frontend-imports-only-contracts-and-domain',
      severity: 'error',
      comment: 'app and ui may import only contracts and domain from the server side.',
      from: { path: '^packages/(app|ui)/' },
      to: {
        path: '^(packages/(db|observability|exchange-adapters|market-data|indicators|smc-engine|ai)/|apps/)',
      },
    },
    {
      name: 'frontend-no-server-libraries',
      severity: 'error',
      from: { path: '^(packages/(app|ui)|apps/(web|desktop))/' },
      to: { path: 'node_modules/(pg|ioredis|bullmq|kysely|@nestjs/[a-z-]+|pino|@node-rs/argon2|jose)/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage|[.]turbo|src-tauri)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['@cip/source', 'import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
