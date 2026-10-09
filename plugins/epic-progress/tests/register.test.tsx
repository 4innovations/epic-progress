import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

const SERVER = 'srv'
const PANE = { plugin: 'epic-progress', component: 'Pane', requestId: 'epic-progress' } as const
const PANE_PROPS = {
  title: 'Epic',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, isAtBottom: true },
  view: 'normal',
} as never

type Issue = { key: string; summary: string; status: string; category: string; type?: string; parent?: string; labels?: string[] }

const EPICS: Issue[] = [
  { key: 'BDY-750', summary: 'Security Audit 2026-07 — Remediation', status: 'To Do', category: 'new', type: 'Epic' },
  { key: 'BDY-365', summary: 'API Security & Hardening', status: 'In Progress', category: 'indeterminate', type: 'Epic' },
  { key: 'BDY-494', summary: 'Tablet Onboarding — Frictionless WiFi Setup', status: 'To Do', category: 'new', type: 'Epic' },
  { key: 'BDY-275', summary: 'Always Route Architecture', status: "Won't Do", category: 'new', type: 'Epic' },
]

// The two Jira sites, by host; the real connector takes a site's cloud id or its host.
const QUINVENTA = 'quinventa.atlassian.net'
const FAIMSTUDIO = 'faimstudio.atlassian.net'
const CLOUD_IDS: Record<string, string> = {
  '2c146270-437f-4ca5-b6b1-6ce6615b32a7': QUINVENTA,
  'c9f29ccb-3bc7-465a-b7cb-4374ffefc2fb': FAIMSTUDIO,
}
const SITES: Record<string, string[]> = { [QUINVENTA]: ['BDY', 'CUR'], [FAIMSTUDIO]: ['FAIM'] }

// The fixed v2 connections on user scope, each tied to the token of one site.
const BUDDY = 'buddy-atlassian'
const FAIM = 'faim-atlassian'
const FIXED_SITE: Record<string, string> = { [BUDDY]: QUINVENTA, [FAIM]: FAIMSTUDIO }

