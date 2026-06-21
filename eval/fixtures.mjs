// Eval dataset: realistic "build reports" that technically satisfy their frozen
// acceptance criteria but contain known, planted, real issues. Each planted issue
// carries `match` synonyms used by the (deliberately coarse) keyword grader.
//
// Task themes deliberately overlap with Colin Eberhardt's "Ponytail? YAGNI!" post
// (rate-limit, csv-sum, debounce, email/JWT) so the comparison is on his turf.
// The `clean-control` fixture has NO planted issues — it measures over-flagging.

export const FIXTURES = [
  {
    id: 'version-flag',
    objective: 'Add a --version flag to the CLI that prints the version from package.json and exits 0.',
    acceptance_criteria: [
      'Running the CLI with --version prints the version string from package.json',
      'The process exits with code 0',
      'A regression test asserts the printed version matches package.json',
    ],
    report: {
      summary:
        'Added a --version/-v flag. It reads the version via readVersion() (readFileSync on ' +
        "new URL('../package.json', import.meta.url)), prints it with console.log, then calls " +
        'process.exit(0). Added a regression test that spawns the CLI and resolves the expected ' +
        "version using the same new URL('../package.json', import.meta.url) logic, asserting the " +
        'printed output matches.',
      changed_files: ['src/cli.mjs', 'test/cli-version.test.mjs'],
      tests_run: ['test/cli-version.test.mjs'],
      test_output: 'ok 1 - --version prints package.json version; tests 1; pass 1; fail 0',
      acceptance_status: 'all three acceptance criteria met',
      assumptions: ['package.json is one directory above the CLI', 'version field is always present'],
      raw_evidence: '$ node cli --version\n0.1.0\nexit=0',
    },
    planted_issues: [
      { id: 'scope-creep-v', description: 'The -v alias was not requested and collides with the conventional --verbose.', match: ['verbose', 'alias', 'scope creep', 'unrequested', 'not asked', 'not requested'] },
      { id: 'exit-truncation', description: 'process.exit(0) right after console.log can truncate piped stdout before it flushes.', match: ['process.exit', 'truncat', 'pipe', 'drain', 'flush', 'exitcode'] },
      { id: 'tautological-test', description: 'The test resolves package.json the same way as the code, so a shared path bug passes silently.', match: ['tautolog', 'same way', 'same logic', 'same path', 'independent', 'circular', 'shares the same'] },
      { id: 'python-parity', description: 'A parallel Python CLI exists but did not get --version, breaking parity.', match: ['python', 'parity', 'cli.py'] },
    ],
  },
  {
    id: 'fastapi-rate-limit',
    objective: "Add rate limiting to a FastAPI endpoint so users can't spam it.",
    acceptance_criteria: [
      'Requests over the limit within the window are rejected with HTTP 429',
      'The limit and window are configurable',
      'Existing endpoint behaviour is unchanged for normal traffic',
    ],
    report: {
      summary:
        'Implemented rate limiting with a module-level dict mapping client IP to a list of request ' +
        'timestamps. On each request we prune timestamps older than the window and return HTTP 429 ' +
        'if the remaining count exceeds the limit. The client IP comes from request.client.host.',
      changed_files: ['app/main.py'],
      tests_run: [],
      test_output: 'manual curl: the 11th request within the window returns 429',
      acceptance_status: 'criteria met in manual testing',
      assumptions: ['runs as a single process', 'request.client.host is the real client IP'],
      raw_evidence: 'curl loop: requests 1-10 -> 200, request 11 -> 429',
    },
    planted_issues: [
      { id: 'multiprocess', description: 'An in-memory dict is not shared across workers/processes, so the limit is per-worker.', match: ['worker', 'process', 'in-memory', 'in memory', 'shared', 'redis', 'multiple instances', 'gunicorn', 'single process'] },
      { id: 'memory-leak', description: 'IP entries are never removed, so the dict grows without bound.', match: ['memory leak', 'unbounded', 'never removed', 'never evicted', 'grows', 'eviction', 'grow without'] },
      { id: 'spoofable-ip', description: 'request.client.host is spoofable behind a proxy and ignores X-Forwarded-For.', match: ['spoof', 'x-forwarded', 'proxy', 'real ip', 'trusted'] },
      { id: 'no-tests', description: 'There are no automated tests, only a manual curl check.', match: ['no test', 'no automated', 'manual', 'lacks test', 'without test', 'add test'] },
    ],
  },
  {
    id: 'csv-sum',
    objective: "Write Python code that reads sales.csv and sums the 'amount' column.",
    acceptance_criteria: [
      "Returns the sum of the 'amount' column",
      'Runs successfully on the provided sales.csv',
    ],
    report: {
      summary:
        'Implemented a SalesReport class with a CsvLoader abstraction, an AmountAggregator strategy, ' +
        "and a pluggable column-resolver. The actual sum is df['amount'].sum() via pandas. Returns the " +
        'correct total on sales.csv.',
      changed_files: ['sales_report.py'],
      tests_run: [],
      test_output: 'prints 12345.67 on sales.csv',
      acceptance_status: 'criteria met',
      assumptions: ["the 'amount' column exists and is numeric"],
      raw_evidence: '$ python sales_report.py\n12345.67',
    },
    planted_issues: [
      { id: 'over-engineering', description: 'A class plus loader/strategy/resolver abstractions are YAGNI for a one-line sum.', match: ['over-engineer', 'over engineer', 'yagni', 'unnecessary', 'one-liner', 'one line', 'too complex', 'overly complex', 'simpler', 'overkill'] },
      { id: 'nan-handling', description: 'No handling of missing/NaN/non-numeric values in the amount column.', match: ['nan', 'non-numeric', 'non numeric', 'missing value', 'empty', 'coerce', 'dtype', 'malformed'] },
      { id: 'file-not-found', description: 'No handling if sales.csv is missing or unreadable.', match: ['file not found', 'filenotfound', 'missing file', 'does not exist', 'ioerror', 'oserror', 'no such file'] },
    ],
  },
  {
    id: 'debounce',
    objective: 'Add debounce to a search input in vanilla JavaScript; it currently fires an API call on every keystroke.',
    acceptance_criteria: [
      'The API call fires only after the user pauses typing',
      'The debounce delay is configurable',
    ],
    report: {
      summary:
        'Added debounce: on each input event we call setTimeout(sendRequest, delay). Verified in a ' +
        'browser page that typing quickly results in a single API call after the pause.',
      changed_files: ['search.js'],
      tests_run: [],
      test_output: 'manual: fast typing fires one call ~300ms after the last keystroke',
      acceptance_status: 'criteria met in manual testing',
      assumptions: ['runs in a browser where document is available'],
      raw_evidence: 'observed one network request after pause',
    },
    planted_issues: [
      { id: 'timer-not-cleared', description: 'The previous timer is never cleared, so multiple calls still stack up.', match: ['clear', 'cleartimeout', 'previous timer', 'stack', 'cancel', 'still fires', 'multiple calls', 'every keystroke'] },
      { id: 'dom-assumption', description: 'Assumes document/DOM, so it fails in a non-DOM (test/node) environment.', match: ['dom', 'document', 'jsdom', 'non-browser', 'node environment', 'headless', 'window'] },
      { id: 'no-cleanup', description: 'No teardown/removeEventListener, leaking listeners on re-init.', match: ['removeeventlistener', 'cleanup', 'teardown', 'leak', 'unmount', 'listener'] },
    ],
  },
  {
    id: 'jwt-auth',
    objective: 'Add JWT auth middleware that protects routes; unauthenticated requests must be rejected.',
    acceptance_criteria: [
      'Requests without a valid token receive HTTP 401',
      'Requests with a valid token are allowed through',
    ],
    report: {
      summary:
        'Middleware reads the Authorization header, decodes the JWT with jwt.decode(token), and ' +
        "attaches the payload to the request. The secret 'mysecret' is defined in the module. On any " +
        'failure it returns 401 with the caught exception message in the body.',
      changed_files: ['middleware.js'],
      tests_run: [],
      test_output: 'valid token -> 200; missing token -> 401',
      acceptance_status: 'criteria met',
      assumptions: ['incoming tokens are well-formed'],
      raw_evidence: 'curl with/without token returns 200/401',
    },
    planted_issues: [
      { id: 'no-signature-verify', description: 'Uses jwt.decode (no signature verification), so tokens are forgeable.', match: ['signature', 'jwt.verify', 'forge', 'tamper', 'unsigned', 'unverified', 'not verified', 'verify the'] },
      { id: 'no-expiry', description: 'No expiration (exp) check, so expired tokens are accepted.', match: ['expir', 'exp claim', 'expiry', 'ttl', 'still valid'] },
      { id: 'hardcoded-secret', description: 'The signing secret is hardcoded in source.', match: ['hardcoded', 'hard-coded', 'secret in', 'environment variable', 'in code', 'committed secret', 'env var'] },
      { id: 'error-leak', description: 'Returning the exception message to clients leaks internal detail.', match: ['leak', 'information disclosure', 'error message', 'internal detail', 'stack', 'exception message'] },
    ],
  },
  {
    id: 'react-countdown',
    objective: 'Build a countdown timer component in React that counts down from a given number of seconds.',
    acceptance_criteria: [
      'Counts down once per second from the given number of seconds',
      'Displays the remaining seconds',
    ],
    report: {
      summary:
        'Implemented Countdown: useState(seconds) for the remaining count and a useEffect that calls ' +
        'setInterval(() => setRemaining((s) => s - 1), 1000). Renders the current count. Verified it ' +
        'counts from 10 down to 0 in the browser.',
      changed_files: ['Countdown.jsx'],
      tests_run: [],
      test_output: 'manual: rendered <Countdown seconds={10} /> and watched it count 10 -> 0',
      acceptance_status: 'criteria met in manual testing',
      assumptions: ['the seconds prop does not change after mount'],
      raw_evidence: 'observed the number decrement once per second',
    },
    planted_issues: [
      { id: 'no-clear-interval', description: 'setInterval is never cleared, leaking the timer and ticking after unmount.', match: ['clearinterval', 'cleared', 'unmount', 'leak', 'memory', 'keeps running', 'keeps ticking', 'cleanup'] },
      { id: 'stale-prop', description: 'The effect ignores later changes to the seconds prop (wrong dependencies / stale closure).', match: ['dependency', 'deps', 'stale', 'does not update when', 'after mount', 'prop change'] },
      { id: 'no-zero-stop', description: 'Nothing stops the countdown at zero, so it goes negative.', match: ['stop at zero', 'below zero', 'negative', 'past zero', 'does not stop', 'clamp'] },
    ],
  },
  {
    id: 'sql-user-lookup',
    objective: 'Add a function that looks up a user by email from the database.',
    acceptance_criteria: [
      'Returns the user row matching the given email',
      'Returns null when no user matches',
    ],
    report: {
      summary:
        "Implemented getUserByEmail(email): builds the query as \"SELECT * FROM users WHERE email = '\" " +
        "+ email + \"'\" and runs it, returning the first row or null. Works for normal email addresses.",
      changed_files: ['users.js'],
      tests_run: [],
      test_output: 'manual: lookup returned the correct row for a known email',
      acceptance_status: 'criteria met',
      assumptions: ['email is a trusted, well-formed string'],
      raw_evidence: "getUserByEmail('a@b.com') -> { id: 1, ... }",
    },
    planted_issues: [
      { id: 'sql-injection', description: 'String-concatenated SQL is injectable; use a parameterized/prepared query.', match: ['injection', 'parameter', 'parameterize', 'prepared', 'sanitiz', 'concatenat', 'escap', 'bind variable'] },
      { id: 'select-star', description: 'SELECT * over-fetches and is fragile to schema changes.', match: ['select *', 'select star', 'specific columns', 'over-fetch', 'over fetch'] },
      { id: 'no-error-handling', description: 'No handling of database/connection errors.', match: ['error handling', 'db error', 'database error', 'exception', 'connection error', 'rejects'] },
    ],
  },
  {
    id: 'clean-control',
    objective:
      'Add a slugify(text) helper that lowercases, trims, replaces runs of non-alphanumerics with a single hyphen, and strips leading/trailing hyphens.',
    acceptance_criteria: [
      "slugify('Hello, World!') === 'hello-world'",
      'Leading, trailing, and repeated separators collapse to single hyphens',
      'Has unit tests covering the above',
    ],
    report: {
      summary:
        'Implemented slugify with a single regex replace plus trim. Added 6 unit tests covering ' +
        'spaces, punctuation, leading/trailing separators, repeated separators, the empty string, and ' +
        'already-slugged input. All pass. The ASCII-only behaviour for non-Latin input is documented ' +
        'and covered by a test.',
      changed_files: ['src/slugify.mjs', 'test/slugify.test.mjs'],
      tests_run: ['test/slugify.test.mjs'],
      test_output: 'tests 6; pass 6; fail 0',
      acceptance_status: 'all criteria met',
      assumptions: ['ASCII-oriented; non-Latin letters are stripped, which is documented and tested'],
      raw_evidence: "slugify('  Hello,   World!! ') -> 'hello-world'",
    },
    planted_issues: [],
  },
];

// Phrases that signal a "serious problem" claim — used only on the clean-control
// fixture as a crude over-flagging / noise indicator (lower is better).
export const NOISE_SIGNALS = [
  'bug', 'vulnerab', 'security', 'fails', 'incorrect', 'broken', 'race condition',
  'memory leak', 'injection', 'crash', 'data loss', 'must fix', 'critical',
];
