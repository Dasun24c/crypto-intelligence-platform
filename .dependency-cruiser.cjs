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
      name: 'alerts-stays-pure',
      severity: 'error',
      comment: 'alerts (rule evaluation, ADR 020) depends only on contracts and domain.',
      from: { path: '^packages/alerts/src/', pathNot: '[.]test[.]ts$' },
      to: {
        pathNot: ['^packages/(alerts|contracts|domain)/', 'node_modules/(zod|big[.]js)/'],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'only-the-api-and-broker-handle-practice-orders',
      severity: 'error',
      comment:
        "TRD-05: only a person's request through the api places, changes or cancels a practice order; setups, alerts, the AI and jobs cannot (ADR 021).",
      from: {
        pathNot: ['^apps/api/src/practice/', '^apps/broker/', '^packages/contracts/', '[.]test[.]ts$'],
      },
      to: { path: '^packages/contracts/src/practice-commands[.]ts$' },
    },
    {
      name: 'broker-has-no-venue-client',
      severity: 'error',
      comment: 'The broker never reaches an exchange (ADR 021, criterion 14.10).',
      from: { path: '^apps/broker/' },
      to: { path: '^packages/exchange-adapters/' },
    },
    {
      name: 'paper-engine-stays-pure',
      severity: 'error',
      comment: 'paper-engine (practice trading, ADR 021) depends only on contracts and domain.',
      from: { path: '^packages/paper-engine/src/', pathNot: '[.]test[.]ts$' },
      to: {
        pathNot: ['^packages/(paper-engine|contracts|domain)/', 'node_modules/(zod|big[.]js)/'],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'ai-stays-pure',
      severity: 'error',
      comment:
        'ai (ADR 023) depends only on contracts and domain, and on node:crypto for the context hash; its provider uses the global fetch.',
      from: { path: '^packages/ai/src/', pathNot: '[.]test[.]ts$' },
      to: {
        pathNot: ['^packages/(ai|contracts|domain)/', 'node_modules/(zod|big[.]js)/', '^(node:)?crypto$'],
      },
    },
    {
      name: 'only-the-jobs-service-calls-the-model',
      severity: 'error',
      comment:
        'SEC-01, criterion 9.5: only the jobs service holds the Grok key and calls xAI (ADR 023); the api and the frontends never import the provider.',
      from: { pathNot: ['^apps/jobs/', '^packages/ai/'] },
      to: { path: '^packages/ai/src/provider[.]ts$' },
    },
    {
      name: 'pure-packages-no-node-io',
      severity: 'error',
      from: {
        path: '^packages/(domain|indicators|market-data|smc-engine|contracts|alerts|paper-engine)/src/',
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
        path: '^(packages/(db|observability|exchange-adapters|market-data|indicators|smc-engine|ai|alerts)/|apps/)',
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