// `granted`: the sites the claude.ai connector's account can reach. `fixed`: the v2 connections
// loaded in this session; `refused` are turned down by auto mode, `broken` answer with a 401.
function fakeJira(
  on: On,
  { granted = [QUINVENTA, FAIMSTUDIO], fixed = [], refused = [], broken = [] }: { granted?: string[]; fixed?: string[]; refused?: string[]; broken?: string[] } = {},
) {
  const issues = new Map<string, Issue>()
  for (const epic of EPICS) issues.set(epic.key, epic)
  const add = (issue: Issue) => issues.set(issue.key, issue)
  add({ key: 'BDY-1407', summary: 'Android backup', status: 'In Review', category: 'indeterminate', parent: 'BDY-750', labels: ['awaiting-field-test'] })
  add({ key: 'BDY-1408', summary: 'Token rotation', status: 'To Do', category: 'new', parent: 'BDY-750' })
  add({ key: 'BDY-1409', summary: 'RLS review', status: 'Done', category: 'done', parent: 'BDY-750' })
  add({ key: 'BDY-1410', summary: 'Rate limits', status: 'Done', category: 'done', parent: 'BDY-750' })
  add({ key: 'BDY-1411', summary: 'Secrets scan', status: 'In Progress', category: 'indeterminate', parent: 'BDY-750' })
  add({ key: 'BDY-1412', summary: 'Old idea', status: "Won't Do", category: 'new', parent: 'BDY-750' })
  add({ key: 'BDY-9', summary: 'Los ticket', status: 'To Do', category: 'new' })
  add({ key: 'BDY-600', summary: 'Kiosk opschonen', status: 'To Do', category: 'new', type: 'Epic' })
  add({ key: 'BDY-1500', summary: 'Debug-UI verwijderen', status: 'To Do', category: 'new', parent: 'BDY-600' })
  add({ key: 'CUR-1', summary: 'Cursus onboarding', status: 'In Progress', category: 'indeterminate', type: 'Epic' })
  add({ key: 'CUR-5', summary: 'Module 1', status: 'Done', category: 'done', parent: 'CUR-1' })
  add({ key: 'CUR-6', summary: 'Module 2', status: 'To Do', category: 'new', parent: 'CUR-1' })
  add({ key: 'FAIM-175', summary: 'FAIM Customer Portal', status: 'Actief', category: 'indeterminate', type: 'Epic' })
  add({ key: 'FAIM-600', summary: 'Portal login', status: 'Actief', category: 'indeterminate', parent: 'FAIM-175' })
  add({ key: 'FAIM-601', summary: 'Portal upload', status: 'Gereed', category: 'done', parent: 'FAIM-175' })

  const node = (issue: Issue): unknown => {
    const parent = issue.parent ? issues.get(issue.parent) : undefined

    return {
      key: issue.key,
      fields: {
        summary: issue.summary,
        labels: issue.labels ?? [],
        status: { name: issue.status, statusCategory: { key: issue.category } },
        issuetype: { name: issue.type ?? 'Task', hierarchyLevel: issue.type === 'Epic' ? 1 : 0 },
        ...(parent && { parent: { key: parent.key, fields: { summary: parent.summary, issuetype: { name: parent.type ?? 'Task', hierarchyLevel: parent.type === 'Epic' ? 1 : 0 } } } }),
      },
    }
  }
  // A v2 connection leaves out what its default compact view does not carry.
  const compact = (value: unknown): unknown => {
    const { key, fields } = value as { key: string; fields: Record<string, unknown> }
    const { summary, status, issuetype } = fields as { summary: string; status?: { name: string }; issuetype: { name: string } }

    return { key, fields: { summary, ...(status && { status: { name: status.name } }), issuetype: { name: issuetype.name } } }
  }
  const error = (text: string) => ({ value: { content: [{ type: 'text', text }], isError: true } })
  const jqls: string[] = []
  const calls: { server: string; site: string; jql: string }[] = []

  on('mcp.call', async ($, e) => {
    const isFixed = fixed.includes(e.server)
    if ((!isFixed && e.server !== SERVER) || e.tool !== 'searchJiraIssuesUsingJql') return error('unknown server')
    if (refused.includes(e.server)) return { deny: 'the auto mode classifier gave no verdict' } as never
    if (broken.includes(e.server)) return error('{"error":true,"message":"Unauthorized; scope does not match","statusCode":401}')
    if (!isFixed && 'view' in e.args) return error('Input validation error: unrecognized key "view"')
    const cloudId = String(e.args.cloudId)
    const site = CLOUD_IDS[cloudId] ?? cloudId
    if (isFixed && FIXED_SITE[e.server] !== site) return error('{"error":true,"message":"Unauthorized","statusCode":401}')
    if (!isFixed && !granted.includes(site)) {
      const text = JSON.stringify({ error: true, message: `Cloud id: ${cloudId} isn't explicitly granted by the user.` })

      return { value: { content: [{ type: 'text', text }], isError: true } }
    }
    const jql = String(e.args.jql)
    jqls.push(jql)
    calls.push({ server: e.server, site, jql })
    const all = [...issues.values()].filter(issue => SITES[site]?.includes(issue.key.split('-')[0]!))
    let found: Issue[] = []
    const byKey = /^key = (\S+)$/.exec(jql)
    const byParent = /^parent = (\S+)/.exec(jql)
    const byProject = /^project = (\S+)$/.exec(jql)
    const inProjects = /^project in \(([^)]*)\)/.exec(jql)
    if (byKey) found = all.filter(issue => issue.key === byKey[1])
    else if (byParent) found = all.filter(issue => issue.parent === byParent[1])
    else if (byProject) found = all.filter(issue => issue.key.startsWith(`${byProject[1]}-`)).slice(0, Number(e.args.maxResults ?? 100))
    else if (jql.includes('issuetype = Epic')) {
      const wanted = inProjects ? inProjects[1]!.split(/,\s*/) : undefined
      found = all.filter(issue => issue.type === 'Epic' && (!wanted || wanted.includes(issue.key.split('-')[0]!)))
    }

    if (isFixed && byProject && found.length === 0) {
      return error(`{"error":true,"message":"JQL validation failed: De waarde '${byProject[1]}' bestaat niet voor het veld 'project'.","statusCode":400}`)
    }
    const nodes = found.map(node).map(one => (isFixed && e.args.view !== 'full' ? compact(one) : one))
    const text = isFixed
      ? JSON.stringify({ data: { issues: nodes, isLast: true, appliedContentFormat: 'markdown' } })
      : JSON.stringify({ issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } })

    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('tool.list', async () => ({
    value: [
      { name: 'Read', description: 'Read', mcp: false },
      ...fixed.map(server => ({ name: `mcp__${server}__searchJiraIssuesUsingJql`, description: 'Search', mcp: true })),
      { name: `mcp__${SERVER}__searchJiraIssuesUsingJql`, description: 'Search', mcp: true },
    ],
  }))

  return { jqls, calls, setStatus: (key: string, status: string, category: string) => add({ ...issues.get(key)!, status, category }) }
}

function capture(on: On, { branch = 'main' } = {}) {
  const statuses: (string | undefined)[] = []
  const closed: string[] = []
  on('ui.status', async ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } as const }))
  on('ui.close', async ($, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: `${branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)

  // Lets work the plugin scheduled off the dispatch (clock.after) finish.
  return { statuses, closed, clock, last: () => statuses.at(-1), settle: () => clock.advance(1) }
}

const start = ($: EngineInterface) =>
  ($ as unknown as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({
    cwd: '/repo',
    surface: 'desktop',
    isInteractive: true,
  })

test('/epic with a ticket key shows that ticket’s Epic and its progress', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: 'BDY-1407' })
  await ui.settle()

  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▱▱▱▱▱▱ 40% · nog 3 open ≈ 3 sessies')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect(await pane.find({ text: /BDY-750/ })).toBeDefined()
  expect(await pane.find({ type: 'Svg' })).toBeDefined()
  expect((await pane.find({ key: 'row:BDY-1407' }))?.text).toContain('deze sessie')
  expect(await pane.find({ text: /1 wacht op veldtest/ })).toBeDefined()
  await pane.unmount()
})

test('a pinned Epic offers "Automatisch volgen" to follow the session ticket again', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  await start($)
  await $.command.run({ command: 'epic', args: 'BDY-750' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect((await pane.find({ key: 'auto' }))?.text).toBe('Automatisch volgen')
  await pane.unmount()
})

test('the terminal draws the bar as text, without Svg', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  await start($)
  await $.command.run({ command: 'epic', args: 'BDY-750' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  expect(await pane.find({ type: 'Svg' })).toBe(undefined)
  expect(await pane.find({ text: /40%/ })).toBeDefined()
  await pane.unmount()
})

test('a ticket key in a prompt loads its Epic', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)

  await $.prompt.submit({ text: 'Pak BDY-1408 op' } as never)
  await ui.settle()

  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▱▱▱▱▱▱ 40% · nog 3 open ≈ 3 sessies')
})

test('a transition by the model refreshes the progress', async ($, on) => {
  const jira = fakeJira(on)
  const ui = capture(on)
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as never)
  await start($)
  await $.command.run({ command: 'epic', args: 'BDY-1407' })
  await ui.settle()

  jira.setStatus('BDY-1408', 'Done', 'done')
  await $.tool.call({ tool: `mcp__${SERVER}__transitionJiraIssue`, issueIdOrKey: 'BDY-1408', transition: { id: '31' } } as never)
  await ui.settle()

  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▰▰▱▱▱▱ 60% · nog 2 open ≈ 2 sessies')
})

test('the shown Epic refreshes every 15 minutes, not sooner', async ($, on) => {
  const jira = fakeJira(on)
  const ui = capture(on)
  await start($)
  await $.command.run({ command: 'epic', args: 'BDY-750' })
  await ui.settle()
  const loads = () => jira.jqls.filter(jql => jql.startsWith('parent = BDY-750')).length
  const before = loads()

  await ui.clock.advance(5 * 60 * 1000)
  expect(loads()).toBe(before)

  await ui.clock.advance(10 * 60 * 1000)
  expect(loads()).toBe(before + 1)
})

test('/epic with words opens the picker; filtering and picking loads the Epic', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: 'security' })
  await ui.settle()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect(await pane.find({ key: 'pick:BDY-750' })).toBeDefined()
  expect(await pane.find({ key: 'pick:BDY-365' })).toBeDefined()
  expect(await pane.find({ key: 'pick:BDY-275' })).toBe(undefined)

  await pane.input({ key: 'filter', text: 'security audit', kind: 'change' })
  expect(await pane.find({ key: 'pick:BDY-365' })).toBe(undefined)

  await pane.press({ key: 'pick:BDY-750' })
  await ui.settle()
  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▱▱▱▱▱▱ 40% · nog 3 open ≈ 3 sessies')
  expect(await pane.find({ key: 'filter' })).toBe(undefined)
  await pane.unmount()
})

test('/epic with words that match one Epic picks it at once', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: 'tablet onboarding' })
  await ui.settle()

  expect(ui.last()).toBe('BDY-494 ▱▱▱▱▱▱▱▱▱▱ 0% · nog geen tickets')
})

test('a result too large to inline is read from the file it was saved to', async ($, on) => {
  const ui = capture(on)
  const SAVED = '/Users/r/.claude/projects/x/tool-results/mcp-search-1.txt'
  const page = (nodes: unknown[]) => JSON.stringify({ issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } })
  const epic = { key: 'BDY-750', fields: { summary: 'Security Audit', issuetype: { name: 'Epic', hierarchyLevel: 1 } } }
  const done = { key: 'BDY-1', fields: { summary: 'A', status: { name: 'Done', statusCategory: { key: 'done' } }, issuetype: { name: 'Task' } } }
  const todo = { key: 'BDY-2', fields: { summary: 'B', status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Task' } } }
  on('tool.list', async () => ({ value: [{ name: `mcp__${SERVER}__searchJiraIssuesUsingJql`, description: 'Search', mcp: true }] }))
  on('mcp.call', async ($, e) => {
    const text = String(e.args.jql).startsWith('key =')
      ? page([epic])
      : `Error: result (75,929 characters) exceeds maximum allowed tokens. Output has been saved to ${SAVED}.\nFormat: JSON`

    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('fs.read', async ($, e) => (e.path === SAVED ? { value: page([done, todo]) } : { deny: 'no such file' }))
  await start($)

  await $.command.run({ command: 'epic', args: 'BDY-750' })
  await ui.settle()

  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▰▱▱▱▱▱ 50% · nog 1 open ≈ 1 sessie')
})

test('a failed ticket load shows the error, not "no tickets yet"', async ($, on) => {
  const ui = capture(on)
  const epic = { key: 'BDY-750', fields: { summary: 'Security Audit', issuetype: { name: 'Epic', hierarchyLevel: 1 } } }
  on('tool.list', async () => ({ value: [{ name: `mcp__${SERVER}__searchJiraIssuesUsingJql`, description: 'Search', mcp: true }] }))
  on('mcp.call', async ($, e) => {
    const text = /^(key|project) =/.test(String(e.args.jql))
      ? JSON.stringify({ issues: { nodes: [epic], pageInfo: { hasNextPage: false, endCursor: null } } })
      : 'Error: upstream timeout'

    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  await start($)

  await $.command.run({ command: 'epic', args: 'BDY-750' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect(await pane.find({ text: /^Jira: onverwacht antwoord van Jira: Error: upstream timeout/ })).toBeDefined()
  expect(await pane.find({ text: /niet gevonden op/ })).toBe(undefined)
  expect(await pane.find({ text: /Nog geen tickets/ })).toBe(undefined)
  expect(await pane.find({ type: 'Svg' })).toBe(undefined)
  await pane.unmount()
})

test('the ring and bar draw as plain images at a fixed size, without a white frame', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  await start($)
  await $.command.run({ command: 'epic', args: 'BDY-750' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  const svgs = await pane.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  for (const svg of svgs) expect(svg.props.isInteractive).toBe(undefined)
  expect(svgs[0]?.props.width).toBe(72)
  expect(svgs[0]?.props.height).toBe(72)
  await pane.unmount()
})

test('a refused Jira call is reported as an error, not as "no Epic found"', async ($, on) => {
  const ui = capture(on)
  on('tool.list', async () => ({ value: [{ name: `mcp__${SERVER}__searchJiraIssuesUsingJql`, description: 'Search', mcp: true }] }))
  on('mcp.call', async () => ({ deny: 'the auto mode classifier gave no verdict' }))
  await start($)

  const byKey = await $.command.run({ command: 'epic', args: 'BDY-750' })
  const bySearch = await $.command.run({ command: 'epic', args: 'security' })
  await ui.settle()

  expect(byKey.text).toContain('Jira-fout')
  expect(byKey.text).toContain('gave no verdict')
  expect(bySearch.text).toContain('Jira-fout')
})

test('with projects set to BDY,CUR a CUR ticket in a prompt loads its Epic', { options: { projects: 'BDY,CUR' } }, async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)

  await $.prompt.submit({ text: 'Pak CUR-6 op' } as never)
  await ui.settle()

  expect(ui.last()).toBe('CUR-1 ▰▰▰▰▰▱▱▱▱▱ 50% · nog 1 open ≈ 1 sessie')
})

test('by default a CUR ticket in a prompt is not recognised', async ($, on) => {
  const jira = fakeJira(on)
  capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)

  await $.prompt.submit({ text: 'Pak CUR-6 op' } as never)

  expect(jira.jqls).toEqual([])
})

test('the picker lists Epics of every configured project', { options: { projects: 'BDY,CUR' } }, async ($, on) => {
  const jira = fakeJira(on)
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: 'cursus' })
  await ui.settle()

  expect(jira.jqls.some(jql => jql.startsWith('project in (BDY, CUR) AND issuetype = Epic'))).toBe(true)
  expect(ui.last()).toBe('CUR-1 ▰▰▰▰▰▱▱▱▱▱ 50% · nog 1 open ≈ 1 sessie')
})

test('a call auto mode refused shows the allow rule to copy', async ($, on) => {
  const ui = capture(on)
  on('tool.list', async () => ({ value: [{ name: `mcp__${SERVER}__searchJiraIssuesUsingJql`, description: 'Search', mcp: true }] }))
  on('mcp.call', async () => ({ deny: 'The server-side auto mode classifier gave no verdict' }))
  await start($)

  await $.command.run({ command: 'epic', args: 'security' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect((await pane.find({ key: 'rule' }))?.text).toContain(`mcp__${SERVER}__searchJiraIssuesUsingJql`)
  expect(await pane.find({ key: 'copy-rule' })).toBeDefined()
  await pane.unmount()
})

test('a later ticket mention in a prompt does not switch the session ticket', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)

  await $.prompt.submit({ text: 'Pak BDY-1408 op' } as never)
  await ui.settle()
  await $.prompt.submit({ text: 'Doe het zoals in BDY-1500' } as never)
  await ui.settle()

  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▱▱▱▱▱▱ 40% · nog 3 open ≈ 3 sessies')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect((await pane.find({ key: 'row:BDY-1408' }))?.text).toContain('deze sessie')
  await pane.unmount()
})

test('a Jira write on another ticket refreshes but does not switch', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as never)
  await start($)
  await $.prompt.submit({ text: 'Pak BDY-1408 op' } as never)
  await ui.settle()

  await $.tool.call({ tool: `mcp__${SERVER}__addCommentToJiraIssue`, issueIdOrKey: 'BDY-1500', commentBody: 'zie ook' } as never)
  await ui.settle()

  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▱▱▱▱▱▱ 40% · nog 3 open ≈ 3 sessies')
})

test('the ticket in the branch name wins over a ticket mentioned in a prompt', async ($, on) => {
  fakeJira(on)
  const ui = capture(on, { branch: 'bdy-1500-debug-ui' })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)
  await ui.settle()

  await $.prompt.submit({ text: 'Kijk ook even naar BDY-1408' } as never)
  await ui.settle()

  expect(ui.last()).toBe('BDY-600 ▱▱▱▱▱▱▱▱▱▱ 0% · nog 1 open ≈ 1 sessie')
})

test('/epic with a ticket key switches the session ticket on purpose', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)
  await $.prompt.submit({ text: 'Pak BDY-1408 op' } as never)
  await ui.settle()

  await $.command.run({ command: 'epic', args: 'BDY-1500' })
  await ui.settle()

  expect(ui.last()).toBe('BDY-600 ▱▱▱▱▱▱▱▱▱▱ 0% · nog 1 open ≈ 1 sessie')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect((await pane.find({ key: 'row:BDY-1500' }))?.text).toContain('deze sessie')
  await pane.unmount()
})

test('/epic uit closes the pane, clears the status line and stops following; /epic turns it back on', async ($, on) => {
  const jira = fakeJira(on)
  const ui = capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)

  const off = await $.command.run({ command: 'epic', args: 'uit' })
  await ui.settle()
  expect(off.text).toContain('uit')
  expect(ui.closed).toEqual(['epic-progress'])
  expect(ui.last()).toBe(undefined)

  await $.prompt.submit({ text: 'Pak BDY-1408 op' } as never)
  await ui.settle()
  expect(jira.jqls).toEqual([])
  expect(ui.last()).toBe(undefined)

  await $.command.run({ command: 'epic', args: '' })
  await ui.settle()
  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▱▱▱▱▱▱ 40% · nog 3 open ≈ 3 sessies')
})

test('/epic with a key of a project that is not configured says how to add it', async ($, on) => {
  const jira = fakeJira(on)
  const ui = capture(on)
  await start($)

  const { text } = await $.command.run({ command: 'epic', args: 'CUR-12' })
  await ui.settle()

  expect(text).toContain('CUR staat niet in je projecten (nu: BDY)')
  expect(text).toContain('"epic-progress": { "options": { "projects": "BDY,CUR" } }')
  expect(jira.jqls).toEqual([])
})

test('a ticket outside any Epic says so and offers the picker', async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: 'BDY-9' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect(await pane.find({ text: /BDY-9 hoort niet bij een Epic/ })).toBeDefined()
  expect(await pane.find({ key: 'choose' })).toBeDefined()
  await pane.unmount()
})

test('a FAIM ticket loads its Epic from the FAIM Jira', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  const jira = fakeJira(on)
  const ui = capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)

  await $.prompt.submit({ text: 'Pak FAIM-601 op' } as never)
  await ui.settle()

  expect(ui.last()).toBe('FAIM-175 ▰▰▰▰▰▱▱▱▱▱ 50% · nog 1 open ≈ 1 sessie')
  expect(jira.calls.some(call => call.site === FAIMSTUDIO && call.jql === 'key = FAIM-601')).toBe(true)
})

test('on an account that only reaches the FAIM Jira, a FAIM ticket still loads', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  fakeJira(on, { granted: [FAIMSTUDIO] })
  const ui = capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)

  await $.prompt.submit({ text: 'Pak FAIM-601 op' } as never)
  await ui.settle()

  expect(ui.last()).toBe('FAIM-175 ▰▰▰▰▰▱▱▱▱▱ 50% · nog 1 open ≈ 1 sessie')
})

test('the Epic link points to the Jira site of its project', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  await start($)
  await $.command.run({ command: 'epic', args: 'FAIM-175' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect((await pane.find({ type: 'Link' }))?.props.href).toBe('https://faimstudio.atlassian.net/browse/FAIM-175')
  await pane.unmount()
})

test('the Jira site of a project is looked up once per session', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  const jira = fakeJira(on)
  const ui = capture(on)
  await start($)
  await $.command.run({ command: 'epic', args: 'FAIM-601' })
  await ui.settle()
  const lookups = () => jira.calls.filter(call => call.jql === 'project = FAIM').length
  const before = lookups()

  await $.command.run({ command: 'epic', args: '' })
  await ui.settle()

  expect(before).toBe(2)
  expect(lookups()).toBe(before)
})

test('the picker lists the Epics of both Jira sites', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  fakeJira(on)
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: '' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect(await pane.find({ key: 'pick:BDY-750' })).toBeDefined()
  expect(await pane.find({ key: 'pick:FAIM-175' })).toBeDefined()
  await pane.unmount()
})

test('a project this account cannot reach leaves the picker quiet about it', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  fakeJira(on, { granted: [FAIMSTUDIO] })
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: '' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect(await pane.find({ key: 'pick:FAIM-175' })).toBeDefined()
  expect(await pane.find({ key: 'pick:BDY-750' })).toBe(undefined)
  expect(await pane.find({ text: /^Jira:/ })).toBe(undefined)
  await pane.unmount()
})

test('a ticket of a project no reachable Jira has says which project and why', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  fakeJira(on, { granted: [FAIMSTUDIO] })
  const ui = capture(on)
  await start($)

  const { text } = await $.command.run({ command: 'epic', args: 'BDY-750' })
  await ui.settle()

  expect(text).toContain('Jira-fout')
  expect(text).toContain('BDY niet gevonden op quinventa.atlassian.net, faimstudio.atlassian.net')
})

test('with sites set, only those Jira sites are asked', { options: { projects: 'FAIM', sites: 'faimstudio' } }, async ($, on) => {
  const jira = fakeJira(on)
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: 'FAIM-601' })
  await ui.settle()

  expect(ui.last()).toBe('FAIM-175 ▰▰▰▰▰▱▱▱▱▱ 50% · nog 1 open ≈ 1 sessie')
  expect(jira.calls.every(call => call.site === FAIMSTUDIO)).toBe(true)
})

test('a ticket of a project this account cannot reach does not become the session ticket', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  fakeJira(on, { granted: [FAIMSTUDIO] })
  const ui = capture(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await start($)

  await $.prompt.submit({ text: 'Doe het zoals in BDY-750' } as never)
  await ui.settle()
  await $.prompt.submit({ text: 'Pak FAIM-601 op' } as never)
  await ui.settle()

  expect(ui.last()).toBe('FAIM-175 ▰▰▰▰▰▱▱▱▱▱ 50% · nog 1 open ≈ 1 sessie')
})

test('a title search that finds nothing names the projects it could not search', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  fakeJira(on, { granted: [FAIMSTUDIO] })
  const ui = capture(on)
  await start($)

  const { text } = await $.command.run({ command: 'epic', args: 'security' })
  await ui.settle()

  expect(text).toContain('Niet doorzocht: BDY')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect(await pane.find({ text: /Niet doorzocht: BDY \(niet bereikbaar met dit Claude-account\)/ })).toBeDefined()
  await pane.unmount()
})

test('with the fixed connections loaded, each project is read through the connection of its site', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  const jira = fakeJira(on, { fixed: [BUDDY, FAIM] })
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: 'BDY-1407' })
  await ui.settle()
  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▱▱▱▱▱▱ 40% · nog 3 open ≈ 3 sessies')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect(await pane.find({ text: /1 wacht op veldtest/ })).toBeDefined()
  await pane.unmount()

  await $.command.run({ command: 'epic', args: 'FAIM-601' })
  await ui.settle()
  expect(ui.last()).toBe('FAIM-175 ▰▰▰▰▰▱▱▱▱▱ 50% · nog 1 open ≈ 1 sessie')

  expect(jira.calls.some(call => call.server === SERVER)).toBe(false)
  expect(jira.calls.filter(call => call.site === QUINVENTA).every(call => call.server === BUDDY)).toBe(true)
  expect(jira.calls.filter(call => call.site === FAIMSTUDIO).every(call => call.server === FAIM)).toBe(true)
})

test('a site without its fixed connection is still read through the claude.ai connector', { options: { projects: 'BDY,FAIM' } }, async ($, on) => {
  const jira = fakeJira(on, { fixed: [FAIM] })
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: 'BDY-1407' })
  await ui.settle()

  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▱▱▱▱▱▱ 40% · nog 3 open ≈ 3 sessies')
  expect(jira.calls.filter(call => call.site === QUINVENTA).every(call => call.server === SERVER)).toBe(true)
})

test('a fixed connection auto mode refused shows its own allow rule', async ($, on) => {
  fakeJira(on, { fixed: [BUDDY, FAIM], refused: [BUDDY] })
  const ui = capture(on)
  await start($)

  await $.command.run({ command: 'epic', args: 'BDY-750' })
  await ui.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect((await pane.find({ type: 'Code' }))?.props.source).toBe('mcp__buddy-atlassian__searchJiraIssuesUsingJql')
  await pane.unmount()
})

test('a fixed connection that fails is reported, not passed on to the claude.ai connector', async ($, on) => {
  const jira = fakeJira(on, { fixed: [BUDDY, FAIM], broken: [BUDDY] })
  const ui = capture(on)
  await start($)

  const { text } = await $.command.run({ command: 'epic', args: 'BDY-750' })
  await ui.settle()

  expect(text).toContain('Jira-fout')
  expect(text).toContain('401')
  expect(text).not.toContain('Claude-account')
  expect(jira.calls.some(call => call.server === SERVER)).toBe(false)
})

test('a comment through the v2 tool refreshes the progress', async ($, on) => {
  const jira = fakeJira(on, { fixed: [BUDDY, FAIM] })
  const ui = capture(on)
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as never)
  await start($)
  await $.command.run({ command: 'epic', args: 'BDY-1407' })
  await ui.settle()

  jira.setStatus('BDY-1408', 'Done', 'done')
  await $.tool.call({ tool: `mcp__${BUDDY}__addOrEditJiraIssueComment`, issueIdOrKey: 'BDY-1408', commentBody: 'klaar' } as never)
  await ui.settle()

  expect(ui.last()).toBe('BDY-750 ▰▰▰▰▰▰▱▱▱▱ 60% · nog 2 open ≈ 2 sessies')
})
